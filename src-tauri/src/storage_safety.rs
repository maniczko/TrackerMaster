//! Data safety helpers for the native Tauri application.
//! The Node.js reference preview is intentionally not imported into production.

use rusqlite::{params, Connection, Error, OpenFlags, Result};
use rusqlite::backup::{Backup, StepResult};
use serde::Serialize;
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

/// The index name and UNIQUE/PARTIAL flags alone are insufficient:
/// an index on task_id would allow multiple simultaneous active tasks.
pub fn validate_timer_index(db: &Connection) -> Result<()> {
    let (unique, partial, sql): (i64, i64, String) = db.query_row(
        "SELECT il.\"unique\", il.partial, sm.sql
         FROM pragma_index_list('time_entries') AS il
         JOIN sqlite_master AS sm ON sm.name=il.name AND sm.type='index'
         WHERE il.name='one_running_timer'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if unique != 1 || partial != 1 {
        return Err(invalid());
    }
    // The native schema intentionally indexes a constant 1 for *all*
    // unfinished entries; validate this actual definition rather than its name.
    let normalized: String = sql.chars()
        .filter(|c| !c.is_ascii_whitespace() && !matches!(*c, '"' | '`' | '[' | ']'))
        .flat_map(|c| c.to_lowercase())
        .collect();
    if !normalized.trim_end_matches(';')
        .ends_with("ontime_entries((1))whereended_atisnull")
    {
        return Err(invalid());
    }
    Ok(())
}

fn validate_database(db: &Connection) -> Result<()> {
    let integrity: String =
        db.pragma_query_value(None, "integrity_check", |row| row.get(0))?;
    if integrity != "ok" {
        return Err(invalid());
    }
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !(0..=7).contains(&version) {
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
        crate::validate_schema(db)?;
        validate_timer_index(db)?;
    }
    if version >= 4 { crate::validate_revisions_schema(db)?; }
    if version >= 5 { crate::validate_deletions_schema(db)?; }
    if version >= 6 { crate::validate_settings_schema(db)?; }
    if version >= 7 { crate::validate_client_archives_schema(db)?; }
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

/// Read-only health indicators. Never return client names, time-entry
/// descriptions, paths, tokens or other business content to diagnostics.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DatabaseHealth {
    pub schema_version: i64,
    pub clients: i64,
    pub projects: i64,
    pub tasks: i64,
    pub completed_entries: i64,
    pub open_entries: i64,
}

/// Validate the full database and then return only aggregate counts.
/// Any integrity or relationship violation fails closed.
pub fn diagnose_database(db: &Connection) -> Result<DatabaseHealth> {
    validate_database(db)?;
    let count = |query: &str| -> Result<i64> {
        db.query_row(query, [], |row| row.get(0))
    };
    Ok(DatabaseHealth {
        schema_version: db.pragma_query_value(None, "user_version", |row| row.get(0))?,
        clients: count("SELECT COUNT(*) FROM clients")?,
        projects: count("SELECT COUNT(*) FROM projects")?,
        tasks: count("SELECT COUNT(*) FROM tasks")?,
        completed_entries: if db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? >= 5 {
            count("SELECT COUNT(*) FROM time_entries WHERE ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id)")?
        } else { count("SELECT COUNT(*) FROM time_entries WHERE ended_at IS NOT NULL")? },
        open_entries: count("SELECT COUNT(*) FROM time_entries WHERE ended_at IS NULL")?,
    })
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

/// A frozen, validated copy of the selected file. The live database is not
/// touched while the user inspects the prospective restore.
pub struct PreparedRestore {
    staged: Connection,
    pub health: DatabaseHealth,
}

fn copy_database(source: &Connection, destination: &mut Connection) -> Result<()> {
    let backup = Backup::new(source, destination)?;
    // A single SQLite backup step holds a consistent read snapshot. If it
    // cannot finish, dropping the handle rolls back the destination write.
    if !matches!(backup.step(-1)?, StepResult::Done) { return Err(invalid()); }
    Ok(())
}

pub fn prepare_restore(path: &Path) -> Result<PreparedRestore> {
    if !path.is_file() { return Err(Error::InvalidPath(path.to_path_buf())); }
    let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut staged = Connection::open_in_memory()?;
    copy_database(&source, &mut staged)?;
    validate_database(&staged)?;
    // Migrate only the isolated copy, never the selected source file.
    crate::initialise(&mut staged)?;
    let health = diagnose_database(&staged)?;
    Ok(PreparedRestore { staged, health })
}

/// The caller must hold the tracker lock and obtain explicit confirmation.
/// SQLite rolls back an incomplete backup into the destination. A verified
/// safety copy of the current data is created before replacement begins.
pub fn restore_prepared(db: &mut Connection, prepared: &PreparedRestore, app_data_dir: &Path) -> Result<PathBuf> {
    validate_database(db)?;
    validate_database(&prepared.staged)?;
    let running = db.query_row("SELECT EXISTS(SELECT 1 FROM time_entries WHERE ended_at IS NULL)", [], |row| row.get::<_, bool>(0))?;
    if running { return Err(invalid()); }
    let safety_copy = create_backup(db, app_data_dir)?;
    copy_database(&prepared.staged, db)?;
    Ok(safety_copy)
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
    fn backup_preserves_revisions_and_deletion_markers_in_current_schema() {
        let path = test_path("backup-history-v5");
        let _cleanup = Cleanup(path.clone());
        let dir = path.with_extension("dir");
        let mut db = Connection::open(&path).unwrap();
        crate::initialise(&mut db).unwrap();
        db.pragma_update(None, "journal_mode", "WAL").unwrap();
        db.execute_batch("
            INSERT INTO clients(id,name) VALUES(1,'Client');
            INSERT INTO projects(id,client_id,name) VALUES(1,1,'Project');
            INSERT INTO tasks(id,project_id,name) VALUES(1,1,'Task');
            INSERT INTO time_entries(id,task_id,started_at,ended_at,duration_seconds) VALUES(1,1,'2026-01-01T09:00:00Z','2026-01-01T10:00:00Z',3600);
            INSERT INTO entry_revisions(entry_id,changed_at,before_start,before_end,before_seconds,after_start,after_end,after_seconds) VALUES(1,'2026-01-02T00:00:00Z','2026-01-01T08:00:00Z','2026-01-01T09:00:00Z',3600,'2026-01-01T09:00:00Z','2026-01-01T10:00:00Z',3600);
            INSERT INTO entry_deletions(entry_id,deleted_at) VALUES(1,'2026-01-03T00:00:00Z');
            INSERT INTO time_entries(id,task_id,started_at) VALUES(2,1,'2026-01-04T10:00:00Z');
        ").unwrap();
        let health = diagnose_database(&db).unwrap();
        assert_eq!((health.schema_version, health.completed_entries, health.open_entries), (7, 0, 1));
        let backup = create_backup(&db, &dir).unwrap();
        let copy = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(copy.query_row("SELECT COUNT(*) FROM entry_revisions", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        assert_eq!(copy.query_row("SELECT COUNT(*) FROM entry_deletions", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        assert_eq!(copy.query_row("SELECT COUNT(*) FROM time_entries", [], |r| r.get::<_,i64>(0)).unwrap(), 2);
        assert_eq!(diagnose_database(&copy).unwrap().completed_entries, 0);
    }

    #[test]
    fn backup_rejects_missing_current_deletion_history() {
        let path = test_path("missing-deletions-v5");
        let _cleanup = Cleanup(path.clone());
        let dir = path.with_extension("dir");
        let mut db = Connection::open(&path).unwrap();
        crate::initialise(&mut db).unwrap();
        db.execute_batch("DROP TABLE entry_deletions;").unwrap();
        assert!(create_backup(&db, &dir).is_err());
        assert!(!dir.join("backups").exists());
    }

    #[test]
    fn restore_uses_frozen_validated_copy_and_saves_previous_data() {
        let source_path = test_path("restore-source");
        let dest_path = test_path("restore-destination");
        let _source_cleanup = Cleanup(source_path.clone());
        let _dest_cleanup = Cleanup(dest_path.clone());
        let dir = dest_path.with_extension("dir");
        let mut source = Connection::open(&source_path).unwrap();
        crate::initialise(&mut source).unwrap();
        crate::update_report_timezone(&source, "Europe/Warsaw", "Europe/London").unwrap();
        source.execute_batch("INSERT INTO clients VALUES(1,'Backup client'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'P'); INSERT INTO tasks VALUES(1,1,'T'); INSERT INTO time_entries(id,task_id,started_at,ended_at,duration_seconds) VALUES(1,1,'2026-01-01T09:00:00Z','2026-01-01T10:00:00Z',3600); INSERT INTO entry_revisions(entry_id,changed_at,before_start,before_end,before_seconds,after_start,after_end,after_seconds) VALUES(1,'2026-01-02T00:00:00Z','2026-01-01T08:00:00Z','2026-01-01T09:00:00Z',3600,'2026-01-01T09:00:00Z','2026-01-01T10:00:00Z',3600); INSERT INTO entry_deletions VALUES(1,'2026-01-03T00:00:00Z'); INSERT INTO time_entries(id,task_id,started_at) VALUES(2,1,'2026-01-04T10:00:00Z');").unwrap();
        let prepared = prepare_restore(&source_path).unwrap();
        assert_eq!((prepared.health.clients, prepared.health.completed_entries, prepared.health.open_entries), (1, 0, 1));
        source.execute("UPDATE clients SET name='Changed after preview' WHERE id=1", []).unwrap();
        let mut dest = Connection::open(&dest_path).unwrap();
        crate::initialise(&mut dest).unwrap();
        dest.pragma_update(None, "journal_mode", "WAL").unwrap();
        dest.execute("INSERT INTO clients VALUES(1,'Current client')", []).unwrap();
        let safety = restore_prepared(&mut dest, &prepared, &dir).unwrap();
        assert_eq!(dest.query_row("SELECT name FROM clients WHERE id=1", [], |r| r.get::<_,String>(0)).unwrap(), "Backup client");
        assert_eq!(dest.query_row("SELECT report_timezone FROM app_settings WHERE id=1", [], |r| r.get::<_,String>(0)).unwrap(), "Europe/London");
        assert_eq!(dest.query_row("SELECT COUNT(*) FROM entry_revisions", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        assert_eq!(dest.query_row("SELECT COUNT(*) FROM entry_deletions", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        assert_eq!(dest.query_row("SELECT COUNT(*) FROM time_entries WHERE ended_at IS NULL", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        let previous = Connection::open_with_flags(&safety, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(previous.query_row("SELECT name FROM clients WHERE id=1", [], |r| r.get::<_,String>(0)).unwrap(), "Current client");
        preflight_existing(&safety).unwrap();
        let tracker = crate::Tracker { db: dest, running_since: None, restored: false };
        let restored = crate::snapshot(&tracker).unwrap();
        assert!(restored.active.unwrap().recovered);
        assert!(restored.entries.is_empty());
    }

    #[test]
    fn restore_rejects_corrupt_or_newer_files_and_active_destination() {
        let source_path = test_path("restore-valid");
        let dest_path = test_path("restore-active");
        let invalid_path = test_path("restore-invalid");
        let _source_cleanup = Cleanup(source_path.clone());
        let _dest_cleanup = Cleanup(dest_path.clone());
        let _invalid_cleanup = Cleanup(invalid_path.clone());
        let dir = dest_path.with_extension("dir");
        std::fs::write(&invalid_path, b"not a database").unwrap();
        assert!(prepare_restore(&invalid_path).is_err());
        let mut source = Connection::open(&source_path).unwrap();
        crate::initialise(&mut source).unwrap();
        source.pragma_update(None, "user_version", 8).unwrap();
        assert!(prepare_restore(&source_path).is_err());
        source.pragma_update(None, "user_version", 7).unwrap();
        let prepared = prepare_restore(&source_path).unwrap();
        let mut dest = Connection::open(&dest_path).unwrap();
        crate::initialise(&mut dest).unwrap();
        dest.execute_batch("INSERT INTO clients VALUES(1,'A'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'P'); INSERT INTO tasks VALUES(1,1,'T'); INSERT INTO time_entries(task_id,started_at) VALUES(1,'2026-01-01T10:00:00Z');").unwrap();
        assert!(restore_prepared(&mut dest, &prepared, &dir).is_err());
        assert_eq!(dest.query_row("SELECT COUNT(*) FROM time_entries WHERE ended_at IS NULL", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        assert!(!dir.join("backups").exists());
    }

    #[test]
    fn prepare_restore_migrates_legacy_copy_without_changing_source() {
        let path = test_path("restore-legacy");
        let _cleanup = Cleanup(path.clone());
        let mut source = Connection::open(&path).unwrap();
        crate::initialise(&mut source).unwrap();
        source.execute_batch("INSERT INTO clients VALUES(1,'Legacy'); DROP TABLE client_archives; DROP TABLE app_settings; DROP TABLE entry_deletions; DROP TABLE entry_revisions; PRAGMA user_version=3;").unwrap();
        let prepared = prepare_restore(&path).unwrap();
        assert_eq!((prepared.health.schema_version, prepared.health.clients), (7, 1));
        assert_eq!(source.pragma_query_value(None, "user_version", |r| r.get::<_,i64>(0)).unwrap(), 3);
        assert!(!source.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='entry_revisions')", [], |r| r.get::<_,bool>(0)).unwrap());
    }

    #[test]
    fn interrupted_sqlite_copy_rolls_back_destination() {
        let source = Connection::open_in_memory().unwrap();
        source.execute_batch("CREATE TABLE replacement(payload BLOB); INSERT INTO replacement VALUES(zeroblob(262144));").unwrap();
        let mut destination = Connection::open_in_memory().unwrap();
        destination.execute_batch("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('kept');").unwrap();
        {
            let backup = Backup::new(&source, &mut destination).unwrap();
            assert!(matches!(backup.step(1).unwrap(), StepResult::More));
            // Dropping an unfinished operation must not publish partial pages.
        }
        assert_eq!(destination.query_row("SELECT value FROM original", [], |r| r.get::<_,String>(0)).unwrap(), "kept");
        assert!(!destination.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='replacement')", [], |r| r.get::<_,bool>(0)).unwrap());
    }

    #[test]
    fn existing_current_schema_with_wrong_unique_index_is_rejected() {
        let path = test_path("wrong-index");
        let _cleanup = Cleanup(path.clone());
        let mut db = Connection::open(&path).unwrap();
        crate::initialise(&mut db).unwrap();
        db.execute_batch("
            DROP INDEX one_running_timer;
            CREATE UNIQUE INDEX one_running_timer ON time_entries(task_id)
              WHERE ended_at IS NULL;
        ").unwrap();
        drop(db);
        // A unique index on task_id is not a single-running-timer constraint.
        assert!(preflight_existing(&path).is_err());
    }

    #[test]
    fn existing_current_schema_with_orphaned_foreign_key_is_rejected() {
        let path = test_path("bad-fk");
        let _cleanup = Cleanup(path.clone());
        let mut db = Connection::open(&path).unwrap();
        crate::initialise(&mut db).unwrap();
        db.pragma_update(None, "foreign_keys", false).unwrap();
        db.execute_batch("INSERT INTO projects(id,client_id,name) VALUES(99,999,'Orphan');").unwrap();
        drop(db);
        assert!(preflight_existing(&path).is_err());
    }

    #[test]
    fn diagnostics_return_only_aggregates_and_do_not_modify_entries() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::initialise(&mut db).unwrap();
        db.execute_batch("
          INSERT INTO clients(id,name) VALUES(1,'CONFIDENTIAL CUSTOMER');
          INSERT INTO projects(id,client_id,name) VALUES(1,1,'CONFIDENTIAL PROJECT');
          INSERT INTO tasks(id,project_id,name) VALUES(1,1,'CONFIDENTIAL TASK');
          INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds)
             VALUES(1,'2026-11-16T09:00:00Z','2026-11-16T09:01:00Z',60);
          INSERT INTO time_entries(task_id,started_at)
             VALUES(1,'2026-11-16T09:02:00Z');
        ").unwrap();
        let result = diagnose_database(&db).unwrap();
        assert_eq!(result, DatabaseHealth {
            schema_version: 7, clients: 1, projects: 1, tasks: 1,
            completed_entries: 1, open_entries: 1,
        });
        // No business strings in the exposed diagnostics model.
        assert!(!format!("{result:?}").contains("CONFIDENTIAL"));
        assert_eq!(db.query_row(
            "SELECT COUNT(*) FROM time_entries", [], |row| row.get::<_, i64>(0)
        ).unwrap(), 2);
        assert_eq!(db.query_row(
            "SELECT name FROM clients WHERE id=1", [], |row| row.get::<_, String>(0)
        ).unwrap(), "CONFIDENTIAL CUSTOMER");
    }

    #[test]
    fn diagnostics_fail_closed_for_broken_foreign_keys() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::initialise(&mut db).unwrap();
        db.pragma_update(None, "foreign_keys", false).unwrap();
        db.execute_batch("INSERT INTO projects(id,client_id,name) VALUES(77,999,'Orphan');").unwrap();
        assert!(diagnose_database(&db).is_err());
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

