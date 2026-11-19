use chrono::{TimeZone, Utc};
use rusqlite::Connection;

#[test]
fn csv_source_isolates_clients_with_identical_display_names() {
    let mut db = Connection::open_in_memory().unwrap();
    crate::initialise(&mut db).unwrap();
    db.execute_batch(
        "INSERT INTO clients(id, name) VALUES (1, 'Wspólny klient'), (2, 'Wspólny klient');
         INSERT INTO projects(id, client_id, name) VALUES (11, 1, 'Wspólny'), (22, 2, 'Wspólny');",
    )
    .unwrap();
    let mut tracker = crate::Tracker { db, running_since: None, restored: false };
    let now = Utc.with_ymd_and_hms(2026, 1, 2, 0, 0, 0).single().unwrap();
    let expected = [
        (1, 11, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", "A only"),
        (2, 22, "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", "B only"),
    ]
    .map(|(client_id, project_id, start, end, marker)| {
        let entry_id = super::insert_manual(&mut tracker, project_id, None, start, end, now, marker).unwrap();
        (client_id, entry_id, marker)
    });

    for (client_id, entry_id, marker) in expected {
        let export = crate::client_export_data(&tracker.db, client_id).unwrap();
        assert_eq!(export.client_id, client_id);
        let entries = export.entries.iter().map(|entry| (entry.id, entry.description.as_str())).collect::<Vec<_>>();
        assert_eq!(entries, vec![(entry_id, marker)]);
    }
}
