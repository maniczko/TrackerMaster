//! Storage operations for sleep decisions. Not yet wired into application startup
//! or Windows power notifications; existing databases are not modified by this module.

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

/// Must only be called within an explicit, backed-up schema migration.
pub fn install(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(include_str!("sleep_periods.sql"))?;
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
        install(&mut db).unwrap();
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
}
