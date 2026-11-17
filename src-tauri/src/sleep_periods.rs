//! Storage operations and schema migration for sleep decisions.
//! Windows power notifications and user decisions are not yet wired.

use chrono::DateTime;
use rusqlite::{params, Connection, Error, OptionalExtension, Result, TransactionBehavior};
use serde::Serialize;

const MAX_TIMESTAMP_MS: i64 = 8_640_000_000_000_000;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SleepPeriod {
    pub id: i64,
    pub entry_id: i64,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
    pub decision: String,
}

fn valid_ms(value: i64) -> bool { (0..=MAX_TIMESTAMP_MS).contains(&value) }

/// Validate the exact sleep schema as well as persisted rows. This is used by
/// preflight and backup validation once v12 is enabled; it never repairs data.
pub fn validate(db: &Connection) -> Result<()> {
    // Compare definitions against this build's canonical schema, including
    // protective triggers and partial indexes, without modifying the live DB.
    let canonical = Connection::open_in_memory()?;
    canonical.execute_batch("CREATE TABLE time_entries(id INTEGER PRIMARY KEY);")?;
    canonical.execute_batch(include_str!("sleep_periods.sql"))?;
    for name in ["sleep_periods", "sleep_periods_pending", "sleep_periods_one_open", "sleep_periods_initial_pending", "sleep_periods_no_overlap_insert", "sleep_periods_no_overlap_update", "sleep_periods_immutable", "sleep_periods_no_delete"] {
        let expected: String = canonical.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| r.get(0))?;
        let actual: String = db.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| r.get(0))?;
        if actual != expected { return Err(Error::InvalidQuery); }
    }
    let bad: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sleep_periods s LEFT JOIN time_entries e ON e.id=s.entry_id WHERE e.id IS NULL OR s.id<=0 OR typeof(s.started_ms)!='integer' OR s.started_ms<0 OR s.started_ms>8640000000000000 OR (s.ended_ms IS NOT NULL AND (typeof(s.ended_ms)!='integer' OR s.ended_ms<=s.started_ms OR s.ended_ms>8640000000000000)) OR s.decision NOT IN ('pending','included','excluded') OR (s.decision='pending' AND s.decided_ms IS NOT NULL) OR (s.decision IN ('included','excluded') AND (s.ended_ms IS NULL OR typeof(s.decided_ms)!='integer' OR s.decided_ms<0 OR s.decided_ms>8640000000000000))) OR EXISTS(SELECT 1 FROM sleep_periods a JOIN sleep_periods b ON a.entry_id=b.entry_id AND a.id<b.id WHERE (b.ended_ms IS NULL OR a.started_ms<b.ended_ms) AND (a.ended_ms IS NULL OR b.started_ms<a.ended_ms))", [], |r| r.get(0))?;
    if bad { return Err(Error::InvalidQuery); }
    Ok(())
}

/// Migrate a verified v11 database in one transaction. The caller must create
/// and verify a backup of an existing database before invoking this function.
/// The result requires native migration and backup tests before release.
pub fn migrate(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let foreign_keys: i64 = tx.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
    if version != 11 || foreign_keys != 1 { return Err(Error::InvalidQuery); }
    tx.execute_batch(include_str!("sleep_periods.sql"))?;
    validate(&tx)?;
    tx.pragma_update(None, "user_version", 12)?;
    tx.commit()
}

/// Record a suspend boundary for the still-active entry. No timer is closed.
pub fn record_suspend(db: &mut Connection, entry_id: i64, started_ms: i64) -> Result<i64> {
    if entry_id <= 0 || !valid_ms(started_ms) { return Err(Error::InvalidQuery); }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let start: Option<String> = tx.query_row(
        "SELECT started_at FROM time_entries WHERE id=?1 AND ended_at IS NULL", [entry_id], |r| r.get(0)
    ).optional()?;
    let start = start.ok_or(Error::InvalidQuery)?;
    let entry_start = DateTime::parse_from_rfc3339(&start).map_err(|_| Error::InvalidQuery)?.timestamp_millis();
    if started_ms < entry_start { return Err(Error::InvalidQuery); }
    tx.execute("INSERT INTO sleep_periods(entry_id,started_ms) VALUES(?1,?2)", params![entry_id, started_ms])?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(id)
}

/// Fill the observed resume boundary once. A stale or repeated event fails.
pub fn record_resume(db: &mut Connection, entry_id: i64, period_id: i64, ended_ms: i64) -> Result<()> {
    if entry_id <= 0 || period_id <= 0 || !valid_ms(ended_ms) { return Err(Error::InvalidQuery); }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let count = tx.execute(
        "UPDATE sleep_periods SET ended_ms=?1 WHERE id=?2 AND entry_id=?3 AND ended_ms IS NULL AND decision='pending' AND started_ms<?1",
        params![ended_ms, period_id, entry_id],
    )?;
    if count != 1 { return Err(Error::InvalidQuery); }
    tx.commit()
}

/// Decide only one identified, complete pending period. Retry cannot double count.
pub fn resolve(db: &mut Connection, entry_id: i64, period_id: i64, include: bool, decided_ms: i64) -> Result<()> {
    if entry_id <= 0 || period_id <= 0 || !valid_ms(decided_ms) { return Err(Error::InvalidQuery); }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let decision = if include { "included" } else { "excluded" };
    let count = tx.execute(
        "UPDATE sleep_periods SET decision=?1, decided_ms=?2 WHERE id=?3 AND entry_id=?4 AND decision='pending' AND ended_ms IS NOT NULL",
        params![decision, decided_ms, period_id, entry_id],
    )?;
    if count != 1 { return Err(Error::InvalidQuery); }
    tx.commit()
}

pub fn list_for_entry(db: &Connection, entry_id: i64) -> Result<Vec<SleepPeriod>> {
    if entry_id <= 0 { return Err(Error::InvalidQuery); }
    let mut stmt = db.prepare("SELECT id,entry_id,started_ms,ended_ms,decision FROM sleep_periods WHERE entry_id=?1 ORDER BY started_ms,id")?;
    let rows = stmt.query_map([entry_id], |r| Ok(SleepPeriod { id:r.get(0)?, entry_id:r.get(1)?, started_ms:r.get(2)?, ended_ms:r.get(3)?, decision:r.get(4)? }))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE time_entries(id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT); INSERT INTO time_entries VALUES(1,'2026-01-01T10:00:00Z',NULL), (2,'2026-01-01T09:00:00Z','2026-01-01T10:00:00Z');").unwrap();
        db.pragma_update(None, "user_version", 11).unwrap();
        migrate(&mut db).unwrap();
        db
    }
    #[test]
    fn suspend_resume_and_individual_decision_are_atomic() {
        let mut db = fixture();
        let start = DateTime::parse_from_rfc3339("2026-01-01T11:00:00Z").unwrap().timestamp_millis();
        let id = record_suspend(&mut db, 1, start).unwrap();
        assert!(record_suspend(&mut db, 1, start + 1000).is_err());
        assert!(resolve(&mut db, 1, id, true, start + 2000).is_err());
        assert!(record_resume(&mut db, 2, id, start + 2000).is_err());
        record_resume(&mut db, 1, id, start + 2000).unwrap();
        assert!(record_resume(&mut db, 1, id, start + 3000).is_err());
        let second = record_suspend(&mut db, 1, start + 4000).unwrap();
        record_resume(&mut db, 1, second, start + 6000).unwrap();
        resolve(&mut db, 1, id, true, start + 7000).unwrap();
        assert!(resolve(&mut db, 1, id, false, start + 8000).is_err());
        let list = list_for_entry(&db, 1).unwrap();
        assert_eq!((list[0].decision.as_str(), list[1].decision.as_str()), ("included", "pending"));
    }
    #[test]
    fn cannot_attach_suspend_to_completed_entry_or_before_start() {
        let mut db = fixture();
        let before = DateTime::parse_from_rfc3339("2026-01-01T08:00:00Z").unwrap().timestamp_millis();
        assert!(record_suspend(&mut db, 1, before).is_err());
        assert!(record_suspend(&mut db, 2, before + 10000000).is_err());
        assert!(list_for_entry(&db, 1).unwrap().is_empty());
    }
    #[test]
    fn migration_is_atomic_and_validator_refuses_missing_trigger() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE time_entries(id INTEGER PRIMARY KEY, started_at TEXT, ended_at TEXT); INSERT INTO time_entries VALUES(1,'2026-01-01T10:00:00Z',NULL); CREATE TABLE sleep_periods(id INTEGER); PRAGMA user_version=11;").unwrap();
        assert!(migrate(&mut db).is_err());
        assert_eq!(db.pragma_query_value(None,"user_version",|r| r.get::<_,i64>(0)).unwrap(),11);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM time_entries",[],|r| r.get::<_,i64>(0)).unwrap(),1);
        db.execute_batch("DROP TABLE sleep_periods;").unwrap();
        migrate(&mut db).unwrap();
        assert_eq!(db.pragma_query_value(None,"user_version",|r| r.get::<_,i64>(0)).unwrap(),12);
        assert!(validate(&db).is_ok());
        db.execute_batch("DROP TRIGGER sleep_periods_immutable;").unwrap();
        assert!(validate(&db).is_err());
    }

}
