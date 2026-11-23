//! DEV-26 (calendar package B): a new entry added from the calendar.
//!
//! The same insert as every manual entry (`insert_manual_in`: range, future and overlap checks, task and
//! archive rules), plus the billing the user chose in the form, all in one transaction. A failed write
//! leaves nothing behind, and a retry of the same range cannot add a second entry (overlap check).
use chrono::{DateTime, Utc};
use rusqlite::{Connection, TransactionBehavior};

pub(crate) fn insert_entry(
    db: &mut Connection,
    project_id: i64,
    task_id: Option<i64>,
    started_at: &str,
    ended_at: &str,
    current: DateTime<Utc>,
    description: &str,
    billable: bool,
) -> crate::Cmd<i64> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(crate::db_err)?;
    let id = crate::optional_task_migration::insert_manual_in(
        &tx, None, project_id, task_id, started_at, ended_at, current, description,
    )?;
    // insert_manual_in applied the project's default; the form's choice replaces it before commit.
    if billable {
        tx.execute("INSERT OR IGNORE INTO billable_entries(entry_id) VALUES(?1)", [id])
    } else {
        tx.execute("DELETE FROM billable_entries WHERE entry_id=?1", [id])
    }
    .map_err(crate::db_err)?;
    tx.commit().map_err(crate::db_err)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        crate::initialise(&mut db).unwrap();
        db.execute_batch(
            "INSERT INTO clients(id,name) VALUES(1,'Client A');
             INSERT INTO projects(id,client_id,name) VALUES(1,1,'Billable'),(2,1,'Not billable');
             INSERT INTO billable_projects(project_id) VALUES(1);
             INSERT INTO time_entries(id,project_id,started_at,ended_at,duration_seconds) VALUES
               (1,1,'2026-01-01T09:00:00.000Z','2026-01-01T10:00:00.000Z',3600);",
        )
        .unwrap();
        db
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-02-01T13:00:00Z").unwrap().with_timezone(&Utc)
    }

    fn count(db: &Connection, sql: &str) -> i64 {
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn billable(db: &Connection, id: i64) -> bool {
        db.query_row("SELECT EXISTS(SELECT 1 FROM billable_entries WHERE entry_id=?1)", [id], |row| row.get(0)).unwrap()
    }

    #[test]
    fn calendar_entry_saves_the_chosen_billing_with_the_entry() {
        let mut db = database();
        let off = insert_entry(&mut db, 1, None, "2026-01-01T10:00:00Z", "2026-01-01T10:30:00Z", now(), "Kalendarz", false).unwrap();
        assert!(!billable(&db, off), "the form's choice replaces the billable project's default");
        let on = insert_entry(&mut db, 2, None, "2026-01-01T10:30:00Z", "2026-01-01T11:00:00Z", now(), "", true).unwrap();
        assert!(billable(&db, on));
        let default = insert_entry(&mut db, 1, None, "2026-01-01T11:00:00Z", "2026-01-01T11:15:00Z", now(), "", true).unwrap();
        assert!(billable(&db, default));
        let row: (String, String, i64, i64) = db
            .query_row("SELECT started_at,ended_at,duration_seconds,manually_resolved FROM time_entries WHERE id=?1", [off], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap();
        assert_eq!(row, ("2026-01-01T10:00:00.000Z".into(), "2026-01-01T10:30:00.000Z".into(), 1800, 1));
        assert_eq!(count(&db, "SELECT COUNT(*) FROM entry_descriptions WHERE description='Kalendarz'"), 1);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM billing_revisions"), 0, "a new entry has no billing history yet");
    }

    #[test]
    fn failed_calendar_entry_changes_nothing_and_one_retry_saves_it_once() {
        let mut db = database();
        // The failure happens after the entry row was inserted: the whole transaction must roll back.
        db.execute_batch(
            "CREATE TRIGGER reject_billing BEFORE DELETE ON billable_entries BEGIN SELECT RAISE(ABORT, 'write failed'); END;",
        )
        .unwrap();
        let add = |db: &mut Connection| insert_entry(db, 1, None, "2026-01-01T10:00:00Z", "2026-01-01T10:30:00Z", now(), "Ponowienie", false);
        assert!(add(&mut db).is_err());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM time_entries"), 1);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM entry_descriptions"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM billable_entries"), 0);
        db.execute_batch("DROP TRIGGER reject_billing").unwrap();

        let id = add(&mut db).unwrap();
        assert!(!billable(&db, id));
        // A second click on "Zapisz" after a success cannot count the same time twice.
        assert_eq!(add(&mut db).unwrap_err(), "Ten czas nakłada się na istniejący pomiar. Popraw godziny przed zapisaniem.");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM time_entries"), 2);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM entry_descriptions WHERE description='Ponowienie'"), 1);
    }

    #[test]
    fn calendar_entry_refuses_future_reversed_and_overlapping_ranges() {
        let mut db = database();
        for (start, end, message) in [
            ("2026-02-01T12:45:00Z", "2026-02-01T13:15:00Z", "Czas zakończenia nie może być w przyszłości."),
            ("2026-01-01T12:00:00Z", "2026-01-01T12:00:00Z", "Koniec musi być późniejszy od początku."),
            ("2026-01-01T09:45:00Z", "2026-01-01T10:15:00Z", "Ten czas nakłada się na istniejący pomiar. Popraw godziny przed zapisaniem."),
        ] {
            assert_eq!(insert_entry(&mut db, 1, None, start, end, now(), "", true).unwrap_err(), message);
        }
        assert_eq!(count(&db, "SELECT COUNT(*) FROM time_entries"), 1);
        // Touching the existing entry is not an overlap.
        insert_entry(&mut db, 1, None, "2026-01-01T08:30:00Z", "2026-01-01T09:00:00Z", now(), "", true).unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM time_entries"), 2);
    }
}
