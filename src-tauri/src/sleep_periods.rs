//! Storage operations and schema migration for sleep decisions.
//! Windows power notifications and user decisions are not yet wired.

use chrono::DateTime;
use rusqlite::{params, Connection, Error, OptionalExtension, Result, TransactionBehavior};
use serde::Serialize;

const MAX_TIMESTAMP_MS: i64 = 8_640_000_000_000_000;

/// D4 short sleep (owner decision 23.11.2026, as in Toggl): an observed sleep shorter
/// than this is counted as work without a question and stored as 'auto_included'.
/// A sleep of exactly this length or longer, and every unfinished period, stays pending.
/// The v14 schema repeats the value in its CHECK; a test keeps the two equal.
pub const SHORT_SLEEP_AUTO_INCLUDE_MS: i64 = 5 * 60 * 1000;
/// Schema version that can store 'auto_included' (rebuilt sleep_periods table).
pub const AUTO_INCLUDE_SCHEMA_VERSION: i64 = 14;
const V12_SCHEMA: &str = include_str!("sleep_periods.sql");
const V14_SCHEMA: &str = include_str!("sleep_periods_v14.sql");
const V14_MIGRATION: &str = include_str!("sleep_periods_v14_migration.sql");
const SCHEMA_OBJECTS: [&str; 8] = ["sleep_periods", "sleep_periods_pending", "sleep_periods_one_open", "sleep_periods_initial_pending", "sleep_periods_no_overlap_insert", "sleep_periods_no_overlap_update", "sleep_periods_immutable", "sleep_periods_no_delete"];

/// Decisions that count as work: the user's 'included' and the automatic short-sleep inclusion.
/// Pending and excluded sleep is never work.
pub fn counts_as_work(decision: &str) -> bool { matches!(decision, "included" | "auto_included") }
fn known_decision(decision: &str) -> bool { matches!(decision, "pending" | "included" | "excluded" | "auto_included") }

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SleepPeriod {
    pub id: i64,
    pub entry_id: i64,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
    pub manual_resume: bool,
    pub decision: String,
}

fn valid_ms(value: i64) -> bool { (0..=MAX_TIMESTAMP_MS).contains(&value) }

/// Validate the exact sleep schema as well as persisted rows. This is used by
/// preflight and backup validation once v12 is enabled; it never repairs data.
/// A v12 or v13 database has the v12 table; from v14 the table allows 'auto_included'.
pub fn validate(db: &Connection) -> Result<()> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version >= AUTO_INCLUDE_SCHEMA_VERSION { validate_schema(db, V14_SCHEMA, true) } else { validate_schema(db, V12_SCHEMA, false) }
}

fn validate_schema(db: &Connection, schema: &str, auto_include: bool) -> Result<()> {
    // Compare definitions against this build's canonical schema, including
    // protective triggers and partial indexes, without modifying the live DB.
    let canonical = Connection::open_in_memory()?;
    canonical.execute_batch("CREATE TABLE time_entries(id INTEGER PRIMARY KEY);")?;
    canonical.execute_batch(schema)?;
    for name in SCHEMA_OBJECTS {
        let expected: String = canonical.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| r.get(0))?;
        let actual: String = db.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| r.get(0))?;
        if actual != expected { return Err(Error::InvalidQuery); }
    }
    let bad: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sleep_periods s LEFT JOIN time_entries e ON e.id=s.entry_id WHERE e.id IS NULL OR s.id<=0 OR typeof(s.started_ms)!='integer' OR s.started_ms<0 OR s.started_ms>8640000000000000 OR (s.ended_ms IS NOT NULL AND (typeof(s.ended_ms)!='integer' OR s.ended_ms<=s.started_ms OR s.ended_ms>8640000000000000)) OR s.manual_resume NOT IN (0,1) OR (s.ended_ms IS NULL AND s.manual_resume<>0) OR s.decision NOT IN ('pending','included','excluded','auto_included') OR (s.decision='auto_included' AND (?1=0 OR s.ended_ms IS NULL OR s.manual_resume<>0 OR s.decided_ms IS NOT s.ended_ms OR s.ended_ms-s.started_ms>=?2)) OR (s.decision='pending' AND s.decided_ms IS NOT NULL) OR (s.decision IN ('included','excluded') AND (s.ended_ms IS NULL OR typeof(s.decided_ms)!='integer' OR s.decided_ms<0 OR s.decided_ms>8640000000000000))) OR EXISTS(SELECT 1 FROM sleep_periods a JOIN sleep_periods b ON a.entry_id=b.entry_id AND a.id<b.id WHERE (b.ended_ms IS NULL OR a.started_ms<b.ended_ms) AND (a.ended_ms IS NULL OR b.started_ms<a.ended_ms))", params![auto_include as i64, SHORT_SLEEP_AUTO_INCLUDE_MS], |r| r.get(0))?;
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
    tx.execute_batch(V12_SCHEMA)?;
    validate(&tx)?;
    tx.pragma_update(None, "user_version", 12)?;
    tx.commit()
}

/// Migrate a verified v13 database to v14 in one transaction: the table is rebuilt
/// so its CHECK allows 'auto_included' (see sleep_periods_v14_migration.sql). Every
/// row keeps its id, boundaries, flag and decision; existing pending periods stay
/// pending. The caller must create and verify a backup of an existing database first.
pub fn migrate_auto_include(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let foreign_keys: i64 = tx.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
    if version != AUTO_INCLUDE_SCHEMA_VERSION - 1 || foreign_keys != 1 { return Err(Error::InvalidQuery); }
    validate_schema(&tx, V12_SCHEMA, false)?;
    let before: i64 = tx.query_row("SELECT COUNT(*) FROM sleep_periods", [], |r| r.get(0))?;
    let (prepare, copy) = V14_MIGRATION.split_once("-- @schema").ok_or(Error::InvalidQuery)?;
    tx.execute_batch(prepare)?;
    tx.execute_batch(V14_SCHEMA)?;
    tx.execute_batch(copy)?;
    let (after, differing): (i64, i64) = tx.query_row(
        "SELECT (SELECT COUNT(*) FROM sleep_periods), (SELECT COUNT(*) FROM (SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods EXCEPT SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods_v13))",
        [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    if after != before || differing != 0 { return Err(Error::InvalidQuery); }
    tx.execute_batch("DROP TABLE sleep_periods_v13;")?;
    validate_schema(&tx, V14_SCHEMA, true)?;
    tx.pragma_update(None, "user_version", AUTO_INCLUDE_SCHEMA_VERSION)?;
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
/// From v14 an observed sleep shorter than SHORT_SLEEP_AUTO_INCLUDE_MS is decided in
/// the same statement as 'auto_included' at the resume time; a longer one stays pending.
/// Only this observed path decides automatically: a user-supplied resume, a period
/// clipped at a recovered end and an unfinished period always stay pending (D4-A).
pub fn record_resume(db: &mut Connection, entry_id: i64, period_id: i64, ended_ms: i64) -> Result<()> {
    if entry_id <= 0 || period_id <= 0 || !valid_ms(ended_ms) { return Err(Error::InvalidQuery); }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let threshold = if version >= AUTO_INCLUDE_SCHEMA_VERSION { SHORT_SLEEP_AUTO_INCLUDE_MS } else { 0 };
    let count = tx.execute(
        "UPDATE sleep_periods SET ended_ms=?1, decision=CASE WHEN ?1-started_ms<?4 THEN 'auto_included' ELSE 'pending' END, decided_ms=CASE WHEN ?1-started_ms<?4 THEN ?1 ELSE NULL END WHERE id=?2 AND entry_id=?3 AND ended_ms IS NULL AND decision='pending' AND started_ms<?1",
        params![ended_ms, period_id, entry_id, threshold],
    )?;
    if count != 1 { return Err(Error::InvalidQuery); }
    tx.commit()
}

/// A user may supply a missing resume boundary. It is stored as user-provided
/// and cannot be rewritten later, even if the pending decision is postponed.
pub fn record_resume_manual(db: &mut Connection, entry_id: i64, period_id: i64, ended_ms: i64, current_ms: i64) -> Result<()> {
    if entry_id <= 0 || period_id <= 0 || !valid_ms(ended_ms) || !valid_ms(current_ms) || ended_ms > current_ms { return Err(Error::InvalidQuery); }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<(i64, Option<String>)> = tx.query_row("SELECT s.started_ms,e.ended_at FROM sleep_periods s JOIN time_entries e ON e.id=s.entry_id WHERE s.id=?1 AND s.entry_id=?2 AND s.ended_ms IS NULL AND s.decision='pending'", params![period_id,entry_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (started_ms,entry_end) = row.ok_or(Error::InvalidQuery)?;
    if ended_ms <= started_ms { return Err(Error::InvalidQuery); }
    if let Some(entry_end) = entry_end {
        let entry_end = DateTime::parse_from_rfc3339(&entry_end).map_err(|_| Error::InvalidQuery)?.timestamp_millis();
        if ended_ms > entry_end { return Err(Error::InvalidQuery); }
    }
    let changed = tx.execute("UPDATE sleep_periods SET ended_ms=?1,manual_resume=1 WHERE id=?2 AND entry_id=?3 AND ended_ms IS NULL AND decision='pending'", params![ended_ms,period_id,entry_id])?;
    if changed != 1 { return Err(Error::InvalidQuery); }
    tx.commit()
}

/// When a recovered entry is ended manually at `end_ms`, an open period that
/// began before that end is completed at `end_ms` inside the caller's
/// transaction, so the remaining fragment can still be decided. It is marked
/// as user-provided and stays pending. An open period starting at or after the
/// end is outside the entry and is left untouched. Returns the number of rows.
pub fn close_open_at_entry_end(db: &Connection, entry_id: i64, end_ms: i64) -> Result<usize> {
    if entry_id <= 0 || !valid_ms(end_ms) { return Err(Error::InvalidQuery); }
    db.execute(
        "UPDATE sleep_periods SET ended_ms=?1,manual_resume=1 WHERE entry_id=?2 AND ended_ms IS NULL AND decision='pending' AND started_ms<?1",
        params![end_ms, entry_id],
    )
}

/// Decide only one identified, complete pending period. Retry cannot double count.
/// A period that starts at or after the end of its completed entry is outside
/// the entry's time and cannot be decided.
pub fn resolve(db: &mut Connection, entry_id: i64, period_id: i64, include: bool, decided_ms: i64) -> Result<()> {
    if entry_id <= 0 || period_id <= 0 || !valid_ms(decided_ms) { return Err(Error::InvalidQuery); }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<(i64, Option<String>)> = tx.query_row("SELECT s.started_ms,e.ended_at FROM sleep_periods s JOIN time_entries e ON e.id=s.entry_id WHERE s.id=?1 AND s.entry_id=?2", params![period_id, entry_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let (started_ms, entry_end) = row.ok_or(Error::InvalidQuery)?;
    if let Some(entry_end) = entry_end {
        let entry_end = DateTime::parse_from_rfc3339(&entry_end).map_err(|_| Error::InvalidQuery)?.timestamp_millis();
        if started_ms >= entry_end { return Err(Error::InvalidQuery); }
    }
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
    let mut stmt = db.prepare("SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision FROM sleep_periods WHERE entry_id=?1 ORDER BY started_ms,id")?;
    let rows = stmt.query_map([entry_id], |r| Ok(SleepPeriod { id:r.get(0)?, entry_id:r.get(1)?, started_ms:r.get(2)?, ended_ms:r.get(3)?, manual_resume:r.get(4)?, decision:r.get(5)? }))?;
    rows.collect()
}

/// Sleep periods counted within a completed entry `[started_at, ended_at)`.
/// The end E may lie before recorded sleep (the user stopped working earlier):
/// a period starting at or after E is outside the entry and ignored; a period
/// starting before E is clipped to `[start, min(end, E))`, an open one to E.
/// The returned periods carry the clipped end, so every consumer (report,
/// history, CSV, frontend split) counts the same fragment. Time is never added:
/// pending and excluded fragments are subtracted, included and auto-included ones stay work.
/// Stored rows are validated as recorded; inconsistent data fails closed.
pub fn periods_within_entry(db: &Connection, entry_id: i64, started_at: &str, ended_at: &str) -> Result<Option<(i64, Vec<SleepPeriod>)>> {
    let periods = list_for_entry(db, entry_id)?;
    if periods.is_empty() { return Ok(None); }
    let start = DateTime::parse_from_rfc3339(started_at).map_err(|_| Error::InvalidQuery)?.timestamp_millis();
    let end = DateTime::parse_from_rfc3339(ended_at).map_err(|_| Error::InvalidQuery)?.timestamp_millis();
    if !valid_ms(start) || !valid_ms(end) || end < start { return Err(Error::InvalidQuery); }
    let mut cursor = start;
    let mut seen_open = false;
    let mut omitted = 0i64;
    let mut within = Vec::new();
    for mut period in periods {
        if period.entry_id != entry_id || seen_open || period.started_ms < cursor || period.started_ms < start { return Err(Error::InvalidQuery); }
        match period.ended_ms {
            Some(raw_end) if raw_end <= period.started_ms => return Err(Error::InvalidQuery),
            Some(raw_end) => cursor = raw_end,
            None => seen_open = true,
        }
        if !known_decision(&period.decision) { return Err(Error::InvalidQuery); }
        if period.started_ms >= end { continue; }
        let clipped = period.ended_ms.map_or(end, |raw_end| raw_end.min(end));
        if !counts_as_work(&period.decision) {
            omitted = omitted.checked_add(clipped - period.started_ms).ok_or(Error::InvalidQuery)?;
        }
        period.ended_ms = Some(clipped);
        within.push(period);
    }
    if within.is_empty() { return Ok(None); }
    let elapsed = end.checked_sub(start).ok_or(Error::InvalidQuery)?;
    let work = elapsed.checked_sub(omitted).ok_or(Error::InvalidQuery)?;
    if work < 0 { return Err(Error::InvalidQuery); }
    Ok(Some((work / 1000, within)))
}

/// Strict variant for a running entry projected to `ended_at`: every period
/// must be closed and lie within the interval; anything else is unsafe.
pub fn completed_periods(db: &Connection, entry_id: i64, started_at: &str, ended_at: &str) -> Result<Option<(i64, Vec<SleepPeriod>)>> {
    let periods = list_for_entry(db, entry_id)?;
    if periods.is_empty() { return Ok(None); }
    let start = DateTime::parse_from_rfc3339(started_at).map_err(|_| Error::InvalidQuery)?.timestamp_millis();
    let end = DateTime::parse_from_rfc3339(ended_at).map_err(|_| Error::InvalidQuery)?.timestamp_millis();
    if !valid_ms(start) || !valid_ms(end) || end < start { return Err(Error::InvalidQuery); }
    let mut cursor = start;
    let mut omitted = 0i64;
    for period in &periods {
        let period_end = period.ended_ms.ok_or(Error::InvalidQuery)?;
        if period.entry_id != entry_id || period.started_ms < cursor || period.started_ms < start || period_end <= period.started_ms || period_end > end { return Err(Error::InvalidQuery); }
        match period.decision.as_str() {
            "pending" | "excluded" => omitted = omitted.checked_add(period_end - period.started_ms).ok_or(Error::InvalidQuery)?,
            "included" | "auto_included" => (),
            _ => return Err(Error::InvalidQuery),
        }
        cursor = period_end;
    }
    let elapsed = end.checked_sub(start).ok_or(Error::InvalidQuery)?;
    let work = elapsed.checked_sub(omitted).ok_or(Error::InvalidQuery)? / 1000;
    Ok(Some((work, periods)))
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

    #[test]
    fn user_resume_boundary_is_recorded_once_without_resolving_decision() {
        let mut db=fixture();
        let start=DateTime::parse_from_rfc3339("2026-01-01T11:00:00Z").unwrap().timestamp_millis();
        let id=record_suspend(&mut db,1,start).unwrap();
        assert!(record_resume_manual(&mut db,1,id,start+2000,start+1000).is_err());
        assert!(record_resume_manual(&mut db,1,id,start,start+1000).is_err());
        record_resume_manual(&mut db,1,id,start+1000,start+2000).unwrap();
        assert!(record_resume_manual(&mut db,1,id,start+1500,start+2000).is_err());
        let p=list_for_entry(&db,1).unwrap();
        assert_eq!((p[0].ended_ms,p[0].manual_resume,p[0].decision.as_str()),(Some(start+1000),true,"pending"));
        assert!(db.execute("UPDATE sleep_periods SET manual_resume=0 WHERE id=?1",[id]).is_err());
    }

    // D4 short sleep (schema v14): a v12 fixture migrated to v14 the way the app does it.
    fn fixture_v14() -> Connection {
        let mut db = fixture();
        db.pragma_update(None, "user_version", AUTO_INCLUDE_SCHEMA_VERSION - 1).unwrap();
        migrate_auto_include(&mut db).unwrap();
        db
    }
    fn at(offset_ms: i64) -> i64 { DateTime::parse_from_rfc3339("2026-01-01T11:00:00Z").unwrap().timestamp_millis() + offset_ms }
    fn decided(db: &Connection, id: i64) -> Option<i64> { db.query_row("SELECT decided_ms FROM sleep_periods WHERE id=?1", [id], |r| r.get(0)).unwrap() }

    #[test]
    fn threshold_is_one_named_constant_repeated_only_in_the_schema_check() {
        assert_eq!(SHORT_SLEEP_AUTO_INCLUDE_MS, 300_000);
        assert!(V14_SCHEMA.contains(&format!("ended_ms - started_ms < {SHORT_SLEEP_AUTO_INCLUDE_MS})")));
        assert_eq!(crate::LATEST_SCHEMA_VERSION, AUTO_INCLUDE_SCHEMA_VERSION);
    }

    #[test]
    fn observed_sleep_under_five_minutes_is_auto_included_and_five_minutes_or_unfinished_asks() {
        let mut db = fixture_v14();
        let one_second = record_suspend(&mut db, 1, at(0)).unwrap();
        record_resume(&mut db, 1, one_second, at(1_000)).unwrap();
        let just_under = record_suspend(&mut db, 1, at(10_000)).unwrap();
        record_resume(&mut db, 1, just_under, at(10_000 + SHORT_SLEEP_AUTO_INCLUDE_MS - 1)).unwrap();
        let boundary = record_suspend(&mut db, 1, at(400_000)).unwrap();
        record_resume(&mut db, 1, boundary, at(400_000 + SHORT_SLEEP_AUTO_INCLUDE_MS)).unwrap();
        let unfinished = record_suspend(&mut db, 1, at(800_000)).unwrap();
        let list = list_for_entry(&db, 1).unwrap();
        assert_eq!(list.iter().map(|p| p.decision.as_str()).collect::<Vec<_>>(), ["auto_included", "auto_included", "pending", "pending"]);
        assert_eq!(list[1].ended_ms, Some(at(10_000 + 299_999)));
        assert_eq!(list[2].ended_ms, Some(at(400_000 + 300_000)));
        assert_eq!(list[3].ended_ms, None);
        // The automatic decision is recorded at the observed resume and is final.
        assert_eq!((decided(&db, one_second), decided(&db, just_under), decided(&db, boundary)), (Some(at(1_000)), Some(at(10_000 + 299_999)), None));
        assert!(resolve(&mut db, 1, one_second, false, at(900_000)).is_err());
        assert!(db.execute("UPDATE sleep_periods SET decision='excluded', decided_ms=1 WHERE id=?1", [just_under]).is_err());
        // The schema refuses an automatic decision for a five-minute or unfinished period.
        assert!(db.execute("UPDATE sleep_periods SET decision='auto_included', decided_ms=ended_ms WHERE id=?1", [boundary]).is_err());
        assert!(db.execute("UPDATE sleep_periods SET decision='auto_included', decided_ms=0 WHERE id=?1", [unfinished]).is_err());
        // A resume time supplied by the user is never decided automatically, however short.
        record_resume_manual(&mut db, 1, unfinished, at(801_000), at(900_000)).unwrap();
        let list = list_for_entry(&db, 1).unwrap();
        assert_eq!((list[3].manual_resume, list[3].decision.as_str()), (true, "pending"));
        resolve(&mut db, 1, boundary, true, at(900_000)).unwrap();
        assert!(validate(&db).is_ok());
    }

    #[test]
    fn before_v14_a_short_sleep_still_asks() {
        let mut db = fixture();
        let id = record_suspend(&mut db, 1, at(0)).unwrap();
        record_resume(&mut db, 1, id, at(1_000)).unwrap();
        assert_eq!(list_for_entry(&db, 1).unwrap()[0].decision, "pending");
    }

    #[test]
    fn auto_included_sleep_counts_as_work_once_in_running_and_completed_projections() {
        let mut db = fixture_v14();
        let short = record_suspend(&mut db, 1, at(0)).unwrap();
        record_resume(&mut db, 1, short, at(120_000)).unwrap();
        let long = record_suspend(&mut db, 1, at(1_800_000)).unwrap();
        record_resume(&mut db, 1, long, at(2_400_000)).unwrap();
        // Entry 1 starts at 10:00; projected to 12:00 only the pending 10 minutes are withheld.
        let (running, periods) = completed_periods(&db, 1, "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z").unwrap().unwrap();
        assert_eq!((running, periods.len()), (7_200 - 600, 2));
        let (completed, within) = periods_within_entry(&db, 1, "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z").unwrap().unwrap();
        assert_eq!((completed, within.len()), (7_200 - 600, 2));
        // An end inside the short sleep keeps the counted fragment as work; the later sleep is outside.
        let (clipped, within) = periods_within_entry(&db, 1, "2026-01-01T10:00:00Z", "2026-01-01T11:01:00Z").unwrap().unwrap();
        assert_eq!((clipped, within.len(), within[0].ended_ms), (3_660, 1, Some(at(60_000))));
        resolve(&mut db, 1, long, true, at(3_000_000)).unwrap();
        assert_eq!(completed_periods(&db, 1, "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z").unwrap().unwrap().0, 7_200);
    }

    #[test]
    fn v14_migration_keeps_every_row_and_refuses_a_damaged_v13_table() {
        let mut db = fixture();
        let a = record_suspend(&mut db, 1, at(0)).unwrap();
        record_resume(&mut db, 1, a, at(1_000)).unwrap();
        let b = record_suspend(&mut db, 1, at(10_000)).unwrap();
        record_resume(&mut db, 1, b, at(700_000)).unwrap();
        resolve(&mut db, 1, b, false, at(800_000)).unwrap();
        record_suspend(&mut db, 1, at(900_000)).unwrap();
        let rows = |db: &Connection| db.prepare("SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods ORDER BY id").unwrap()
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<i64>>(3)?, r.get::<_, i64>(4)?, r.get::<_, String>(5)?, r.get::<_, Option<i64>>(6)?)))
            .unwrap().collect::<Result<Vec<_>>>().unwrap();
        let before = rows(&db);
        // A damaged v13 table is refused before anything changes.
        let mut damaged = fixture();
        damaged.pragma_update(None, "user_version", AUTO_INCLUDE_SCHEMA_VERSION - 1).unwrap();
        damaged.execute_batch("DROP TRIGGER sleep_periods_no_delete;").unwrap();
        assert!(migrate_auto_include(&mut damaged).is_err());
        assert_eq!(damaged.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), AUTO_INCLUDE_SCHEMA_VERSION - 1);
        assert!(damaged.query_row("SELECT sql FROM sqlite_master WHERE name='sleep_periods'", [], |r| r.get::<_, String>(0)).unwrap().contains("'pending', 'included', 'excluded')"));
        db.pragma_update(None, "user_version", AUTO_INCLUDE_SCHEMA_VERSION - 1).unwrap();
        migrate_auto_include(&mut db).unwrap();
        assert_eq!(db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), AUTO_INCLUDE_SCHEMA_VERSION);
        // Same ids, boundaries, flags and decisions: the short pending sleep recorded before v14 stays pending.
        assert_eq!(rows(&db), before);
        assert_eq!(before[0].5, "pending");
        assert!(validate(&db).is_ok());
        assert!(db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='sleep_periods_v13'", [], |r| r.get::<_, i64>(0)).unwrap() == 0);
        assert!(migrate_auto_include(&mut db).is_err(), "a v14 database is not migrated twice");
    }
}
