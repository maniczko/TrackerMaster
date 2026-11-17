//! Schema migration for project-level entries without a task.
//!
//! The caller must create and verify a backup before calling this for an
//! existing database. The transaction preserves entry IDs and all references.
use rusqlite::{Connection, Error, Result, TransactionBehavior};

pub fn migrate(db: &mut Connection) -> Result<()> {
    let enabled: i64 = db.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
    if enabled != 1 { return Err(Error::InvalidQuery); }
    // SQLite cannot rebuild a referenced parent table with foreign keys enabled,
    // even with deferred constraints. Validate all references before commit and
    // restore enforcement on both success and failure.
    db.pragma_update(None, "foreign_keys", false)?;
    let result = migrate_transaction(db);
    let restore = db.pragma_update(None, "foreign_keys", true);
    match (result, restore) {
        (Err(err), _) | (Ok(()), Err(err)) => Err(err),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn migrate_transaction(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version != 10 { return Err(Error::InvalidQuery); }
    // Unknown indexes or triggers could contain user data or invariants. Do not
    // silently discard them while rebuilding the table.
    let unexpected: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE tbl_name='time_entries' AND ((type='index' AND name!='one_running_timer') OR type='trigger'))", [], |r| r.get(0))?;
    if unexpected || tx.prepare("PRAGMA foreign_key_check")?.query([])?.next()?.is_some() { return Err(Error::InvalidQuery); }
    tx.execute_batch("CREATE UNIQUE INDEX tasks_id_project_identity ON tasks(id,project_id);
        CREATE TABLE time_entries_v11 (
          id INTEGER PRIMARY KEY,
          task_id INTEGER REFERENCES tasks(id),
          project_id INTEGER NOT NULL REFERENCES projects(id),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_seconds INTEGER CHECK(duration_seconds >= 0),
          manually_resolved INTEGER NOT NULL DEFAULT 0 CHECK(manually_resolved IN (0,1)),
          CHECK ((ended_at IS NULL AND duration_seconds IS NULL) OR (ended_at IS NOT NULL AND duration_seconds IS NOT NULL)),
          FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id)
        );
        INSERT INTO time_entries_v11(id,task_id,project_id,started_at,ended_at,duration_seconds,manually_resolved)
          SELECT e.id,e.task_id,t.project_id,e.started_at,e.ended_at,e.duration_seconds,e.manually_resolved
          FROM time_entries e JOIN tasks t ON t.id=e.task_id;")?;
    let counts_match: bool = tx.query_row("SELECT (SELECT COUNT(*) FROM time_entries)=(SELECT COUNT(*) FROM time_entries_v11)", [], |r| r.get(0))?;
    if !counts_match { return Err(Error::InvalidQuery); }
    tx.execute_batch("DROP TABLE time_entries;
        ALTER TABLE time_entries_v11 RENAME TO time_entries;
        CREATE UNIQUE INDEX one_running_timer ON time_entries((1)) WHERE ended_at IS NULL;")?;
    if tx.prepare("PRAGMA foreign_key_check")?.query([])?.next()?.is_some() { return Err(Error::InvalidQuery); }
    crate::storage_safety::validate_timer_index(&tx)?;
    tx.pragma_update(None, "user_version", 11)?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;
          CREATE TABLE projects(id INTEGER PRIMARY KEY);
          CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id));
          CREATE TABLE time_entries(id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL REFERENCES tasks(id),started_at TEXT NOT NULL,ended_at TEXT,duration_seconds INTEGER,manually_resolved INTEGER NOT NULL DEFAULT 0);
          CREATE UNIQUE INDEX one_running_timer ON time_entries((1)) WHERE ended_at IS NULL;
          CREATE TABLE descriptions(entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id),description TEXT NOT NULL);
          INSERT INTO projects VALUES(1),(2); INSERT INTO tasks VALUES(1,1);
          INSERT INTO time_entries VALUES(41,1,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600,1);
          INSERT INTO time_entries VALUES(42,1,'2026-01-02T10:00:00Z',NULL,NULL,0);
          INSERT INTO descriptions VALUES(41,'Opis'); PRAGMA user_version=10;").unwrap();
        db
    }

    #[test]
    fn preserves_ids_history_references_and_enforces_project_consistency() {
        let mut db = example();
        migrate(&mut db).unwrap();
        assert_eq!(db.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(), 11);
        assert_eq!(db.pragma_query_value(None,"foreign_keys",|r|r.get::<_,i64>(0)).unwrap(), 1);
        assert_eq!(db.query_row("SELECT description FROM descriptions WHERE entry_id=41",[],|r|r.get::<_,String>(0)).unwrap(), "Opis");
        assert_eq!(db.query_row("SELECT project_id FROM time_entries WHERE id=42",[],|r|r.get::<_,i64>(0)).unwrap(), 1);
        db.execute("UPDATE time_entries SET ended_at='2026-01-02T11:00:00Z',duration_seconds=3600 WHERE id=42", []).unwrap();
        db.execute("INSERT INTO time_entries(task_id,project_id,started_at) VALUES(NULL,1,'2026-01-03T10:00:00Z')", []).unwrap();
        assert!(db.execute("INSERT INTO time_entries(task_id,project_id,started_at,ended_at,duration_seconds) VALUES(1,2,'2026-01-03T11:00:00Z','2026-01-03T12:00:00Z',3600)", []).is_err());
        assert!(db.execute("INSERT INTO time_entries(task_id,project_id,started_at) VALUES(NULL,2,'2026-01-03T11:00:00Z')", []).is_err());
    }

    #[test]
    fn refuses_unknown_triggers_without_changing_original_database() {
        let mut db = example();
        db.execute_batch("CREATE TRIGGER custom_trigger AFTER UPDATE ON time_entries BEGIN SELECT 1; END;").unwrap();
        assert!(migrate(&mut db).is_err());
        assert_eq!(db.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(), 10);
        assert_eq!(db.pragma_query_value(None,"foreign_keys",|r|r.get::<_,i64>(0)).unwrap(), 1);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM time_entries",[],|r|r.get::<_,i64>(0)).unwrap(), 2);
        assert_eq!(db.query_row("SELECT description FROM descriptions WHERE entry_id=41",[],|r|r.get::<_,String>(0)).unwrap(), "Opis");
    }
}
