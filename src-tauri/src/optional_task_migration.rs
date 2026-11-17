//! Schema migration for project-level entries without a task.
//!
//! The caller must create and verify a backup before calling this for an
//! existing database. The transaction preserves entry IDs and all references.
use rusqlite::{params, Connection, Error, OptionalExtension, Result, TransactionBehavior};
use chrono::{DateTime, Utc};
use std::time::Instant;

pub enum TimerAction<'a> {
    Stop,
    Start { project_id: i64, task_id: Option<i64>, description: &'a str },
    Resume { entry_id: i64 },
}

/// Change the single running timer, including taskless project timers, in one
/// transaction. A stale UI, archived target, overlapping time or failed write
/// leaves the prior persisted timer intact.
pub fn transition(tracker: &mut crate::Tracker, expected: Option<i64>, at: &str, action: TimerAction<'_>) -> std::result::Result<(), String> {
    crate::ensure_available(tracker)?;
    let elapsed = tracker.running_since.as_ref().map(|clock| clock.since.elapsed().as_secs() as i64);
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(crate::db_err)?;
    let active: Option<(i64, i64, Option<i64>, String)> = tx.query_row("SELECT id,project_id,task_id,started_at FROM time_entries WHERE ended_at IS NULL", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(crate::db_err)?;
    if active.as_ref().map(|a| a.0) != expected { return Err("Pomiar zmienił się w innym oknie. Odśwież dane i spróbuj ponownie.".into()); }
    let resume = matches!(action, TimerAction::Resume { .. });
    let target: Option<(i64, Option<i64>, String, Option<bool>)> = match action {
        TimerAction::Stop => None,
        TimerAction::Start { project_id, task_id, description } => Some((project_id,task_id,description.to_string(),None)),
        TimerAction::Resume { entry_id } => Some(tx.query_row("SELECT project_id,task_id,COALESCE((SELECT description FROM entry_descriptions d WHERE d.entry_id=e.id),''),EXISTS(SELECT 1 FROM billable_entries b WHERE b.entry_id=e.id) FROM time_entries e WHERE e.id=?1 AND e.ended_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM entry_deletions d WHERE d.entry_id=e.id)", [entry_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,Some(r.get(3)?)))).optional().map_err(crate::db_err)?.ok_or("Wpis do wznowienia nie istnieje lub został usunięty.")?),
    };
    if let Some((project_id,task_id,description,_)) = &target { crate::valid_description(description)?; target_billing(&tx,*project_id,*task_id)?; }
    if let Some((id, active_project, active_task, started)) = active {
        let seconds = elapsed.ok_or("Pomiar wymaga ręcznego ustalenia czasu zakończenia.")?;
        let uncertain = match crate::power_sample() { Ok(end_power) => crate::sleep_or_invalid(tracker.running_since.as_ref().unwrap().power,end_power), Err(_) => true };
        if uncertain { drop(tx); tracker.running_since=None; return Err("Wykryto przerwę w pracy systemu lub błąd zegara. Pomiar wymaga weryfikacji; nie został zakończony.".into()); }
        if !resume && target.as_ref().is_some_and(|t| t.0==active_project && t.1==active_task) { return Ok(()); }
        let start = DateTime::parse_from_rfc3339(&started).map_err(|_| "Niepoprawny zapis czasu w bazie.")?;
        let end = DateTime::parse_from_rfc3339(at).map_err(|_| "Niepoprawny czas systemowy.")?;
        let wall = end.signed_duration_since(start).num_seconds();
        if wall < 0 || (wall-seconds).abs()>2 { drop(tx); tracker.running_since=None; return Err("Wykryto zmianę zegara lub przerwę w pracy systemu. Pomiar wymaga weryfikacji; nie został zakończony.".into()); }
        if end>start {
            if let Err(error)=crate::ensure_no_overlap(&tx,start.with_timezone(&Utc),end.with_timezone(&Utc),Some(id)) { drop(tx); tracker.running_since=None; return Err(format!("{error} Pomiar wymaga weryfikacji; nie został zakończony.")); }
        }
        tx.execute("UPDATE time_entries SET ended_at=?1,duration_seconds=?2 WHERE id=?3 AND ended_at IS NULL",params![at,seconds,id]).map_err(crate::db_err)?;
    } else if target.is_none() { return Err("Nie ma aktywnego pomiaru.".into()); }
    if let Some((project_id,task_id,description,billable)) = &target {
        let start=DateTime::parse_from_rfc3339(at).map_err(|_| "Niepoprawny czas systemowy.")?.with_timezone(&Utc);
        crate::ensure_no_overlap(&tx,start,DateTime::<Utc>::MAX_UTC,None).map_err(|_| "Nie można rozpocząć pomiaru: inny wpis trwa teraz lub znajduje się w przyszłości. Sprawdź zegar i historię.".to_string())?;
        insert_running(&tx,*project_id,*task_id,at,description,*billable)?;
    }
    let next_clock = if target.is_some() { Some(crate::RunningClock { since: Instant::now(), power: crate::power_sample()? }) } else { None };
    tx.commit().map_err(crate::db_err)?;
    tracker.running_since = next_clock;
    Ok(())
}

/// Validate the user's explicit project and optional task inside the same write
/// transaction as a timer start. Return the project's current billing default.
pub fn target_billing(db: &Connection, project_id: i64, task_id: Option<i64>) -> std::result::Result<bool, String> {
    let project: Option<(bool, bool, bool)> = db.query_row("SELECT p.archived,EXISTS(SELECT 1 FROM client_archives c WHERE c.client_id=p.client_id),EXISTS(SELECT 1 FROM billable_projects b WHERE b.project_id=p.id) FROM projects p WHERE p.id=?1", [project_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_| "Nie można odczytać projektu.".to_string())?;
    let (archived, client_archived, billable) = project.ok_or("Nie znaleziono projektu.")?;
    if archived || client_archived { return Err("Projekt lub jego klient jest w archiwum.".into()); }
    if let Some(task_id) = task_id {
        let valid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.id=?1 AND t.project_id=?2 AND NOT EXISTS(SELECT 1 FROM task_archives a WHERE a.task_id=t.id))", params![task_id,project_id], |r| r.get(0)).map_err(|_| "Nie można odczytać zadania.".to_string())?;
        if !valid { return Err("Zadanie nie należy do projektu lub znajduje się w archiwum.".into()); }
    }
    Ok(billable)
}

/// Insert the new running row and its metadata as part of the caller's timer
/// transaction. The caller also checks timer state and interval overlaps.
pub fn insert_running(db: &Connection, project_id: i64, task_id: Option<i64>, start: &str, description: &str, billing_override: Option<bool>) -> std::result::Result<i64, String> {
    if db.is_autocommit() { return Err("Pomiar wymaga transakcji zapisu.".into()); }
    crate::valid_description(description)?;
    let default_billable = target_billing(db, project_id, task_id)?;
    let billable = billing_override.unwrap_or(default_billable);
    db.execute("INSERT INTO time_entries(task_id,project_id,started_at) VALUES(?1,?2,?3)", params![task_id,project_id,start]).map_err(crate::db_err)?;
    let id = db.last_insert_rowid();
    if billable { db.execute("INSERT INTO billable_entries(entry_id) VALUES(?1)", [id]).map_err(crate::db_err)?; }
    if !description.is_empty() { db.execute("INSERT INTO entry_descriptions(entry_id,description) VALUES(?1,?2)", params![id,description]).map_err(crate::db_err)?; }
    Ok(id)
}

pub fn insert_manual(tracker: &mut crate::Tracker, project_id: i64, task_id: Option<i64>, started_at: &str, ended_at: &str, current: DateTime<Utc>, description: &str) -> std::result::Result<i64,String> {
    crate::ensure_available(tracker)?;
    crate::valid_description(description)?;
    let (start,end)=crate::parse_manual_range(started_at,ended_at,current)?;
    let tx=tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(crate::db_err)?;
    let billable=target_billing(&tx,project_id,task_id)?;
    crate::ensure_no_overlap(&tx,start,end,None)?;
    let start_text=start.to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
    let end_text=end.to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
    tx.execute("INSERT INTO time_entries(task_id,project_id,started_at,ended_at,duration_seconds,manually_resolved) VALUES(?1,?2,?3,?4,?5,1)",params![task_id,project_id,start_text,end_text,(end-start).num_seconds()]).map_err(crate::db_err)?;
    let id=tx.last_insert_rowid();
    if billable { tx.execute("INSERT INTO billable_entries(entry_id) VALUES(?1)",[id]).map_err(crate::db_err)?; }
    if !description.is_empty() { tx.execute("INSERT INTO entry_descriptions(entry_id,description) VALUES(?1,?2)",params![id,description]).map_err(crate::db_err)?; }
    tx.commit().map_err(crate::db_err)?;
    Ok(id)
}

pub fn validate(db: &Connection) -> Result<()> {
    let columns: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('time_entries') WHERE name='task_id' AND UPPER(type)='INTEGER' AND \"notnull\"=0) AND EXISTS(SELECT 1 FROM pragma_table_info('time_entries') WHERE name='project_id' AND UPPER(type)='INTEGER' AND \"notnull\"=1)", [], |r| r.get(0))?;
    let relationships: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('time_entries') WHERE \"from\"='project_id' AND \"table\"='projects' AND \"to\"='id') AND EXISTS(SELECT 1 FROM pragma_foreign_key_list('time_entries') a JOIN pragma_foreign_key_list('time_entries') b ON a.id=b.id WHERE a.\"table\"='tasks' AND b.\"table\"='tasks' AND a.\"from\"='task_id' AND a.\"to\"='id' AND b.\"from\"='project_id' AND b.\"to\"='project_id')", [], |r| r.get(0))?;
    if !columns || !relationships || db.prepare("PRAGMA foreign_key_check")?.query([])?.next()?.is_some() { return Err(Error::InvalidQuery); }
    crate::storage_safety::validate_timer_index(db)
}

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
    validate(&tx)?;
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
        validate(&db).unwrap();
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

    #[test]
    fn migrates_actual_v10_schema_with_all_entry_dependents() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::initialise_v10(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient');
            INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt');
            INSERT INTO tasks(id,project_id,name) VALUES(1,1,'Zadanie');
            INSERT INTO time_entries(id,task_id,started_at,ended_at,duration_seconds) VALUES(41,1,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600);
            INSERT INTO entry_descriptions VALUES(41,'Opis');
            INSERT INTO billable_entries VALUES(41);
            INSERT INTO entry_revisions(entry_id,changed_at,before_start,before_end,before_seconds,after_start,after_end,after_seconds) VALUES(41,'2026-01-02T00:00:00Z','2026-01-01T09:00:00Z','2026-01-01T10:00:00Z',3600,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600);
            INSERT INTO billing_revisions(entry_id,changed_at,before_billable,after_billable) VALUES(41,'2026-01-02T00:00:00Z',0,1);
            INSERT INTO description_revisions(entry_id,changed_at,before_description,after_description) VALUES(41,'2026-01-02T00:00:00Z','','Opis');
            INSERT INTO entry_deletions(entry_id,deleted_at) VALUES(41,'2026-01-03T00:00:00Z');").unwrap();
        migrate(&mut db).unwrap();
        let count = |table: &str| db.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE entry_id=41"),[],|r|r.get::<_,i64>(0)).unwrap();
        for table in ["entry_descriptions", "billable_entries", "entry_revisions", "billing_revisions", "description_revisions", "entry_deletions"] { assert_eq!(count(table), 1); }
        assert!(db.prepare("PRAGMA foreign_key_check").unwrap().query([]).unwrap().next().unwrap().is_none());
        assert_eq!(db.query_row("SELECT project_id FROM time_entries WHERE id=41",[],|r|r.get::<_,i64>(0)).unwrap(), 1);
    }

    #[test]
    fn project_target_checks_parent_task_and_billing() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::initialise_v10(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt'),(2,1,'Inny'); INSERT INTO tasks(id,project_id,name) VALUES(1,1,'Zadanie'); INSERT INTO billable_projects VALUES(1);").unwrap();
        assert_eq!(target_billing(&db, 1, None).unwrap(), true);
        assert_eq!(target_billing(&db, 1, Some(1)).unwrap(), true);
        assert!(target_billing(&db, 2, Some(1)).is_err());
        db.execute("INSERT INTO task_archives VALUES(1)", []).unwrap();
        assert!(target_billing(&db, 1, Some(1)).is_err());
        assert!(target_billing(&db, 1, None).is_ok());
        db.execute("UPDATE projects SET archived=1 WHERE id=1", []).unwrap();
        assert!(target_billing(&db, 1, None).is_err());
        assert!(target_billing(&db, 999, None).is_err());
    }

    #[test]
    fn inserts_project_timer_and_rolls_back_metadata_failure() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::initialise_v10(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt'); INSERT INTO billable_projects VALUES(1);").unwrap();
        migrate(&mut db).unwrap();
        assert!(insert_running(&db, 1, None, "2026-01-01T10:00:00Z", "Opis", None).is_err());
        db.execute_batch("CREATE TRIGGER reject_description BEFORE INSERT ON entry_descriptions BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        {
            let tx = db.transaction().unwrap();
            assert!(insert_running(&tx, 1, None, "2026-01-01T10:00:00Z", "Opis", None).is_err());
        }
        assert_eq!(db.query_row("SELECT COUNT(*) FROM time_entries",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM billable_entries",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        db.execute_batch("DROP TRIGGER reject_description;").unwrap();
        let id = { let tx = db.transaction().unwrap(); let id = insert_running(&tx,1,None,"2026-01-01T10:00:00Z","Opis",None).unwrap(); tx.commit().unwrap(); id };
        let row: (i64,Option<i64>,String,bool) = db.query_row("SELECT project_id,task_id,(SELECT description FROM entry_descriptions WHERE entry_id=time_entries.id),EXISTS(SELECT 1 FROM billable_entries WHERE entry_id=time_entries.id) FROM time_entries WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(row,(1,None,"Opis".to_string(),true));
    }

    #[test]
    fn project_timer_switch_resume_and_stale_state_are_atomic() {
        let mut db=Connection::open_in_memory().unwrap();
        crate::initialise_v10(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt'),(2,1,'Inny'); INSERT INTO tasks(id,project_id,name) VALUES(1,1,'Zadanie'); INSERT INTO billable_projects VALUES(1);").unwrap();
        migrate(&mut db).unwrap();
        let mut tracker=crate::Tracker { db, running_since:None, restored:false };
        transition(&mut tracker,None,&crate::now(),TimerAction::Start { project_id:1,task_id:None,description:"Bez zadania" }).unwrap();
        let id:i64=tracker.db.query_row("SELECT id FROM time_entries WHERE ended_at IS NULL",[],|r|r.get(0)).unwrap();
        let snapshot=crate::snapshot(&tracker).unwrap();
        let active=snapshot.active.unwrap();
        assert_eq!((active.id,active.project_id,active.task_id),(id,1,None));
        let report=crate::report_data(&tracker,Utc::now(),crate::power_sample()).unwrap();
        assert_eq!((report.active.as_ref().unwrap().project_id,report.active.unwrap().task_id),(1,None));
        let health=crate::storage_safety::diagnose_database(&tracker.db).unwrap();
        assert_eq!((health.schema_version,health.open_entries),(11,1));
        assert!(crate::set_project_archived(&mut tracker.db,1,true).is_err());
        assert!(transition(&mut tracker,None,&crate::now(),TimerAction::Start { project_id:2,task_id:None,description:"Błędny stan" }).is_err());
        assert!(transition(&mut tracker,Some(id),&crate::now(),TimerAction::Start { project_id:2,task_id:Some(1),description:"Zły projekt" }).is_err());
        assert_eq!(tracker.db.query_row("SELECT id FROM time_entries WHERE ended_at IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),id);
        tracker.db.execute_batch("CREATE TRIGGER reject_entry BEFORE INSERT ON time_entries BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(transition(&mut tracker,Some(id),&crate::now(),TimerAction::Start { project_id:2,task_id:None,description:"Nowy" }).is_err());
        assert_eq!(tracker.db.query_row("SELECT id FROM time_entries WHERE ended_at IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),id);
        assert!(tracker.running_since.is_some());
        tracker.db.execute_batch("DROP TRIGGER reject_entry;").unwrap();
        transition(&mut tracker,Some(id),&crate::now(),TimerAction::Start { project_id:2,task_id:None,description:"Nowy" }).unwrap();
        let second:i64=tracker.db.query_row("SELECT id FROM time_entries WHERE ended_at IS NULL",[],|r|r.get(0)).unwrap();
        transition(&mut tracker,Some(second),&crate::now(),TimerAction::Resume { entry_id:id }).unwrap();
        let restored:(i64,Option<i64>,String,bool)=tracker.db.query_row("SELECT project_id,task_id,(SELECT description FROM entry_descriptions WHERE entry_id=e.id),EXISTS(SELECT 1 FROM billable_entries b WHERE b.entry_id=e.id) FROM time_entries e WHERE ended_at IS NULL",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(restored,(1,None,"Bez zadania".into(),true));
        let third:i64=tracker.db.query_row("SELECT id FROM time_entries WHERE ended_at IS NULL",[],|r|r.get(0)).unwrap();
        transition(&mut tracker,Some(third),&crate::now(),TimerAction::Stop).unwrap();
        let report=crate::report_data(&tracker,Utc::now(),crate::power_sample()).unwrap();
        assert_eq!(report.entries.len(),3);
        assert!(report.entries.iter().all(|entry| entry.task_id.is_none()));
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM time_entries WHERE ended_at IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM time_entries",[],|r|r.get::<_,i64>(0)).unwrap(),3);
    }

    #[test]
    fn manual_project_entry_inherits_billing_and_rejects_overlaps() {
        let mut db=Connection::open_in_memory().unwrap();
        crate::initialise_v10(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt'); INSERT INTO billable_projects VALUES(1);").unwrap();
        migrate(&mut db).unwrap();
        let mut tracker=crate::Tracker { db, running_since:None, restored:false };
        let now=DateTime::parse_from_rfc3339("2026-01-03T00:00:00Z").unwrap().with_timezone(&Utc);
        let id=insert_manual(&mut tracker,1,None,"2026-01-01T09:00:00Z","2026-01-01T10:00:00Z",now,"Ręczny").unwrap();
        let result=crate::snapshot(&tracker).unwrap();
        assert_eq!((result.entries[0].id,result.entries[0].project_id,result.entries[0].task_id,result.entries[0].billable),(id,1,None,true));
        assert_eq!(result.entries[0].description,"Ręczny");
        assert!(insert_manual(&mut tracker,1,None,"2026-01-01T09:30:00Z","2026-01-01T10:30:00Z",now,"").is_err());
        assert_eq!(crate::snapshot(&tracker).unwrap().entries.len(),1);
    }

    #[test]
    fn application_initialisation_migrates_v10_and_reopens_v11() {
        let mut db=Connection::open_in_memory().unwrap();
        crate::initialise_v10(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt'); INSERT INTO tasks(id,project_id,name) VALUES(1,1,'Zadanie'); INSERT INTO time_entries(id,task_id,started_at,ended_at,duration_seconds) VALUES(41,1,'2026-01-01T09:00:00Z','2026-01-01T10:00:00Z',3600); INSERT INTO entry_descriptions VALUES(41,'Zachowany opis');").unwrap();
        crate::initialise(&mut db).unwrap();
        assert_eq!(db.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),11);
        assert_eq!(db.query_row("SELECT project_id FROM time_entries WHERE id=41",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(db.query_row("SELECT description FROM entry_descriptions WHERE entry_id=41",[],|r|r.get::<_,String>(0)).unwrap(),"Zachowany opis");
        crate::initialise(&mut db).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM time_entries",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
}
