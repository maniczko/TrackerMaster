//! Storage operations and schema migration for sleep and idle decisions.
//! From schema v15 every period has a `source`: 'sleep' (Windows suspend, D4) or
//! 'idle' (TECH-12 / PTT-61). Both kinds share one timeline per entry and are
//! subtracted from work alike until decided; only the sleep clock checks, the
//! wake-time prompt and the short-sleep rule are specific to 'sleep'.

use chrono::DateTime;
use rusqlite::{params, Connection, Error, OptionalExtension, Result, TransactionBehavior};
use serde::Serialize;

const MAX_TIMESTAMP_MS: i64 = 8_640_000_000_000_000;

/// D4 short sleep (owner decision 23.11.2026, as in Toggl): an observed sleep shorter
/// than this is counted as work without a question and stored as 'auto_included'.
/// A sleep of exactly this length or longer, and every unfinished period, stays pending.
/// The v14 and v15 schemas repeat the value in their CHECK; a test keeps them equal.
pub const SHORT_SLEEP_AUTO_INCLUDE_MS: i64 = 5 * 60 * 1000;
/// Schema version that can store 'auto_included' (rebuilt sleep_periods table).
pub const AUTO_INCLUDE_SCHEMA_VERSION: i64 = 14;
/// Schema version whose periods carry `source` ('sleep' | 'idle'), TECH-12 §3.1.
pub const SOURCE_SCHEMA_VERSION: i64 = 15;
const V12_SCHEMA: &str = include_str!("sleep_periods.sql");
const V14_SCHEMA: &str = include_str!("sleep_periods_v14.sql");
const V14_MIGRATION: &str = include_str!("sleep_periods_v14_migration.sql");
const V15_SCHEMA: &str = include_str!("sleep_periods_v15.sql");
const V15_MIGRATION: &str = include_str!("sleep_periods_v15_migration.sql");
/// Observed resume of a sleep period (schema v15). ?1 end, ?2 period, ?3 entry, ?4 threshold.
/// A sleep shorter than the threshold is decided 'auto_included' in the same statement,
/// unless an idle period of the entry ends exactly where the sleep begins: the user was
/// already away when the computer slept, so the sleep stays pending together with that
/// idle period (O5a, owner decision 25.11.2026; the only exception to #62). The condition
/// is stored data, so it survives a restart between suspend and resume.
/// tests/windows-application.mjs (short-sleep) and tests/sleepPeriods.test.mjs run this text.
const RESUME_SQL: &str = "UPDATE sleep_periods SET ended_ms=?1, decision=CASE WHEN ?1-started_ms<?4 AND NOT EXISTS(SELECT 1 FROM sleep_periods i WHERE i.entry_id=sleep_periods.entry_id AND i.source='idle' AND i.ended_ms=sleep_periods.started_ms) THEN 'auto_included' ELSE 'pending' END, decided_ms=CASE WHEN ?1-started_ms<?4 AND NOT EXISTS(SELECT 1 FROM sleep_periods i WHERE i.entry_id=sleep_periods.entry_id AND i.source='idle' AND i.ended_ms=sleep_periods.started_ms) THEN ?1 ELSE NULL END WHERE id=?2 AND entry_id=?3 AND source='sleep' AND ended_ms IS NULL AND decision='pending' AND started_ms<?1";
/// The same resume before v15, when every period is sleep (threshold 0 before v14).
const RESUME_SQL_WITHOUT_SOURCE: &str = "UPDATE sleep_periods SET ended_ms=?1, decision=CASE WHEN ?1-started_ms<?4 THEN 'auto_included' ELSE 'pending' END, decided_ms=CASE WHEN ?1-started_ms<?4 THEN ?1 ELSE NULL END WHERE id=?2 AND entry_id=?3 AND ended_ms IS NULL AND decision='pending' AND started_ms<?1";
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
    /// 'sleep' or 'idle' (always 'sleep' before v15). Not sent to the UI yet (DEV-39 PR 1).
    #[serde(skip)]
    pub source: String,
}

impl SleepPeriod {
    /// A suspend recorded by the power path. Only these periods are compared with the
    /// power counters; an idle period is time awake.
    pub fn is_sleep(&self) -> bool { self.source == "sleep" }
}

fn valid_ms(value: i64) -> bool { (0..=MAX_TIMESTAMP_MS).contains(&value) }

/// Whether this database stores `source` (schema v15 or later).
fn has_source(db: &Connection) -> Result<bool> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    Ok(version >= SOURCE_SCHEMA_VERSION)
}

/// Validate the exact sleep schema as well as persisted rows. This is used by
/// preflight and backup validation once v12 is enabled; it never repairs data.
/// A v12 or v13 database has the v12 table; from v14 the table allows 'auto_included';
/// from v15 every period has a source and 'auto_included' is sleep only.
pub fn validate(db: &Connection) -> Result<()> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version >= SOURCE_SCHEMA_VERSION { validate_schema(db, V15_SCHEMA, true, true) }
    else if version >= AUTO_INCLUDE_SCHEMA_VERSION { validate_schema(db, V14_SCHEMA, true, false) }
    else { validate_schema(db, V12_SCHEMA, false, false) }
}

fn validate_schema(db: &Connection, schema: &str, auto_include: bool, source: bool) -> Result<()> {
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
    // Before v15 every row is sleep; the source conditions then hold trivially.
    let src = if source { "s.source" } else { "'sleep'" };
    let bad: bool = db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM sleep_periods s LEFT JOIN time_entries e ON e.id=s.entry_id WHERE e.id IS NULL OR s.id<=0 OR typeof(s.started_ms)!='integer' OR s.started_ms<0 OR s.started_ms>8640000000000000 OR (s.ended_ms IS NOT NULL AND (typeof(s.ended_ms)!='integer' OR s.ended_ms<=s.started_ms OR s.ended_ms>8640000000000000)) OR s.manual_resume NOT IN (0,1) OR (s.ended_ms IS NULL AND s.manual_resume<>0) OR s.decision NOT IN ('pending','included','excluded','auto_included') OR {src} NOT IN ('sleep','idle') OR (s.decision='auto_included' AND ({src}<>'sleep' OR ?1=0 OR s.ended_ms IS NULL OR s.manual_resume<>0 OR s.decided_ms IS NOT s.ended_ms OR s.ended_ms-s.started_ms>=?2)) OR (s.decision='pending' AND s.decided_ms IS NOT NULL) OR (s.decision IN ('included','excluded') AND (s.ended_ms IS NULL OR typeof(s.decided_ms)!='integer' OR s.decided_ms<0 OR s.decided_ms>8640000000000000))) OR EXISTS(SELECT 1 FROM sleep_periods a JOIN sleep_periods b ON a.entry_id=b.entry_id AND a.id<b.id WHERE (b.ended_ms IS NULL OR a.started_ms<b.ended_ms) AND (a.ended_ms IS NULL OR b.started_ms<a.ended_ms))"), params![auto_include as i64, SHORT_SLEEP_AUTO_INCLUDE_MS], |r| r.get(0))?;
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
    validate_schema(&tx, V12_SCHEMA, false, false)?;
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
    validate_schema(&tx, V14_SCHEMA, true, false)?;
    tx.pragma_update(None, "user_version", AUTO_INCLUDE_SCHEMA_VERSION)?;
    tx.commit()
}

/// Migrate a verified v14 database to v15 in one IMMEDIATE transaction (TECH-12 §3.1):
/// the table is rebuilt with `source` (see sleep_periods_v15_migration.sql). Only v14 is
/// accepted, and only with the exact v14 definitions and valid rows. Every row keeps its
/// id, boundaries, flag and decision (including 'auto_included', #62) and becomes
/// source='sleep', which is what it was recorded as. Any difference, a failed write
/// (e.g. SQLITE_FULL) or an invalid result rolls everything back and leaves v14 as it was.
/// The caller must create and verify a backup of an existing database first.
pub fn migrate_source(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let foreign_keys: i64 = tx.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
    if version != SOURCE_SCHEMA_VERSION - 1 || foreign_keys != 1 { return Err(Error::InvalidQuery); }
    validate_schema(&tx, V14_SCHEMA, true, false)?;
    let before: i64 = tx.query_row("SELECT COUNT(*) FROM sleep_periods", [], |r| r.get(0))?;
    let (prepare, copy) = V15_MIGRATION.split_once("-- @schema").ok_or(Error::InvalidQuery)?;
    tx.execute_batch(prepare)?;
    tx.execute_batch(V15_SCHEMA)?;
    tx.execute_batch(copy)?;
    let (after, differing, missing, not_sleep): (i64, i64, i64, i64) = tx.query_row(
        "SELECT (SELECT COUNT(*) FROM sleep_periods), \
         (SELECT COUNT(*) FROM (SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods EXCEPT SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods_v14)), \
         (SELECT COUNT(*) FROM (SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods_v14 EXCEPT SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods)), \
         (SELECT COUNT(*) FROM sleep_periods WHERE source IS NOT 'sleep')",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
    if after != before || differing != 0 || missing != 0 || not_sleep != 0 { return Err(Error::InvalidQuery); }
    tx.execute_batch("DROP TABLE sleep_periods_v14;")?;
    validate_schema(&tx, V15_SCHEMA, true, true)?;
    tx.pragma_update(None, "user_version", SOURCE_SCHEMA_VERSION)?;
    tx.commit()
}

/// v15: end an open idle period of the entry at `at_ms`, inside the caller's transaction.
/// A suspend, Stop, switch or resume is the end of the absence (TECH-12 §1.4, §1.5), so
/// the idle period is completed there and stays pending as its own item; it is never
/// decided here. Only a period that began before `at_ms` is completed (half-open
/// intervals); anything else is left for the caller's checks to refuse. Before v15 there
/// is no idle period. Returns the number of rows.
pub fn close_open_idle(db: &Connection, entry_id: i64, at_ms: i64) -> Result<usize> {
    if entry_id <= 0 || !valid_ms(at_ms) { return Err(Error::InvalidQuery); }
    if !has_source(db)? { return Ok(0); }
    db.execute(
        "UPDATE sleep_periods SET ended_ms=?1 WHERE entry_id=?2 AND source='idle' AND ended_ms IS NULL AND decision='pending' AND started_ms<?1",
        params![at_ms, entry_id],
    )
}

/// Record a suspend boundary for the still-active entry. No timer is closed.
/// From v15 an open idle period of the entry is first completed at the suspend time in
/// the same transaction (TECH-12 §1.5): the two periods touch at `started_ms` and do
/// not overlap, and the one-open index is respected.
pub fn record_suspend(db: &mut Connection, entry_id: i64, started_ms: i64) -> Result<i64> {
    if entry_id <= 0 || !valid_ms(started_ms) { return Err(Error::InvalidQuery); }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let start: Option<String> = tx.query_row(
        "SELECT started_at FROM time_entries WHERE id=?1 AND ended_at IS NULL", [entry_id], |r| r.get(0)
    ).optional()?;
    let start = start.ok_or(Error::InvalidQuery)?;
    let entry_start = DateTime::parse_from_rfc3339(&start).map_err(|_| Error::InvalidQuery)?.timestamp_millis();
    if started_ms < entry_start { return Err(Error::InvalidQuery); }
    close_open_idle(&tx, entry_id, started_ms)?;
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
/// From v15 only a sleep period is resumed here (an idle period is never a resume), and
/// a short sleep that began where an idle period ended stays pending (O5a, RESUME_SQL).
pub fn record_resume(db: &mut Connection, entry_id: i64, period_id: i64, ended_ms: i64) -> Result<()> {
    if entry_id <= 0 || period_id <= 0 || !valid_ms(ended_ms) { return Err(Error::InvalidQuery); }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let threshold = if version >= AUTO_INCLUDE_SCHEMA_VERSION { SHORT_SLEEP_AUTO_INCLUDE_MS } else { 0 };
    let sql = if version >= SOURCE_SCHEMA_VERSION { RESUME_SQL } else { RESUME_SQL_WITHOUT_SOURCE };
    let count = tx.execute(sql, params![ended_ms, period_id, entry_id, threshold])?;
    if count != 1 { return Err(Error::InvalidQuery); }
    tx.commit()
}

/// A user may supply a missing resume boundary. It is stored as user-provided
/// and cannot be rewritten later, even if the pending decision is postponed.
/// From v15 this applies to sleep only: the user never types the end of an idle
/// period (TECH-12 §1.7); an idle period ends at the next input or action.
pub fn record_resume_manual(db: &mut Connection, entry_id: i64, period_id: i64, ended_ms: i64, current_ms: i64) -> Result<()> {
    if entry_id <= 0 || period_id <= 0 || !valid_ms(ended_ms) || !valid_ms(current_ms) || ended_ms > current_ms { return Err(Error::InvalidQuery); }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let sleep_only = if has_source(&tx)? { " AND source='sleep'" } else { "" };
    let row: Option<(i64, Option<String>)> = tx.query_row(&format!("SELECT s.started_ms,e.ended_at FROM sleep_periods s JOIN time_entries e ON e.id=s.entry_id WHERE s.id=?1 AND s.entry_id=?2 AND s.ended_ms IS NULL AND s.decision='pending'{sleep_only}"), params![period_id,entry_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (started_ms,entry_end) = row.ok_or(Error::InvalidQuery)?;
    if ended_ms <= started_ms { return Err(Error::InvalidQuery); }
    if let Some(entry_end) = entry_end {
        let entry_end = DateTime::parse_from_rfc3339(&entry_end).map_err(|_| Error::InvalidQuery)?.timestamp_millis();
        if ended_ms > entry_end { return Err(Error::InvalidQuery); }
    }
    let changed = tx.execute(&format!("UPDATE sleep_periods SET ended_ms=?1,manual_resume=1 WHERE id=?2 AND entry_id=?3 AND ended_ms IS NULL AND decision='pending'{sleep_only}"), params![ended_ms,period_id,entry_id])?;
    if changed != 1 { return Err(Error::InvalidQuery); }
    tx.commit()
}

/// When a recovered entry is ended manually at `end_ms`, an open period that
/// began before that end is completed at `end_ms` inside the caller's
/// transaction, so the remaining fragment can still be decided. It is marked
/// as user-provided and stays pending. An open period starting at or after the
/// end is outside the entry and is left untouched. Returns the number of rows.
/// This applies to both kinds: from v15 manual_resume=1 on an idle period means
/// "end set when the recovered entry was ended" (TECH-12 §3.1, B3).
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
    let source = if has_source(db)? { "source" } else { "'sleep'" };
    let mut stmt = db.prepare(&format!("SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,{source} FROM sleep_periods WHERE entry_id=?1 ORDER BY started_ms,id"))?;
    let rows = stmt.query_map([entry_id], |r| Ok(SleepPeriod { id:r.get(0)?, entry_id:r.get(1)?, started_ms:r.get(2)?, ended_ms:r.get(3)?, manual_resume:r.get(4)?, decision:r.get(5)?, source:r.get(6)? }))?;
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
        assert!(V15_SCHEMA.contains(&format!("ended_ms - started_ms < {SHORT_SLEEP_AUTO_INCLUDE_MS})")));
        // v15 keeps the v14 rule and adds the source; the latest schema is v15.
        assert_eq!(crate::LATEST_SCHEMA_VERSION, SOURCE_SCHEMA_VERSION);
        assert_eq!(SOURCE_SCHEMA_VERSION, AUTO_INCLUDE_SCHEMA_VERSION + 1);
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

    // TECH-12 / DEV-39 PR 1, schema v15: every period carries a source ('sleep' | 'idle').
    // Idle rows are written here directly; the idle engine that records them is DEV-39 PR 2.
    fn fixture_v15() -> Connection {
        let mut db = fixture_v14();
        migrate_source(&mut db).unwrap();
        db
    }
    fn insert_idle(db: &Connection, entry_id: i64, started_ms: i64, ended_ms: Option<i64>) -> i64 {
        db.execute("INSERT INTO sleep_periods(entry_id,source,started_ms,ended_ms) VALUES(?1,'idle',?2,?3)", params![entry_id, started_ms, ended_ms]).unwrap();
        db.last_insert_rowid()
    }
    type LedgerRow = (i64, i64, i64, Option<i64>, i64, String, Option<i64>);
    fn ledger(db: &Connection) -> Vec<LedgerRow> {
        db.prepare("SELECT id,entry_id,started_ms,ended_ms,manual_resume,decision,decided_ms FROM sleep_periods ORDER BY id").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
            .unwrap().collect::<Result<Vec<_>>>().unwrap()
    }
    fn user_version(db: &Connection) -> i64 { db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap() }
    fn table_sql(db: &Connection) -> String { db.query_row("SELECT sql FROM sqlite_master WHERE name='sleep_periods'", [], |r| r.get(0)).unwrap() }

    // I17 (module level): every v14 row, of every decision, is kept and becomes 'sleep'.
    #[test]
    fn v15_migration_keeps_every_row_as_sleep_and_refuses_a_damaged_v14() {
        let mut db = fixture_v14();
        let short = record_suspend(&mut db, 1, at(0)).unwrap();
        record_resume(&mut db, 1, short, at(60_000)).unwrap();
        let included = record_suspend(&mut db, 1, at(100_000)).unwrap();
        record_resume(&mut db, 1, included, at(800_000)).unwrap();
        resolve(&mut db, 1, included, true, at(900_000)).unwrap();
        let excluded = record_suspend(&mut db, 1, at(1_000_000)).unwrap();
        record_resume(&mut db, 1, excluded, at(1_600_000)).unwrap();
        resolve(&mut db, 1, excluded, false, at(1_700_000)).unwrap();
        let manual = record_suspend(&mut db, 1, at(2_000_000)).unwrap();
        record_resume_manual(&mut db, 1, manual, at(2_100_000), at(3_000_000)).unwrap();
        record_suspend(&mut db, 1, at(3_600_000)).unwrap();
        let before = ledger(&db);
        assert_eq!(before.iter().map(|row| row.5.as_str()).collect::<Vec<_>>(), ["auto_included", "included", "excluded", "pending", "pending"]);
        let total = |db: &Connection| periods_within_entry(db, 1, "2026-01-01T10:00:00Z", "2026-01-01T12:30:00Z").unwrap().unwrap().0;
        let work_before = total(&db);
        // 2.5 h minus the excluded 10 min, the pending 100 s and the open period clipped at 12:30 (30 min).
        assert_eq!(work_before, 9_000 - 600 - 100 - 1_800);

        // A v14 table with a missing trigger is refused before anything changes.
        let mut damaged = fixture_v14();
        damaged.execute_batch("DROP TRIGGER sleep_periods_immutable;").unwrap();
        assert!(migrate_source(&mut damaged).is_err());
        assert_eq!(user_version(&damaged), SOURCE_SCHEMA_VERSION - 1);
        assert!(!table_sql(&damaged).contains("source"));
        // So is a v14 table whose definitions are intact but whose rows overlap.
        let mut overlapping = fixture_v14();
        let start = V14_SCHEMA.find("CREATE TRIGGER sleep_periods_no_overlap_insert").unwrap();
        let end = start + V14_SCHEMA[start..].find("END;").unwrap() + 4;
        overlapping.execute_batch(&format!("DROP TRIGGER sleep_periods_no_overlap_insert; INSERT INTO sleep_periods(entry_id,started_ms,ended_ms) VALUES(1,{},{}),(1,{},{}); {}", at(0), at(600_000), at(300_000), at(900_000), &V14_SCHEMA[start..end])).unwrap();
        assert!(validate_schema(&overlapping, V14_SCHEMA, true, false).is_err());
        let overlapping_rows = ledger(&overlapping);
        assert!(migrate_source(&mut overlapping).is_err());
        assert_eq!((user_version(&overlapping), ledger(&overlapping)), (SOURCE_SCHEMA_VERSION - 1, overlapping_rows));
        assert!(!table_sql(&overlapping).contains("source"));

        migrate_source(&mut db).unwrap();
        assert_eq!(user_version(&db), SOURCE_SCHEMA_VERSION);
        assert_eq!(ledger(&db), before, "ids, boundaries, flags and decisions are unchanged");
        assert!(list_for_entry(&db, 1).unwrap().iter().all(SleepPeriod::is_sleep));
        assert_eq!(db.query_row("SELECT COUNT(*) FROM sleep_periods WHERE source<>'sleep'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(total(&db), work_before, "the same work time before and after");
        assert!(validate(&db).is_ok());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='sleep_periods_v14'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        // Decisions recorded before v15 stay final, including the automatic one from #62.
        assert!(db.execute("UPDATE sleep_periods SET decision='excluded', decided_ms=1 WHERE id=?1", [short]).is_err());
        assert!(migrate_source(&mut db).is_err(), "a v15 database is not migrated twice");
        // The sleep path behaves as before after the migration: a short observed sleep is counted.
        let open = list_for_entry(&db, 1).unwrap()[4].id;
        record_resume(&mut db, 1, open, at(3_660_000)).unwrap();
        assert_eq!(list_for_entry(&db, 1).unwrap()[4].decision, "auto_included");
    }

    // I11: one timeline per entry for both kinds; pending time of either kind is never work.
    #[test]
    fn idle_and_sleep_share_one_timeline_without_overlap() {
        let mut db = fixture_v15();
        let sleep = record_suspend(&mut db, 1, at(600_000)).unwrap();
        record_resume(&mut db, 1, sleep, at(1_200_000)).unwrap();
        let overlap = |result: rusqlite::Result<usize>| result.unwrap_err().to_string().contains("overlapping sleep periods");
        // Idle over sleep, from either side or open inside it, is refused.
        assert!(overlap(db.execute("INSERT INTO sleep_periods(entry_id,source,started_ms,ended_ms) VALUES(1,'idle',?1,?2)", params![at(0), at(600_001)])));
        assert!(overlap(db.execute("INSERT INTO sleep_periods(entry_id,source,started_ms,ended_ms) VALUES(1,'idle',?1,?2)", params![at(1_199_999), at(1_300_000)])));
        assert!(overlap(db.execute("INSERT INTO sleep_periods(entry_id,source,started_ms) VALUES(1,'idle',?1)", params![at(900_000)])));
        // Touching periods are allowed (half-open intervals).
        let before = insert_idle(&db, 1, at(0), Some(at(600_000)));
        let after = insert_idle(&db, 1, at(1_200_000), None);
        // Sleep over idle is refused too, and two open periods of different kinds cannot exist.
        assert!(overlap(db.execute("INSERT INTO sleep_periods(entry_id,started_ms,ended_ms) VALUES(1,?1,?2)", params![at(100_000), at(200_000)])));
        assert!(db.execute("INSERT INTO sleep_periods(entry_id,started_ms) VALUES(1,?1)", params![at(1_500_000)]).is_err());
        assert_eq!(list_for_entry(&db, 1).unwrap().iter().map(|p| (p.id, p.source.as_str())).collect::<Vec<_>>(), [(before, "idle"), (sleep, "sleep"), (after, "idle")]);
        // 1.5 h minus 10 min idle, 10 min sleep and the open idle clipped at 11:30 (10 min).
        assert_eq!(periods_within_entry(&db, 1, "2026-01-01T10:00:00Z", "2026-01-01T11:30:00Z").unwrap().unwrap().0, 5_400 - 1_800);
        assert!(completed_periods(&db, 1, "2026-01-01T10:00:00Z", "2026-01-01T11:30:00Z").is_err(), "an open period is never projected");
        assert_eq!(close_open_idle(&db, 1, at(1_800_000)).unwrap(), 1);
        resolve(&mut db, 1, before, true, at(1_900_000)).unwrap();
        assert_eq!(completed_periods(&db, 1, "2026-01-01T10:00:00Z", "2026-01-01T11:30:00Z").unwrap().unwrap().0, 5_400 - 1_200);
        assert!(validate(&db).is_ok());
    }

    // I12: the schema and the code keep idle apart from the sleep-only rules.
    #[test]
    fn idle_is_never_auto_included_resumed_or_ended_by_the_user_and_keeps_its_source() {
        let mut db = fixture_v15();
        let idle = insert_idle(&db, 1, at(0), None);
        assert!(record_resume(&mut db, 1, idle, at(60_000)).is_err(), "an idle period is not a resume");
        assert!(record_resume_manual(&mut db, 1, idle, at(60_000), at(120_000)).is_err(), "the user never types an idle end");
        let untouched = list_for_entry(&db, 1).unwrap().remove(0);
        assert_eq!((untouched.ended_ms, untouched.manual_resume), (None, false));
        assert_eq!(close_open_idle(&db, 1, at(60_000)).unwrap(), 1);
        assert!(db.execute("UPDATE sleep_periods SET decision='auto_included', decided_ms=ended_ms WHERE id=?1", [idle]).is_err());
        assert!(db.execute("UPDATE sleep_periods SET source='sleep' WHERE id=?1", [idle]).is_err());
        assert!(db.execute("INSERT INTO sleep_periods(entry_id,source,started_ms) VALUES(1,'away',?1)", [at(100_000)]).is_err());
        // An open idle period clipped at a recovered entry end is user-provided and stays pending.
        let open = insert_idle(&db, 1, at(200_000), None);
        assert_eq!(close_open_at_entry_end(&db, 1, at(260_000)).unwrap(), 1);
        let clipped = list_for_entry(&db, 1).unwrap().remove(1);
        assert_eq!((clipped.id, clipped.ended_ms, clipped.manual_resume, clipped.decision.as_str(), clipped.is_sleep()), (open, Some(at(260_000)), true, "pending", false));
        // Decided once, like sleep.
        resolve(&mut db, 1, idle, false, at(300_000)).unwrap();
        assert!(resolve(&mut db, 1, idle, true, at(300_001)).is_err());
        assert!(validate(&db).is_ok());
        // The validator refuses the same rows even if written with CHECK constraints off.
        let short = insert_idle(&db, 1, at(400_000), Some(at(460_000)));
        db.execute_batch("PRAGMA ignore_check_constraints=ON;").unwrap();
        db.execute("UPDATE sleep_periods SET decision='auto_included', decided_ms=ended_ms WHERE id=?1", [short]).unwrap();
        assert!(validate(&db).is_err(), "'auto_included' is sleep only");
        let mut unknown = fixture_v15();
        unknown.execute_batch("PRAGMA ignore_check_constraints=ON;").unwrap();
        unknown.execute("INSERT INTO sleep_periods(entry_id,source,started_ms,ended_ms) VALUES(1,'away',?1,?2)", params![at(0), at(1_000)]).unwrap();
        assert!(validate(&unknown).is_err(), "an unknown source is refused");
        unknown.execute_batch("PRAGMA ignore_check_constraints=OFF;").unwrap();
        assert!(record_suspend(&mut unknown, 1, at(10_000)).is_ok(), "sleep is still recorded next to it");
    }

    // I08 (O5a, owner decision 25.11.2026): a short sleep that began where an idle period
    // ended stays pending with it, also across a restart; any other short sleep is as in #62.
    #[test]
    fn short_sleep_beginning_at_the_end_of_idle_stays_pending_even_after_a_restart() {
        let mut db = fixture_v15();
        insert_idle(&db, 1, at(0), None);
        // The computer sleeps at 11:12 while the user is away: the idle period ends there.
        let sleep = record_suspend(&mut db, 1, at(720_000)).unwrap();
        let idle = list_for_entry(&db, 1).unwrap().remove(0);
        assert_eq!((idle.ended_ms, idle.manual_resume, idle.decision.as_str(), idle.is_sleep()), (Some(at(720_000)), false, "pending", false));
        // Restart between suspend and resume: the condition is in the database, not in memory.
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("tracker-o5-{}-{stamp}.sqlite3", std::process::id()));
        db.execute("VACUUM INTO ?1", [path.to_str().unwrap()]).unwrap();
        drop(db);
        let mut db = Connection::open(&path).unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        record_resume(&mut db, 1, sleep, at(840_000)).unwrap();
        let periods = list_for_entry(&db, 1).unwrap();
        assert_eq!((periods[1].ended_ms, periods[1].decision.as_str(), decided(&db, sleep)), (Some(at(840_000)), "pending", None));
        // A short sleep not preceded by idle is counted without a question, as before (I09).
        let later = record_suspend(&mut db, 1, at(900_000)).unwrap();
        record_resume(&mut db, 1, later, at(960_000)).unwrap();
        assert_eq!(list_for_entry(&db, 1).unwrap()[2].decision, "auto_included");
        // An idle period that ended before the sleep began (the user had returned) changes nothing.
        insert_idle(&db, 1, at(1_000_000), Some(at(1_100_000)));
        let after_return = record_suspend(&mut db, 1, at(1_200_000)).unwrap();
        record_resume(&mut db, 1, after_return, at(1_260_000)).unwrap();
        assert_eq!(list_for_entry(&db, 1).unwrap()[4].decision, "auto_included");
        assert!(validate(&db).is_ok());
        drop(db);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn suspend_fails_closed_next_to_an_idle_period_it_cannot_end() {
        let mut db = fixture_v15();
        let idle = insert_idle(&db, 1, at(600_000), None);
        // An idle start at or after the suspend time (clock moved back) is not ended: nothing is written.
        assert!(record_suspend(&mut db, 1, at(600_000)).is_err());
        assert!(record_suspend(&mut db, 1, at(500_000)).is_err());
        let periods = list_for_entry(&db, 1).unwrap();
        assert_eq!((periods.len(), periods[0].id, periods[0].ended_ms), (1, idle, None));
        // Before v15 nothing is idle and nothing is closed.
        let legacy = fixture_v14();
        assert_eq!(close_open_idle(&legacy, 1, at(0)).unwrap(), 0);
    }
}
