use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager, State};

use crate::{db_err, locked, ui_preferences::save_preference, Cmd, Shared, LATEST_SCHEMA_VERSION};

const FORMAT_VERSION: u16 = 1;
const MAX_FILE_BYTES: u64 = 64 * 1024;
const READ_ERROR: &str = "Nie można odczytać szkicu.";
const WRITE_ERROR: &str =
    "Nie udało się zapisać szkicu. Ostatnie zmiany mogą nie przetrwać zamknięcia.";
const STALE_ERROR: &str = "Szkic zmienił się. Otwórz listę szkiców ponownie.";
const INVALID_ERROR: &str = "Szkic ma nieobsługiwany format lub nieprawidłowe dane.";
const CORRECTION: &str = "correction";
const RECOVERED: &str = "recovered_draft_of_deleted_or_missing_entry";

pub(super) fn migrate_resolutions(db: &mut Connection) -> rusqlite::Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(
        "CREATE TABLE entry_database_identity (
            id INTEGER PRIMARY KEY CHECK(id=1),
            value TEXT NOT NULL CHECK(length(value)=32)
        );
        INSERT INTO entry_database_identity(id,value) VALUES(1,lower(hex(randomblob(16))));
        CREATE TABLE entry_draft_resolutions (
            revision TEXT PRIMARY KEY NOT NULL CHECK(length(revision) BETWEEN 1 AND 128),
            source_entry_id INTEGER NOT NULL CHECK(source_entry_id > 0),
            entry_id INTEGER NOT NULL REFERENCES time_entries(id),
            kind TEXT NOT NULL CHECK(
                (kind='correction' AND entry_id=source_entry_id) OR
                (kind='recovered_draft_of_deleted_or_missing_entry' AND entry_id<>source_entry_id)
            ),
            created_at TEXT NOT NULL
        );
        CREATE INDEX entry_draft_resolutions_by_entry ON entry_draft_resolutions(entry_id);",
    )?;
    validate_resolution_schema(&tx)?;
    tx.pragma_update(None, "user_version", LATEST_SCHEMA_VERSION)?;
    tx.commit()
}

pub(super) fn validate_resolution_schema(db: &Connection) -> rusqlite::Result<()> {
    let valid = db.query_row(
        "SELECT (SELECT COUNT(*) FROM entry_database_identity)=1
            AND EXISTS(SELECT 1 FROM entry_database_identity
                       WHERE id=1 AND length(value)=32 AND value NOT GLOB '*[^0-9a-f]*')
            AND EXISTS(SELECT 1 FROM pragma_table_info('entry_draft_resolutions')
                       WHERE name='revision' AND type='TEXT' AND pk=1 AND \"notnull\"=1)
            AND (SELECT COUNT(*) FROM pragma_table_info('entry_draft_resolutions') WHERE pk>0)=1
            AND (SELECT COUNT(*) FROM pragma_table_info('entry_draft_resolutions')
                 WHERE name IN ('source_entry_id','entry_id','kind','created_at') AND \"notnull\"=1)=4
            AND (SELECT COUNT(*) FROM pragma_foreign_key_list('entry_draft_resolutions'))=1
            AND EXISTS (SELECT 1 FROM pragma_foreign_key_list('entry_draft_resolutions')
                        WHERE \"from\"='entry_id' AND \"table\"='time_entries' AND \"to\"='id'
                          AND on_delete='NO ACTION')
            AND NOT EXISTS (SELECT 1 FROM entry_draft_resolutions
                            WHERE length(revision) NOT BETWEEN 1 AND 128 OR source_entry_id<=0
                               OR julianday(created_at) IS NULL
                               OR NOT ((kind='correction' AND entry_id=source_entry_id) OR
                               (kind='recovered_draft_of_deleted_or_missing_entry' AND entry_id<>source_entry_id)))",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !valid {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftRange {
    started_at: String,
    ended_at: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(super) enum DraftApplication {
    Correction {
        base: DraftSource,
        range: Option<DraftRange>,
        description: String,
    },
    NewEntry {
        database_id: String,
        client_id: i64,
        project_id: i64,
        task_id: Option<i64>,
        range: DraftRange,
        description: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EntryDraftOrigin {
    source_entry_id: i64,
    created_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftSource {
    #[serde(default)]
    database_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<DraftTarget>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftTarget {
    database_id: String,
    client_id: Option<i64>,
    project_id: Option<i64>,
    task_id: Option<i64>,
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
            && self.target.as_ref().is_none_or(|target| {
                target.database_id.len() == 32
                    && target
                        .database_id
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
                    && [target.client_id, target.project_id, target.task_id]
                        .into_iter()
                        .flatten()
                        .all(|id| id > 0)
                    && (target.project_id.is_none() || target.client_id.is_some())
                    && (target.task_id.is_none() || target.project_id.is_some())
            })
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
#[serde(
    tag = "status",
    content = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(super) enum DraftSourceStatus {
    Ready(DraftSource),
    Changed(DraftSource),
    Missing { database_id: String },
}

fn read_source(db: &Connection, entry_id: i64) -> Cmd<Option<DraftSource>> {
    db.query_row(
        "SELECT e.id, p.client_id, e.project_id, e.task_id, e.started_at, e.ended_at,
                e.duration_seconds, COALESCE(d.description, ''), b.entry_id IS NOT NULL,
                COALESCE((SELECT MAX(id) FROM entry_revisions WHERE entry_id=e.id), 0),
                COALESCE((SELECT MAX(id) FROM description_revisions WHERE entry_id=e.id), 0),
                COALESCE((SELECT MAX(id) FROM billing_revisions WHERE entry_id=e.id), 0),
                (SELECT value FROM entry_database_identity WHERE id=1)
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
                database_id: row.get(12)?,
            })
        },
    )
    .optional()
    .map_err(db_err)
}

pub(super) fn database_identity(db: &Connection) -> Cmd<String> {
    db.query_row(
        "SELECT value FROM entry_database_identity WHERE id=1",
        [],
        |row| row.get(0),
    )
    .map_err(db_err)
}

fn source_status(db: &Connection, previous: &DraftSource) -> Cmd<DraftSourceStatus> {
    let database_id = database_identity(db)?;
    if database_id != previous.database_id {
        return Ok(DraftSourceStatus::Missing { database_id });
    }
    let Some(current) = read_source(db, previous.entry_id)? else {
        return Ok(DraftSourceStatus::Missing { database_id });
    };
    // A restore can reuse an entry ID for a different client or project.
    if current.client_id != previous.client_id || current.project_id != previous.project_id {
        return Ok(DraftSourceStatus::Missing { database_id });
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
        || !(1..=128).contains(&draft.revision.len())
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
    let tracker = locked(&state)?;
    let mut list = list_drafts(&draft_directory(&app)?)?;
    remove_resolved_from_list(&tracker.db, &mut list)?;
    Ok(list)
}

fn remove_resolved_from_list(db: &Connection, list: &mut DraftList) -> Cmd<()> {
    let mut unresolved = Vec::with_capacity(list.drafts.len());
    for draft in list.drafts.drain(..) {
        if find_resolution(db, draft.source.entry_id, &draft.revision)?.is_none() {
            unresolved.push(draft);
        }
    }
    list.drafts = unresolved;
    Ok(())
}

fn find_resolution(db: &Connection, source_id: i64, revision: &str) -> Cmd<Option<i64>> {
    db.query_row(
        "SELECT entry_id FROM entry_draft_resolutions WHERE source_entry_id=?1 AND revision=?2",
        params![source_id, revision],
        |row| row.get(0),
    )
    .optional()
    .map_err(db_err)
}

fn resolve_draft(
    db: &mut Connection,
    draft: &EntryDraft,
    application: DraftApplication,
    current: DateTime<Utc>,
) -> Cmd<i64> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let origin = draft.source.entry_id;
    if let Some(entry_id) = find_resolution(&tx, origin, &draft.revision)? {
        return Ok(entry_id);
    }
    let changed_at = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    let (entry_id, kind) = match application {
        DraftApplication::Correction {
            base,
            range,
            description,
        } => {
            if base.entry_id != origin
                || base.database_id != draft.source.database_id
                || base.project_id != draft.source.project_id
                || base.client_id != draft.source.client_id
                || !matches!(source_status(&tx, &base)?, DraftSourceStatus::Ready(_))
            {
                return Err("Oryginalny wpis zmienił się. Porównaj go ponownie ze szkicem.".into());
            }
            if let Some(range) = range {
                crate::update_entry_time(
                    &tx,
                    origin,
                    &base.started_at,
                    &base.ended_at,
                    &range.started_at,
                    &range.ended_at,
                    current,
                )?;
            }
            crate::update_description(&tx, origin, &base.description, &description, &changed_at)?;
            (origin, CORRECTION)
        }
        DraftApplication::NewEntry {
            database_id,
            client_id,
            project_id,
            task_id,
            range,
            description,
        } => {
            match source_status(&tx, &draft.source)? {
                DraftSourceStatus::Missing {
                    database_id: current,
                } if current == database_id => {}
                DraftSourceStatus::Missing { .. } => {
                    return Err(
                        "Baza została zmieniona. Ponownie wybierz klienta i projekt.".into(),
                    )
                }
                _ => return Err("Oryginalny wpis jest dostępny. Otwórz ponownie szkic.".into()),
            }
            let owner: Option<i64> = tx
                .query_row(
                    "SELECT client_id FROM projects WHERE id=?1",
                    [project_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if owner != Some(client_id) {
                return Err("Wybierz projekt należący do wybranego klienta.".into());
            }
            let last: i64 = tx
                .query_row("SELECT COALESCE(MAX(id),0) FROM time_entries", [], |row| {
                    row.get(0)
                })
                .map_err(db_err)?;
            let id = last
                .max(origin)
                .checked_add(1)
                .ok_or("Nie można przydzielić nowego numeru wpisu.")?;
            let entry_id = crate::optional_task_migration::insert_manual_in(
                &tx,
                Some(id),
                project_id,
                task_id,
                &range.started_at,
                &range.ended_at,
                current,
                &description,
            )?;
            (entry_id, RECOVERED)
        }
    };
    tx.execute(
        "INSERT INTO entry_draft_resolutions(revision, source_entry_id, entry_id, kind, created_at)
         VALUES(?1,?2,?3,?4,?5)",
        params![draft.revision, origin, entry_id, kind, changed_at],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(entry_id)
}

#[tauri::command]
pub(super) fn apply_entry_draft(
    app: AppHandle,
    state: State<'_, Shared>,
    entry_id: i64,
    revision: String,
    application: DraftApplication,
) -> Cmd<i64> {
    let mut tracker = locked(&state)?;
    let dir = draft_directory(&app)?;
    if let Some(resolved) = find_resolution(&tracker.db, entry_id, &revision)? {
        let _ = discard_draft(&dir, entry_id, &revision);
        return Ok(resolved);
    }
    let draft = read_draft(&dir, entry_id)?.ok_or(STALE_ERROR)?;
    if draft.revision != revision {
        return Err(STALE_ERROR.into());
    }
    let applied = resolve_draft(&mut tracker.db, &draft, application, Utc::now())?;
    // The receipt was committed with the entry. A failed cleanup cannot
    // offer the same draft again or cause a duplicate on retry.
    let _ = discard_draft(&dir, entry_id, &revision);
    Ok(applied)
}

#[tauri::command]
pub(super) fn get_entry_draft_origin(
    state: State<'_, Shared>,
    entry_id: i64,
) -> Cmd<Option<EntryDraftOrigin>> {
    let tracker = locked(&state)?;
    tracker
        .db
        .query_row(
            "SELECT source_entry_id, created_at FROM entry_draft_resolutions
         WHERE entry_id=?1 AND kind=?2 LIMIT 1",
            params![entry_id, RECOVERED],
            |row| {
                Ok(EntryDraftOrigin {
                    source_entry_id: row.get(0)?,
                    created_at: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(db_err)
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
    let previous = read_draft(&dir, source.entry_id)?;
    let mut revision = expected_revision.as_deref();
    if let Some(previous) = &previous {
        if find_resolution(&tracker.db, source.entry_id, &previous.revision)?.is_some() {
            if revision.is_some() {
                return Err(STALE_ERROR.into());
            }
            // A fresh edit can replace an already-resolved copy left after a
            // failed file deletion, but a late write from that edit cannot.
            revision = Some(&previous.revision);
        }
    }
    if !matches!(
        source_status(&tracker.db, &source)?,
        DraftSourceStatus::Ready(_)
    ) {
        // Keep recording changes to a previously saved draft even if its
        // original entry was changed or deleted while editing.
        if previous.as_ref().map(|draft| &draft.source) != Some(&source) {
            return Err("Oryginalny wpis zmienił się. Otwórz edycję ponownie.".into());
        }
    }
    persist_draft(&dir, source, fields, revision)
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
            target: None,
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
        let other_db = database();
        assert!(matches!(
            source_status(&other_db, &original).unwrap(),
            DraftSourceStatus::Missing { .. }
        ));
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
            DraftSourceStatus::Missing { .. }
        ));

        let second = read_source(&db, 2).unwrap().unwrap();
        db.execute("UPDATE time_entries SET project_id=2 WHERE id=2", [])
            .unwrap();
        assert!(matches!(
            source_status(&db, &second).unwrap(),
            DraftSourceStatus::Missing { .. }
        ));
    }

    fn range(end: &str) -> DraftRange {
        DraftRange {
            started_at: "2026-01-01T09:00:00.000Z".into(),
            ended_at: end.into(),
        }
    }

    fn test_now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-02-01T13:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn correction_and_resolution_are_atomic_and_retry_safe() {
        let mut db = database();
        let source = read_source(&db, 1).unwrap().unwrap();
        let dir = test_directory("correct");
        let draft = persist_draft(&dir, source.clone(), fields("Odzyskany opis"), None).unwrap();
        let application = || DraftApplication::Correction {
            base: source.clone(),
            range: Some(range("2026-01-01T10:30:00.000Z")),
            description: "Odzyskany opis".into(),
        };
        db.execute_batch(
            "CREATE TRIGGER reject_resolution BEFORE INSERT ON entry_draft_resolutions
             BEGIN SELECT RAISE(ABORT, 'write failed'); END;",
        )
        .unwrap();
        assert!(resolve_draft(&mut db, &draft, application(), test_now()).is_err());
        assert_eq!(read_source(&db, 1).unwrap(), Some(source.clone()));
        assert_eq!(list_drafts(&dir).unwrap().drafts, vec![draft.clone()]);
        db.execute_batch("DROP TRIGGER reject_resolution").unwrap();

        assert_eq!(
            resolve_draft(&mut db, &draft, application(), test_now()).unwrap(),
            1
        );
        assert_eq!(
            resolve_draft(&mut db, &draft, application(), test_now()).unwrap(),
            1
        );
        let edited = read_source(&db, 1).unwrap().unwrap();
        assert_eq!(edited.description, "Odzyskany opis");
        assert_eq!(edited.duration_seconds, 5400);
        for table in [
            "entry_revisions",
            "description_revisions",
            "entry_draft_resolutions",
        ] {
            let count: i64 = db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 1);
        }
        let mut pending = list_drafts(&dir).unwrap();
        remove_resolved_from_list(&db, &mut pending).unwrap();
        assert!(pending.drafts.is_empty());
        discard_draft(&dir, 1, &draft.revision).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn creating_from_missing_source_uses_new_id_and_preserves_audit_in_backup() {
        let mut db = database();
        let source = read_source(&db, 1).unwrap().unwrap();
        let database_id = source.database_id.clone();
        let dir = test_directory("new");
        let draft = persist_draft(&dir, source, fields("Odzyskany opis"), None).unwrap();
        db.execute_batch(
            "DELETE FROM entry_descriptions WHERE entry_id=1; DELETE FROM time_entries WHERE id=1;",
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(source_status(&db, &draft.source).unwrap()).unwrap(),
            serde_json::json!({ "status": "missing", "source": { "databaseId": &database_id } })
        );
        let application = |target_database: &str, client_id| DraftApplication::NewEntry {
            database_id: target_database.into(),
            client_id,
            project_id: 1,
            task_id: None,
            range: range("2026-01-01T10:30:00.000Z"),
            description: "Odzyskany opis".into(),
        };
        assert!(resolve_draft(&mut db, &draft, application(&database_id, 2), test_now()).is_err());
        assert!(resolve_draft(&mut db, &draft, application("stale", 1), test_now()).is_err());
        assert_eq!(find_resolution(&db, 1, &draft.revision).unwrap(), None);
        let created =
            resolve_draft(&mut db, &draft, application(&database_id, 1), test_now()).unwrap();
        assert_ne!(created, 1);
        assert_eq!(
            resolve_draft(&mut db, &draft, application(&database_id, 1), test_now()).unwrap(),
            created
        );
        assert!(read_source(&db, 1).unwrap().is_none());
        assert_eq!(
            read_source(&db, created).unwrap().unwrap().duration_seconds,
            5400
        );
        let path = crate::storage_safety::create_backup(&db, &dir).unwrap();
        let backup = Connection::open(&path).unwrap();
        let origin: (i64, String) = backup
            .query_row(
                "SELECT source_entry_id, kind FROM entry_draft_resolutions WHERE entry_id=?1",
                [created],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(origin, (1, RECOVERED.into()));
        drop(backup);
        discard_draft(&dir, 1, &draft.revision).unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir.join("backups")).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn version_twelve_is_backed_up_before_creating_resolution_history() {
        let mut db = database();
        let mut original = read_source(&db, 1).unwrap().unwrap();
        db.execute_batch("DROP TABLE entry_draft_resolutions; DROP TABLE entry_database_identity; PRAGMA user_version=12;")
            .unwrap();
        let dir = test_directory("migration");
        crate::initialise_with_backup(&mut db, &dir, true).unwrap();
        assert_eq!(
            db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            LATEST_SCHEMA_VERSION
        );
        let migrated = read_source(&db, 1).unwrap().unwrap();
        assert_ne!(migrated.database_id, original.database_id);
        original.database_id = migrated.database_id.clone();
        assert_eq!(migrated, original);
        let backup_path = fs::read_dir(dir.join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let previous = Connection::open(&backup_path).unwrap();
        assert_eq!(
            previous
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            12
        );
        assert_eq!(
            previous
                .query_row(
                    "SELECT duration_seconds FROM time_entries WHERE id=1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            original.duration_seconds
        );
        drop(previous);
        fs::remove_file(backup_path).unwrap();
        fs::remove_dir(dir.join("backups")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
