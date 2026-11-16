//! Data safety helpers for the native Tauri application.
//! The Node.js reference preview is intentionally not imported into production.

use rusqlite::{params, Connection, Error, OpenFlags, Result};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn invalid() -> Error {
    Error::InvalidQuery
}

/// Reject an existing damaged or incomplete database *before* initialise()
/// can create missing tables during a legacy migration. A missing path is
/// permitted only for first installation.
pub fn preflight_existing(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if std::fs::metadata(path).map_err(|_| Error::InvalidPath(path.to_path_buf()))?.len() == 0 {
        return Err(invalid());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    validate_database(&db)
}

fn validate_database(db: &Connection) -> Result<()> {
    let integrity: String =
        db.pragma_query_value(None, "integrity_check", |row| row.get(0))?;
    if integrity != "ok" {
        return Err(invalid());
    }
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !(0..=3).contains(&version) {
        return Err(invalid());
    }

    // These four tables and their core columns existed even in the
    // unversioned prototype, so an existing file missing one is not new.
    for query in [
        "SELECT id, name FROM clients LIMIT 0",
        "SELECT id, client_id, name FROM projects LIMIT 0",
        "SELECT id, project_id, name FROM tasks LIMIT 0",
        "SELECT id, task_id, started_at, ended_at, duration_seconds FROM time_entries LIMIT 0",
    ] {
        db.prepare(query)?;
    }
    if version >= 2 {
        db.prepare("SELECT manually_resolved FROM time_entries LIMIT 0")?;
    }
    if version >= 3 {
        db.prepare("SELECT archived FROM projects LIMIT 0")?;
        let index_ok: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_index_list('time_entries') WHERE name='one_running_timer' AND \"unique\"=1 AND partial=1)",
            [],
            |row| row.get(0),
        )?;
        if !index_ok {
            return Err(invalid());
        }
    }
    // A PRAGMA integrity_check does not detect broken relationships, and
    // stored data may have been written with foreign_keys disabled.
    for (table, from, target, to) in [
        ("projects", "client_id", "clients", "id"),
        ("tasks", "project_id", "projects", "id"),
        ("time_entries", "task_id", "tasks", "id"),
    ] {
        let found: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list(?1) WHERE \"from\"=?2 AND \"table\"=?3 AND \"to\"=?4)",
            params![table, from, target, to],
            |row| row.get(0),
        )?;
        if !found {
            return Err(invalid());
        }
    }
    if db.prepare("PRAGMA foreign_key_check")?.query([])?.next()?.is_some() {
        return Err(invalid());
    }
    Ok(())
}

/// Consistent SQLite snapshot, including changes in WAL, without copying
/// an open database file. Only produces a backup in the user's app data
/// folder; restoring is deliberately not exposed until its safety contract
/// has been accepted and tested on Windows.
pub fn create_backup(db: &Connection, app_data_dir: &Path) -> Result<PathBuf> {
    validate_database(db)?;
    let backup_dir = app_data_dir.join("backups");
    std::fs::create_dir_all(&backup_dir)
        .map_err(|_| Error::InvalidPath(backup_dir.clone()))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid())?
        .as_nanos();
    let filename = format!("tracker-{}-{stamp}.sqlite3", std::process::id());
    let destination = backup_dir.join(filename);
    let partial = destination.with_extension("sqlite3.partial");
    if destination.exists() || partial.exists() {
        return Err(invalid());
    }

    // VACUUM INTO creates a consistent snapshot outside the current
    // transaction. Publish only after validating the resulting file.
    let result = (|| -> Result<()> {
        let temp_path = partial.to_string_lossy().into_owned();
        db.execute("VACUUM INTO ?1", [temp_path.as_str()])?;
        preflight_existing(&partial)?;
        std::fs::rename(&partial, &destination)
            .map_err(|_| Error::InvalidPath(destination.clone()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result?;
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("tm-native-{label}-{}-{stamp}.sqlite3", std::process::id()))
    }
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let _ = std::fs::remove_dir_all(self.0.with_extension("dir"));
        }
    }

    #[test]
    fn new_path_allowed_and_existing_empty_file_rejected() {
        let path = test_path("empty");
        let _cleanup = Cleanup(path.clone());
        assert!(preflight_existing(&path).is_ok());
        std::fs::File::create(&path).unwrap();
        assert!(preflight_existing(&path).is_err());
    }

    #[test]
    fn incomplete_existing_database_is_not_silently_repaired() {
        let path = test_path("partial");
        let _cleanup = Cleanup(path.clone());
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL); PRAGMA user_version=0;").unwrap();
        drop(db);
        assert!(preflight_existing(&path).is_err());
        let db = Connection::open(&path).unwrap();
        let tables: i64 = db.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projects'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(tables, 0);
    }

    #[test]
    fn corrupted_database_rejected_without_changes() {
        let path = test_path("corrupt");
        let _cleanup = Cleanup(path.clone());
        let bytes = b"invalid sqlite database";
        std::fs::write(&path, bytes).unwrap();
        assert!(preflight_existing(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn existing_legacy_database_passes_preflight_and_migrates() {
        let path = test_path("legacy");
        let _cleanup = Cleanup(path.clone());
        let mut db = Connection::open(&path).unwrap();
        db.execute_batch("
            CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE projects (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL);
            CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL);
            CREATE TABLE time_entries (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER);
            INSERT INTO clients VALUES (1,'A');
            INSERT INTO projects VALUES (1,1,'P');
            INSERT INTO tasks VALUES (1,1,'T');
        ").unwrap();
        drop(db);
        preflight_existing(&path).unwrap();
        let mut db = Connection::open(&path).unwrap();
        crate::initialise(&mut db).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn backup_is_consistent_and_preserves_active_and_completed_entries() {
        let path = test_path("backup");
        let _cleanup = Cleanup(path.clone());
        let dir = path.with_extension("dir");
        let mut db = Connection::open(&path).unwrap();
        crate::initialise(&mut db).unwrap();
        db.pragma_update(None, "journal_mode", "WAL").unwrap();
        db.execute_batch("
            INSERT INTO clients(id,name) VALUES(1,'Client');
            INSERT INTO projects(id,client_id,name) VALUES(1,1,'Project');
            INSERT INTO tasks(id,project_id,name) VALUES(1,1,'Task');
            INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds)
              VALUES(1,'2026-11-16T09:00:00Z','2026-11-16T10:00:00Z',3600);
            INSERT INTO time_entries(task_id,started_at)
              VALUES(1,'2026-11-16T10:01:00Z');
        ").unwrap();
        let backup = create_backup(&db, &dir).unwrap();
        assert!(backup.starts_with(dir.join("backups")));
        preflight_existing(&backup).unwrap();
        let copied = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let entries: i64 = copied.query_row("SELECT COUNT(*) FROM time_entries", [], |row| row.get(0)).unwrap();
        let running: i64 = copied.query_row("SELECT COUNT(*) FROM time_entries WHERE ended_at IS NULL", [], |row| row.get(0)).unwrap();
        assert_eq!((entries, running), (2, 1));
        assert_eq!(copied.query_row("SELECT SUM(duration_seconds) FROM time_entries", [], |row| row.get::<_, i64>(0)).unwrap(), 3600);
    }

    #[test]
    fn backup_refuses_invalid_source_without_publishing_file() {
        let path = test_path("invalid-source");
        let _cleanup = Cleanup(path.clone());
        let dir = path.with_extension("dir");
        let db = Connection::open(&path).unwrap();
        assert!(create_backup(&db, &dir).is_err());
        assert!(!dir.join("backups").exists());
    }
}
