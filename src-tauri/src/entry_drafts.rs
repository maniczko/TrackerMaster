use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager, State};

use crate::{db_err, locked, ui_preferences::save_preference, Cmd, Shared};

const FORMAT_VERSION: u16 = 1;
const MAX_FILE_BYTES: u64 = 64 * 1024;
const READ_ERROR: &str = "Nie można odczytać szkicu.";
const WRITE_ERROR: &str =
    "Nie udało się zapisać szkicu. Ostatnie zmiany mogą nie przetrwać zamknięcia.";
const STALE_ERROR: &str = "Szkic zmienił się. Otwórz listę szkiców ponownie.";
const INVALID_ERROR: &str = "Szkic ma nieobsługiwany format lub nieprawidłowe dane.";

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftSource {
    entry_id: i64,
    client_id: i64,
    project_id: i64,
    task_id: Option<i64>,
    started_at: String,
    ended_at: String,
    duration_seconds: i64,
    description: String,
    billable: bool,
    time_revision: i64,
    description_revision: i64,
    billing_revision: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftFields {
    // Preserve incomplete input so a crash does not erase the last edit.
    start: String,
    end: String,
    description: String,
    input_time_zone: String,
}

impl DraftFields {
    fn valid(&self) -> bool {
        let is_date_input = |value: &str| {
            value.len() <= 32
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || b"-T:.".contains(&byte))
        };
        is_date_input(&self.start)
            && is_date_input(&self.end)
            && self.description.chars().count() <= 2000
            && (1..=128).contains(&self.input_time_zone.len())
            && self
                .input_time_zone
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"/_+.-".contains(&byte))
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EntryDraft {
    format_version: u16,
    source: DraftSource,
    fields: DraftFields,
    revision: String,
    snapshot_updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftList {
    drafts: Vec<EntryDraft>,
    unreadable: usize,
}

#[derive(Serialize)]
#[serde(tag = "status", content = "source", rename_all = "snake_case")]
pub(super) enum DraftSourceStatus {
    Ready(DraftSource),
    Changed(DraftSource),
    Missing,
}

fn read_source(db: &Connection, entry_id: i64) -> Cmd<Option<DraftSource>> {
    db.query_row(
        "SELECT e.id, p.client_id, e.project_id, e.task_id, e.started_at, e.ended_at,
                e.duration_seconds, COALESCE(d.description, ''), b.entry_id IS NOT NULL,
                COALESCE((SELECT MAX(id) FROM entry_revisions WHERE entry_id=e.id), 0),
                COALESCE((SELECT MAX(id) FROM description_revisions WHERE entry_id=e.id), 0),
                COALESCE((SELECT MAX(id) FROM billing_revisions WHERE entry_id=e.id), 0)
         FROM time_entries e
         JOIN projects p ON p.id=e.project_id
         LEFT JOIN entry_descriptions d ON d.entry_id=e.id
         LEFT JOIN billable_entries b ON b.entry_id=e.id
         WHERE e.id=?1 AND e.ended_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM entry_deletions WHERE entry_id=e.id)",
        [entry_id],
        |row| {
            Ok(DraftSource {
                entry_id: row.get(0)?,
                client_id: row.get(1)?,
                project_id: row.get(2)?,
                task_id: row.get(3)?,
                started_at: row.get(4)?,
                ended_at: row.get(5)?,
                duration_seconds: row.get(6)?,
                description: row.get(7)?,
                billable: row.get(8)?,
                time_revision: row.get(9)?,
                description_revision: row.get(10)?,
                billing_revision: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(db_err)
}

fn source_status(db: &Connection, previous: &DraftSource) -> Cmd<DraftSourceStatus> {
    let Some(current) = read_source(db, previous.entry_id)? else {
        return Ok(DraftSourceStatus::Missing);
    };
    // A restore can reuse an entry ID for a different client or project.
    if current.client_id != previous.client_id || current.project_id != previous.project_id {
        return Ok(DraftSourceStatus::Missing);
    }
    Ok(if current == *previous {
        DraftSourceStatus::Ready(current)
    } else {
        DraftSourceStatus::Changed(current)
    })
}

fn draft_filename(entry_id: i64) -> Cmd<String> {
    if entry_id <= 0 {
        return Err(INVALID_ERROR.into());
    }
    Ok(format!("entry-{entry_id}.json"))
}

fn read_draft(dir: &Path, entry_id: i64) -> Cmd<Option<EntryDraft>> {
    let file = match File::open(dir.join(draft_filename(entry_id)?)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(READ_ERROR.into()),
    };
    let mut content = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|_| READ_ERROR)?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(INVALID_ERROR.into());
    }
    let draft: EntryDraft = serde_json::from_slice(&content).map_err(|_| INVALID_ERROR)?;
    if draft.format_version != FORMAT_VERSION
        || draft.source.entry_id != entry_id
        || !draft.fields.valid()
        || draft.revision.is_empty()
        || chrono::DateTime::parse_from_rfc3339(&draft.snapshot_updated_at).is_err()
    {
        return Err(INVALID_ERROR.into());
    }
    Ok(Some(draft))
}

fn list_drafts(dir: &Path) -> Cmd<DraftList> {
    let mut list = DraftList {
        drafts: Vec::new(),
        unreadable: 0,
    };
    let files = match fs::read_dir(dir) {
        Ok(files) => files,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(list),
        Err(_) => return Err(READ_ERROR.into()),
    };
    for file in files {
        let Ok(file) = file else {
            list.unreadable += 1;
            continue;
        };
        let name = file.file_name();
        let Some(entry_id) = name
            .to_str()
            .and_then(|value| value.strip_prefix("entry-"))
            .and_then(|value| value.strip_suffix(".json"))
            .and_then(|value| value.parse::<i64>().ok())
        else {
            continue;
        };
        if draft_filename(entry_id).as_deref().ok() != name.to_str() {
            list.unreadable += 1;
            continue;
        }
        match read_draft(dir, entry_id) {
            Ok(Some(draft)) => list.drafts.push(draft),
            Ok(None) | Err(_) => list.unreadable += 1,
        }
    }
    list.drafts.sort_by(|a, b| {
        b.snapshot_updated_at
            .cmp(&a.snapshot_updated_at)
            .then(a.source.entry_id.cmp(&b.source.entry_id))
    });
    Ok(list)
}

fn persist_draft(
    dir: &Path,
    source: DraftSource,
    fields: DraftFields,
    expected_revision: Option<&str>,
) -> Cmd<EntryDraft> {
    if !fields.valid() {
        return Err(INVALID_ERROR.into());
    }
    let filename = draft_filename(source.entry_id)?;
    let previous = read_draft(dir, source.entry_id)?;
    if previous.as_ref().map(|draft| draft.revision.as_str()) != expected_revision {
        return Err(STALE_ERROR.into());
    }
    if let Some(previous) = previous {
        if previous.source == source && previous.fields == fields {
            return Ok(previous);
        }
    }
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true);
    let revision = format!("{}-{sequence}-{timestamp}", std::process::id());
    let draft = EntryDraft {
        format_version: FORMAT_VERSION,
        source,
        fields,
        revision,
        snapshot_updated_at: timestamp,
    };
    let data = serde_json::to_string(&draft).map_err(|_| WRITE_ERROR)?;
    if data.len() as u64 > MAX_FILE_BYTES {
        return Err(WRITE_ERROR.into());
    }
    fs::create_dir_all(dir).map_err(|_| WRITE_ERROR)?;
    save_preference(dir, &filename, &data).map_err(|_| WRITE_ERROR)?;
    Ok(draft)
}

fn discard_draft(dir: &Path, entry_id: i64, revision: &str) -> Cmd<()> {
    let Some(draft) = read_draft(dir, entry_id)? else {
        return Ok(());
    };
    if draft.revision != revision {
        return Err(STALE_ERROR.into());
    }
    fs::remove_file(dir.join(draft_filename(entry_id)?))
        .map_err(|_| "Nie udało się odrzucić szkicu.".into())
}

fn draft_directory(app: &AppHandle) -> Cmd<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| READ_ERROR)?
        .join("entry-drafts"))
}

#[tauri::command]
pub(super) fn get_entry_edit_source(state: State<'_, Shared>, entry_id: i64) -> Cmd<DraftSource> {
    let tracker = locked(&state)?;
    read_source(&tracker.db, entry_id)?.ok_or_else(|| "Nie znaleziono zakończonego wpisu.".into())
}

#[tauri::command]
pub(super) fn get_entry_drafts(app: AppHandle, state: State<'_, Shared>) -> Cmd<DraftList> {
    let _tracker = locked(&state)?;
    list_drafts(&draft_directory(&app)?)
}

#[tauri::command]
pub(super) fn save_entry_draft(
    app: AppHandle,
    state: State<'_, Shared>,
    source: DraftSource,
    fields: DraftFields,
    expected_revision: Option<String>,
) -> Cmd<EntryDraft> {
    let tracker = locked(&state)?;
    let dir = draft_directory(&app)?;
    if !matches!(
        source_status(&tracker.db, &source)?,
        DraftSourceStatus::Ready(_)
    ) {
        // Keep recording changes to a previously saved draft even if its
        // original entry was changed or deleted while editing.
        let previous = read_draft(&dir, source.entry_id)?;
        if previous.as_ref().map(|draft| &draft.source) != Some(&source) {
            return Err("Oryginalny wpis zmienił się. Otwórz edycję ponownie.".into());
        }
    }
    persist_draft(&dir, source, fields, expected_revision.as_deref())
}

#[tauri::command]
pub(super) fn check_entry_draft_source(
    app: AppHandle,
    state: State<'_, Shared>,
    entry_id: i64,
    revision: String,
) -> Cmd<DraftSourceStatus> {
    let tracker = locked(&state)?;
    let dir = draft_directory(&app)?;
    let draft = read_draft(&dir, entry_id)?.ok_or(STALE_ERROR)?;
    if draft.revision != revision {
        return Err(STALE_ERROR.into());
    }
    source_status(&tracker.db, &draft.source)
}

#[tauri::command]
pub(super) fn discard_entry_draft(
    app: AppHandle,
    state: State<'_, Shared>,
    entry_id: i64,
    revision: String,
) -> Cmd<()> {
    let _tracker = locked(&state)?;
    discard_draft(&draft_directory(&app)?, entry_id, &revision)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        crate::initialise(&mut db).unwrap();
        db.execute_batch(
            "INSERT INTO clients(id,name) VALUES(1,'Client A'),(2,'Client B');
             INSERT INTO projects(id,client_id,name) VALUES(1,1,'Project A'),(2,2,'Project B');
             INSERT INTO time_entries(id,project_id,started_at,ended_at,duration_seconds) VALUES
               (1,1,'2026-01-01T09:00:00.000Z','2026-01-01T10:00:00.000Z',3600),
               (2,1,'2026-01-01T11:00:00.000Z','2026-01-01T12:00:00.000Z',3600);
             INSERT INTO entry_descriptions VALUES(1,'Confirmed description');",
        )
        .unwrap();
        db
    }

    fn test_directory(label: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tracker-draft-{label}-{}-{stamp}",
            std::process::id()
        ))
    }

    fn fields(description: &str) -> DraftFields {
        DraftFields {
            start: "2026-01-01T09:00:00".into(),
            end: "2026-01-01T10:30:00".into(),
            description: description.into(),
            input_time_zone: "Europe/Warsaw".into(),
        }
    }

    #[test]
    fn restart_recovers_local_drafts_without_changing_the_source_or_other_profile() {
        let db = database();
        let source = read_source(&db, 1).unwrap().unwrap();
        let dir = test_directory("restart");
        let other_dir = test_directory("other-profile");

        let first = persist_draft(&dir, source.clone(), fields("Szkic próbny"), None).unwrap();
        let next = persist_draft(
            &dir,
            source.clone(),
            fields("Drugi szkic"),
            Some(&first.revision),
        )
        .unwrap();
        assert_ne!(first.revision, next.revision);
        assert!(persist_draft(
            &dir,
            source.clone(),
            fields("Stary zapis"),
            Some(&first.revision)
        )
        .is_err());
        assert_eq!(list_drafts(&dir).unwrap().drafts, vec![next.clone()]);
        assert!(list_drafts(&other_dir).unwrap().drafts.is_empty());
        assert_eq!(read_source(&db, 1).unwrap(), Some(source));

        let backup = crate::storage_safety::create_backup(&db, &dir).unwrap();
        assert!(!fs::read(&backup)
            .unwrap()
            .windows("Drugi szkic".len())
            .any(|bytes| bytes == "Drugi szkic".as_bytes()));
        assert!(discard_draft(&dir, 1, &first.revision).is_err());
        discard_draft(&dir, 1, &next.revision).unwrap();
        assert!(list_drafts(&dir).unwrap().drafts.is_empty());
        fs::remove_file(backup).unwrap();
        fs::remove_dir(dir.join("backups")).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn invalid_snapshot_preserves_the_last_durable_snapshot_and_other_drafts() {
        let db = database();
        let first = read_source(&db, 1).unwrap().unwrap();
        let second = read_source(&db, 2).unwrap().unwrap();
        let dir = test_directory("corrupt");
        let draft = persist_draft(&dir, first.clone(), fields("Working copy"), None).unwrap();
        let mut incomplete = fields("Not yet valid as an entry");
        incomplete.end.clear();
        let other = persist_draft(&dir, second, incomplete, None).unwrap();
        let invalid = fields(&"x".repeat(2001));
        assert!(persist_draft(&dir, first.clone(), invalid, Some(&draft.revision)).is_err());
        assert_eq!(read_draft(&dir, 1).unwrap(), Some(draft.clone()));

        let damaged = dir.join("entry-1.json");
        fs::write(&damaged, b"{broken").unwrap();
        assert!(persist_draft(&dir, first, fields("Recovered"), None).is_err());
        let entries = list_drafts(&dir).unwrap();
        assert_eq!(entries.unreadable, 1);
        assert_eq!(entries.drafts, vec![other.clone()]);
        assert_eq!(fs::read(&damaged).unwrap(), b"{broken");
        discard_draft(&dir, 2, &other.revision).unwrap();
        fs::remove_file(damaged).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn detects_source_revisions_tombstones_and_identity_reuse() {
        let db = database();
        let original = read_source(&db, 1).unwrap().unwrap();
        assert!(matches!(
            source_status(&db, &original).unwrap(),
            DraftSourceStatus::Ready(_)
        ));
        db.execute_batch(
            "INSERT INTO description_revisions(entry_id,changed_at,before_description,after_description)
               VALUES(1,'2026-01-01T10:30:00Z','Confirmed description','Changed'),
                     (1,'2026-01-01T10:31:00Z','Changed','Confirmed description');",
        ).unwrap();
        assert!(matches!(
            source_status(&db, &original).unwrap(),
            DraftSourceStatus::Changed(_)
        ));
        db.execute(
            "INSERT INTO entry_deletions VALUES(1,'2026-01-01T12:00:00Z')",
            [],
        )
        .unwrap();
        assert!(matches!(
            source_status(&db, &original).unwrap(),
            DraftSourceStatus::Missing
        ));

        let second = read_source(&db, 2).unwrap().unwrap();
        db.execute("UPDATE time_entries SET project_id=2 WHERE id=2", [])
            .unwrap();
        assert!(matches!(
            source_status(&db, &second).unwrap(),
            DraftSourceStatus::Missing
        ));
    }
}
