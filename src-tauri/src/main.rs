#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage_safety;
mod sleep_periods;
mod power_events;
mod optional_task_migration;
mod ui_preferences;
mod entry_drafts;
mod editor_close;
#[cfg(windows)]
mod instance_activation;

const LATEST_SCHEMA_VERSION: i64 = 13;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::{sync::{Arc, Mutex}, time::Instant};
use tauri::{Emitter, Manager, State};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use ui_preferences::ReportScope;

struct RunningClock { since: Instant, power: PowerSample }
#[derive(Clone, Copy)]
struct PowerSample { total_ms: u64, awake_ms: u64 }

#[cfg(windows)]
fn power_sample() -> Cmd<PowerSample> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount64() -> u64;
        fn QueryUnbiasedInterruptTime(time: *mut u64) -> i32;
    }
    let mut awake = 0u64;
    // The Windows counters have different units; the unbiased value is in 100 ns ticks.
    let (total, ok) = unsafe { (GetTickCount64(), QueryUnbiasedInterruptTime(&mut awake)) };
    if ok == 0 { return Err("Nie można odczytać zegara systemu. Pomiar wymaga weryfikacji.".into()); }
    Ok(PowerSample { total_ms: total, awake_ms: awake / 10_000 })
}
#[cfg(not(windows))]
fn power_sample() -> Cmd<PowerSample> { Err("Pomiar wymaga obsługi zegara Windows.".into()) }

fn sleep_or_invalid(start: PowerSample, end: PowerSample) -> bool {
    let Some(total) = end.total_ms.checked_sub(start.total_ms) else { return true; };
    let Some(awake) = end.awake_ms.checked_sub(start.awake_ms) else { return true; };
    // Allow for the resolution of the system clocks and non-simultaneous reads.
    total.abs_diff(awake) > 2_000
}

struct Tracker { db: Connection, running_since: Option<RunningClock>, restored: bool }
#[cfg(windows)]
struct InstanceGuard { _file: std::fs::File }

#[cfg(windows)]
fn lock_instance(dir: &std::path::Path) -> std::io::Result<InstanceGuard> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new().write(true).create(true).truncate(false)
        .share_mode(0).open(dir.join("instance.lock"))?;
    Ok(InstanceGuard { _file: file })
}

#[cfg(windows)]
fn show_start_error(message: &str) {
    #[link(name = "user32")]
    extern "system" { fn MessageBoxW(hwnd: *mut std::ffi::c_void, text: *const u16, caption: *const u16, flags: u32) -> i32; }
    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "TrackerMaster".encode_utf16().chain(Some(0)).collect();
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10); }
}

#[cfg(windows)]
fn confirm_stop_and_exit() -> bool {
    use windows_sys::Win32::UI::Controls::{TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDCBF_CANCEL_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::IDCANCEL;
    const STOP_AND_EXIT: i32 = 100;
    let message: Vec<u16> = "Pomiar nadal trwa. Czy chcesz go zatrzymać i zakończyć aplikację?"
        .encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "TrackerMaster".encode_utf16().chain(Some(0)).collect();
    let stop: Vec<u16> = "Stop i zamknij".encode_utf16().chain(Some(0)).collect();
    let button = TASKDIALOG_BUTTON { nButtonID: STOP_AND_EXIT, pszButtonText: stop.as_ptr() };
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION,
        dwCommonButtons: TDCBF_CANCEL_BUTTON,
        pszWindowTitle: title.as_ptr(),
        pszMainInstruction: message.as_ptr(),
        cButtons: 1,
        pButtons: &button,
        nDefaultButton: IDCANCEL,
        ..Default::default()
    };
    let mut chosen = IDCANCEL;
    let result = unsafe { TaskDialogIndirect(&config, &mut chosen, std::ptr::null_mut(), std::ptr::null_mut()) };
    if result < 0 {
        show_start_error("Nie można wyświetlić potwierdzenia. Aplikacja pozostaje otwarta.");
        return false;
    }
    chosen == STOP_AND_EXIT
}
type Shared = Arc<Mutex<Tracker>>;
const DEFAULT_SHORTCUT: &str = "Ctrl+Shift+Space";
struct HotkeyState { project_id: Option<i64>, task_id: Option<i64>, registered: bool, widget_ready: bool, message: String, shortcut: String }
impl Default for HotkeyState {
    fn default() -> Self { Self { project_id: None, task_id: None, registered: false, widget_ready: false, message: String::new(), shortcut: DEFAULT_SHORTCUT.into() } }
}
type Hotkey = Mutex<HotkeyState>;
struct HotkeyChange(Mutex<()>);
struct QuitDialog(std::sync::atomic::AtomicBool);
#[derive(Default)]
struct RestoreState { sequence: u64, pending: Option<storage_safety::PreparedRestore> }
type Restore = Mutex<RestoreState>;
type Cmd<T> = Result<T, String>;

#[derive(Serialize)]
struct Client { id: i64, name: String, archived: bool }
#[derive(Serialize)]
struct Project { id: i64, client_id: i64, name: String, archived: bool, billable: bool }
#[derive(Serialize)]
struct Task { id: i64, project_id: i64, name: String, archived: bool }
#[derive(Serialize)]
struct Active { id: i64, task_id: Option<i64>, project_id: i64, started_at: String, recovered: bool, uncertain: bool, has_sleep: bool, excluded_sleep_ms: i64, billable: bool, description: String }
#[derive(Serialize)]
struct Entry { id: i64, task_id: Option<i64>, project_id: i64, started_at: String, ended_at: String, duration_seconds: i64, manually_resolved: bool, billable: bool, description: String, #[serde(skip_serializing_if = "Option::is_none")] sleep_periods: Option<Vec<sleep_periods::SleepPeriod>> }
#[derive(Serialize)]
struct DeletedEntry { id: i64, task_id: Option<i64>, project_id: i64, started_at: String, ended_at: String, duration_seconds: i64, deleted_at: String }
#[derive(Serialize)]
struct EntryRevision { id: i64, changed_at: String, before_start: String, before_end: String, before_seconds: i64, after_start: String, after_end: String, after_seconds: i64 }
#[derive(Serialize)]
struct BillingRevision { id: i64, changed_at: String, before_billable: bool, after_billable: bool }
#[derive(Serialize)]
struct DescriptionRevision { id: i64, changed_at: String, before_description: String, after_description: String }
#[derive(Serialize)]
struct Snapshot { clients: Vec<Client>, projects: Vec<Project>, tasks: Vec<Task>, active: Option<Active>, entries: Vec<Entry> }
#[derive(Serialize)]
struct ReportActive { id: i64, task_id: Option<i64>, project_id: i64, started_at: String, ended_at: Option<String>, duration_seconds: Option<i64>, unresolved: bool, billable: bool, description: String, #[serde(skip_serializing_if = "Option::is_none")] sleep_periods: Option<Vec<sleep_periods::SleepPeriod>> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingSleep { id: i64, entry_id: i64, started_ms: i64, ended_ms: Option<i64>, client: String, project: String, task: Option<String>, manual_resume: bool }
#[derive(Serialize)]
struct ReportData { entries: Vec<Entry>, active: Option<ReportActive>, time_zone: String }
#[derive(Serialize)]
struct ExportEntry { id: i64, client: String, project: String, task: String, description: String, started_at: String, ended_at: String, duration_seconds: i64, billable: bool, #[serde(skip_serializing_if = "Option::is_none")] sleep_periods: Option<Vec<sleep_periods::SleepPeriod>> }
#[derive(Serialize)]
struct ExportData { client_id: i64, client: String, time_zone: String, entries: Vec<ExportEntry> }

fn now() -> String { Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true) }
fn valid_name(name: &str) -> Cmd<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err("Nazwa musi mieć od 1 do 200 znaków i nie może zawierać znaków sterujących.".into());
    }
    Ok(name)
}
fn valid_description(description: &str) -> Cmd<&str> {
    if description.chars().count() > 2000 || description.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') {
        return Err("Opis może mieć najwyżej 2000 znaków i nie może zawierać niedozwolonych znaków.".into());
    }
    Ok(description)
}
fn db_err(_: rusqlite::Error) -> String { "Nie udało się zapisać lub odczytać danych lokalnych.".into() }
fn ensure_available(tracker: &Tracker) -> Cmd<()> {
    if tracker.restored { return Err("Kopia została przywrócona. Zamknij aplikację i uruchom ją ponownie.".into()); }
    Ok(())
}
fn locked<'a>(state: &'a State<'_, Shared>) -> Cmd<std::sync::MutexGuard<'a, Tracker>> {
    let guard = state.lock().map_err(|_| "Błąd dostępu do danych lokalnych.".to_string())?;
    ensure_available(&guard)?;
    Ok(guard)
}

// During the transition, v10 entries derive their project from the required
// task; v11 entries store the project directly and may have no task.
fn entry_project_sql(db: &Connection, alias: &str) -> Cmd<String> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(db_err)?;
    match version {
        10 => Ok(format!("(SELECT project_id FROM tasks WHERE id={alias}.task_id)")),
        11..=LATEST_SCHEMA_VERSION => Ok(format!("{alias}.project_id")),
        _ => Err("Nieobsługiwana wersja bazy danych.".into()),
    }
}

// A projection is displayed or finalised only if wall and monotonic clocks
// agree and every detected sleep interval is accounted for, without mutation.
struct ActiveProjection { end: String, seconds: i64, excluded_sleep_ms: i64, periods: Option<Vec<sleep_periods::SleepPeriod>> }
fn active_projection(db: &Connection, clock: Option<&RunningClock>, id: i64, started_at: &str, current: DateTime<Utc>, power: &Cmd<PowerSample>) -> Option<ActiveProjection> {
    let clock = clock?;
    let power = *power.as_ref().ok()?;
    let start = DateTime::parse_from_rfc3339(started_at).ok()?;
    let wall_ms = current.timestamp_millis().checked_sub(start.timestamp_millis())?;
    if wall_ms < 0 { return None; }
    let end = current.to_rfc3339_opts(SecondsFormat::Millis, true);
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).ok()?;
    let sleep = if version >= 12 { sleep_periods::completed_periods(db,id,started_at,&end).ok()? } else { None };
    if let Some((seconds, periods)) = sleep {
        let total = power.total_ms.checked_sub(clock.power.total_ms)?;
        let awake = power.awake_ms.checked_sub(clock.power.awake_ms)?;
        if (wall_ms as u64).abs_diff(total) > 2_000 || awake > total.saturating_add(2_000) { return None; }
        let mut known = 0u64;
        let mut excluded = 0i64;
        for period in &periods {
            let duration = period.ended_ms?.checked_sub(period.started_ms)?;
            known = known.checked_add(u64::try_from(duration).ok()?)?;
            if period.decision != "included" { excluded = excluded.checked_add(duration)?; }
        }
        if known.abs_diff(total.saturating_sub(awake)) > 4_000 { return None; }
        return Some(ActiveProjection { end, seconds, excluded_sleep_ms: excluded, periods: Some(periods) });
    }
    if sleep_or_invalid(clock.power, power) { return None; }
    let wall = wall_ms / 1_000;
    let elapsed = i64::try_from(clock.since.elapsed().as_secs()).ok()?;
    if wall.abs_diff(elapsed) > 2 { return None; }
    Some(ActiveProjection { end, seconds: wall, excluded_sleep_ms: 0, periods: None })
}

fn snapshot(tracker: &Tracker) -> Cmd<Snapshot> {
    let db = &tracker.db;
    let project = entry_project_sql(db, "time_entries")?;
    let clients = db.prepare("SELECT id,name,EXISTS(SELECT 1 FROM client_archives a WHERE a.client_id=clients.id) FROM clients ORDER BY name COLLATE NOCASE,id").map_err(db_err)?
        .query_map([], |r| Ok(Client { id:r.get(0)?, name:r.get(1)?, archived:r.get(2)? })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let projects = db.prepare("SELECT id,client_id,name,archived,EXISTS(SELECT 1 FROM billable_projects b WHERE b.project_id=projects.id) FROM projects ORDER BY name COLLATE NOCASE,id").map_err(db_err)?
        .query_map([], |r| Ok(Project { id:r.get(0)?, client_id:r.get(1)?, name:r.get(2)?, archived:r.get(3)?, billable:r.get(4)? })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let tasks = db.prepare("SELECT id,project_id,name,EXISTS(SELECT 1 FROM task_archives a WHERE a.task_id=tasks.id) FROM tasks ORDER BY name COLLATE NOCASE,id").map_err(db_err)?
        .query_map([], |r| Ok(Task { id:r.get(0)?, project_id:r.get(1)?, name:r.get(2)?, archived:r.get(3)? })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let active = db.query_row(&format!("SELECT id,task_id,started_at,EXISTS(SELECT 1 FROM billable_entries b WHERE b.entry_id=time_entries.id),COALESCE((SELECT description FROM entry_descriptions d WHERE d.entry_id=time_entries.id),''),{project} FROM time_entries WHERE ended_at IS NULL"), [], |r| {
        let id: i64 = r.get(0)?;
        let started_at: String = r.get(2)?;
        let recovered = tracker.running_since.is_none();
        let projection = active_projection(db, tracker.running_since.as_ref(), id, &started_at, Utc::now(), &power_sample());
        let uncertain = !recovered && projection.is_none();
        let has_sleep = has_sleep_periods(db,id).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let excluded_sleep_ms = projection.map(|p| p.excluded_sleep_ms).unwrap_or(0);
        Ok(Active { id, task_id:r.get(1)?, started_at, recovered, uncertain, has_sleep, excluded_sleep_ms, billable:r.get(3)?, description:r.get(4)?, project_id:r.get(5)? })
    }).optional().map_err(db_err)?;
    let entries = db.prepare(&format!("SELECT id,task_id,started_at,ended_at,duration_seconds,manually_resolved,EXISTS(SELECT 1 FROM billable_entries b WHERE b.entry_id=time_entries.id),COALESCE((SELECT description FROM entry_descriptions d WHERE d.entry_id=time_entries.id),''),{project} FROM time_entries WHERE ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id) ORDER BY id DESC LIMIT 500")).map_err(db_err)?
        .query_map([], |r| Ok(Entry { id:r.get(0)?, task_id:r.get(1)?, started_at:r.get(2)?, ended_at:r.get(3)?, duration_seconds:r.get(4)?, manually_resolved:r.get(5)?, billable:r.get(6)?, description:r.get(7)?, project_id:r.get(8)?, sleep_periods:None })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let mut entries = entries;
    enrich_entries_with_sleep(db, &mut entries)?;
    Ok(Snapshot { clients, projects, tasks, active, entries })
}

#[tauri::command]
fn get_snapshot(state: State<'_, Shared>) -> Cmd<Snapshot> {
    let tracker = locked(&state)?;
    snapshot(&tracker)
}

// Apply stored sleep decisions only to the entry that owns them. Any corrupt
// or unfinished boundaries fail closed rather than silently adding work.
fn has_sleep_periods(db: &Connection, entry_id: i64) -> Cmd<bool> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(db_err)?;
    if version < 12 { return Ok(false); }
    db.query_row("SELECT EXISTS(SELECT 1 FROM sleep_periods WHERE entry_id=?1)", [entry_id], |r| r.get(0)).map_err(db_err)
}
fn ensure_no_sleep_periods(db: &Connection, entry_id: i64) -> Cmd<()> {
    if has_sleep_periods(db,entry_id)? { return Err("Wpis zawiera okresy uśpienia. Jego zmiana wymaga pełnej obsługi tych okresów.".into()); }
    Ok(())
}
fn completed_sleep(db: &Connection, id: i64, start: &str, end: &str) -> Cmd<Option<(i64, Vec<sleep_periods::SleepPeriod>)>> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(db_err)?;
    if version < 12 { return Ok(None); }
    sleep_periods::completed_periods(db, id, start, end)
        .map_err(|_| "Nie można bezpiecznie rozliczyć zapisanych okresów uśpienia. Sprawdź dane i kopię.".into())
}
fn enrich_entries_with_sleep(db: &Connection, entries: &mut [Entry]) -> Cmd<()> {
    for entry in entries {
        if let Some((duration, periods)) = completed_sleep(db, entry.id, &entry.started_at, &entry.ended_at)? {
            entry.duration_seconds = duration;
            entry.sleep_periods = Some(periods);
        }
    }
    Ok(())
}

fn validate_report_scope(db: &Connection, scope: ReportScope) -> Cmd<()> {
    scope.validate_ids()?;
    if let Some(client_id) = scope.client_id {
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM clients WHERE id=?1)", [client_id], |r| r.get(0)).map_err(db_err)?;
        if !exists { return Err("Nie istnieje zapisany klient.".into()); }
    }
    if let Some(project_id) = scope.project_id {
        let owner: Option<i64> = db.query_row("SELECT client_id FROM projects WHERE id=?1", [project_id], |r| r.get(0)).optional().map_err(db_err)?;
        if owner.is_none() { return Err("Nie istnieje zapisany projekt.".into()); }
        if owner != scope.client_id { return Err("Zapisany projekt nie należy do wybranego klienta.".into()); }
    }
    if let Some(task_id) = scope.task_id {
        let owner: Option<i64> = db.query_row("SELECT project_id FROM tasks WHERE id=?1", [task_id], |r| r.get(0)).optional().map_err(db_err)?;
        if owner.is_none() { return Err("Nie istnieje zapisane zadanie.".into()); }
        if owner != scope.project_id { return Err("Zapisane zadanie nie należy do wybranego projektu.".into()); }
    }
    Ok(())
}

#[cfg(test)]
fn report_data(tracker: &Tracker, current: DateTime<Utc>, power: Cmd<PowerSample>) -> Cmd<ReportData> {
    report_data_for_scope(tracker, current, power, ReportScope::default())
}

// Include every non-deleted entry in the selected scope. The active interval
// is a projection and is withheld when its clock or sleep state is unresolved.
fn report_data_for_scope(tracker: &Tracker, current: DateTime<Utc>, power: Cmd<PowerSample>, scope: ReportScope) -> Cmd<ReportData> {
    ensure_available(tracker)?;
    validate_report_scope(&tracker.db, scope)?;
    let project = entry_project_sql(&tracker.db, "time_entries")?;
    let filter = format!("(?1 IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id={project} AND p.client_id=?1)) AND (?2 IS NULL OR {project}=?2) AND (?3 IS NULL OR task_id=?3)");
    let args = params![scope.client_id, scope.project_id, scope.task_id];
    let entries = tracker.db.prepare(&format!("SELECT id,task_id,started_at,ended_at,duration_seconds,manually_resolved,EXISTS(SELECT 1 FROM billable_entries b WHERE b.entry_id=time_entries.id),COALESCE((SELECT description FROM entry_descriptions d WHERE d.entry_id=time_entries.id),''),{project} FROM time_entries WHERE {filter} AND ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id) ORDER BY id")).map_err(db_err)?
        .query_map(args, |r| Ok(Entry { id:r.get(0)?, task_id:r.get(1)?, started_at:r.get(2)?, ended_at:r.get(3)?, duration_seconds:r.get(4)?, manually_resolved:r.get(5)?, billable:r.get(6)?, description:r.get(7)?, project_id:r.get(8)?, sleep_periods:None })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let mut entries = entries;
    enrich_entries_with_sleep(&tracker.db, &mut entries)?;
    let row: Option<(i64, Option<i64>, String, bool, String, i64)> = tracker.db.query_row(&format!("SELECT id,task_id,started_at,EXISTS(SELECT 1 FROM billable_entries b WHERE b.entry_id=time_entries.id),COALESCE((SELECT description FROM entry_descriptions d WHERE d.entry_id=time_entries.id),''),{project} FROM time_entries WHERE {filter} AND ended_at IS NULL"), args, |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(db_err)?;
    let active = row.map(|(id, task_id, started_at, billable, description, project_id)| {
        let projection = active_projection(&tracker.db, tracker.running_since.as_ref(), id, &started_at, current, &power);
        let unresolved = projection.is_none();
        let (ended_at, duration_seconds, sleep_periods) = match projection { Some(p) => (Some(p.end), Some(p.seconds), p.periods), None => (None, None, None) };
        ReportActive { id, task_id, project_id, started_at, ended_at, duration_seconds, unresolved, billable, description, sleep_periods }
    });
    let time_zone = tracker.db.query_row("SELECT report_timezone FROM app_settings WHERE id=1", [], |r| r.get(0)).map_err(db_err)?;
    Ok(ReportData { entries, active, time_zone })
}

fn pending_sleep(db: &Connection) -> Cmd<Vec<PendingSleep>> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(db_err)?;
    if version < 12 { return Ok(Vec::new()); }
    let mut stmt = db.prepare("SELECT s.id,s.entry_id,s.started_ms,s.ended_ms,c.name,p.name,t.name,s.manual_resume FROM sleep_periods s JOIN time_entries e ON e.id=s.entry_id JOIN projects p ON p.id=e.project_id JOIN clients c ON c.id=p.client_id LEFT JOIN tasks t ON t.id=e.task_id WHERE s.decision='pending' AND NOT EXISTS(SELECT 1 FROM entry_deletions d WHERE d.entry_id=e.id) ORDER BY s.started_ms,s.id").map_err(db_err)?;
    let rows = stmt.query_map([], |r| Ok(PendingSleep { id:r.get(0)?, entry_id:r.get(1)?, started_ms:r.get(2)?, ended_ms:r.get(3)?, client:r.get(4)?, project:r.get(5)?, task:r.get(6)?, manual_resume:r.get(7)? })).map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

#[tauri::command]
fn get_pending_sleep(state: State<'_, Shared>) -> Cmd<Vec<PendingSleep>> {
    let tracker = locked(&state)?;
    pending_sleep(&tracker.db)
}

#[tauri::command]
fn set_sleep_resume(state: State<'_, Shared>, entry_id: i64, period_id: i64, ended_at: String) -> Cmd<()> {
    let end = DateTime::parse_from_rfc3339(&ended_at).map_err(|_| "Podaj poprawną datę wybudzenia.")?;
    let mut tracker = locked(&state)?;
    sleep_periods::record_resume_manual(&mut tracker.db,entry_id,period_id,end.timestamp_millis(),Utc::now().timestamp_millis())
        .map_err(|_| "Nie można zapisać czasu wybudzenia. Sprawdź zakres i odśwież listę.".into())
}

#[tauri::command]
fn resolve_sleep_period(state: State<'_, Shared>, entry_id: i64, period_id: i64, include: bool) -> Cmd<()> {
    let mut tracker = locked(&state)?;
    sleep_periods::resolve(&mut tracker.db, entry_id, period_id, include, Utc::now().timestamp_millis())
        .map_err(|_| "Nie można zapisać decyzji. Odśwież listę i spróbuj ponownie.".into())
}

#[tauri::command]
fn get_report_data(state: State<'_, Shared>, scope: ReportScope) -> Cmd<ReportData> {
    let tracker = locked(&state)?;
    report_data_for_scope(&tracker, Utc::now(), power_sample(), scope)
}

#[cfg(test)]
fn client_export_data(db: &Connection, client_id: i64) -> Cmd<ExportData> {
    client_export_data_for_scope(db, ReportScope { client_id: Some(client_id), ..ReportScope::default() })
}

// Enforce the same client, project and task restrictions inside SQLite for CSV.
fn client_export_data_for_scope(db: &Connection, scope: ReportScope) -> Cmd<ExportData> {
    let client_id = scope.client_id.ok_or("Wybierz klienta do eksportu.")?;
    validate_report_scope(db, scope)?;
    let client: String = db.query_row("SELECT name FROM clients WHERE id=?1", [client_id], |r| r.get(0)).map_err(db_err)?;
    let time_zone = db.query_row("SELECT report_timezone FROM app_settings WHERE id=1", [], |r| r.get(0)).map_err(db_err)?;
    let project = entry_project_sql(db, "e")?;
    let filter = "p.client_id=?1 AND (?2 IS NULL OR p.id=?2) AND (?3 IS NULL OR e.task_id=?3) AND e.ended_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM entry_deletions x WHERE x.entry_id=e.id)";
    let args = params![client_id, scope.project_id, scope.task_id];
    let mismatch: bool = db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM time_entries e JOIN projects p ON p.id={project} LEFT JOIN tasks t ON t.id=e.task_id WHERE {filter} AND e.task_id IS NOT NULL AND (t.id IS NULL OR t.project_id<>p.id))"), args, |r| r.get(0)).map_err(db_err)?;
    if mismatch { return Err("Nie można wyeksportować danych: zadanie nie pasuje do projektu. Sprawdź bazę danych.".into()); }
    let sql = format!("SELECT e.id,c.name,p.name,COALESCE(t.name,''),COALESCE(d.description,''),e.started_at,e.ended_at,e.duration_seconds,EXISTS(SELECT 1 FROM billable_entries b WHERE b.entry_id=e.id) FROM time_entries e JOIN projects p ON p.id={project} JOIN clients c ON c.id=p.client_id LEFT JOIN tasks t ON t.id=e.task_id LEFT JOIN entry_descriptions d ON d.entry_id=e.id WHERE {filter} ORDER BY e.id");
    let entries = db.prepare(&sql).map_err(db_err)?.query_map(args, |r| Ok(ExportEntry { id:r.get(0)?, client:r.get(1)?, project:r.get(2)?, task:r.get(3)?, description:r.get(4)?, started_at:r.get(5)?, ended_at:r.get(6)?, duration_seconds:r.get(7)?, billable:r.get(8)?, sleep_periods:None })).map_err(db_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let mut entries = entries;
    for entry in &mut entries {
        if let Some((duration, periods)) = completed_sleep(db, entry.id, &entry.started_at, &entry.ended_at)? {
            entry.duration_seconds = duration;
            entry.sleep_periods = Some(periods);
        }
    }
    Ok(ExportData { client_id, client, time_zone, entries })
}

#[tauri::command]
fn get_client_export_data(state: State<'_, Shared>, scope: ReportScope) -> Cmd<ExportData> {
    let tracker = locked(&state)?;
    client_export_data_for_scope(&tracker.db, scope)
}

fn update_report_timezone(db: &Connection, expected: &str, zone: &str) -> Cmd<()> {
    if zone.is_empty() || zone.len() > 128 || zone.trim() != zone ||
        !zone.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'+')) ||
        !(zone == "UTC" || zone.contains('/')) {
        return Err("Nieprawidłowa nazwa strefy czasowej.".into());
    }
    let changed = db.execute("UPDATE app_settings SET report_timezone=?1 WHERE id=1 AND report_timezone=?2", params![zone,expected]).map_err(db_err)?;
    if changed != 1 { return Err("Ustawienie zmieniło się w innym oknie. Odśwież dane i spróbuj ponownie.".into()); }
    Ok(())
}

#[tauri::command]
fn set_report_timezone(state: State<'_, Shared>, expected_time_zone: String, time_zone: String) -> Cmd<()> {
    let tracker = locked(&state)?;
    update_report_timezone(&tracker.db, &expected_time_zone, &time_zone)
}

#[tauri::command]
fn diagnose_database(state: State<'_, Shared>) -> Cmd<storage_safety::DatabaseHealth> {
    let tracker = locked(&state)?;
    storage_safety::diagnose_database(&tracker.db)
        .map_err(|_| "Weryfikacja danych nie powiodła się. Sprawdź integralność bazy i kopię zapasową.".into())
}

#[tauri::command]
fn create_backup(app: tauri::AppHandle, state: State<'_, Shared>) -> Cmd<String> {
    let data_dir = app.path().app_data_dir().map_err(|_| "Nie można ustalić katalogu danych aplikacji.".to_string())?;
    let tracker = locked(&state)?;
    storage_safety::create_backup(&tracker.db, &data_dir)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| "Nie udało się utworzyć ani zweryfikować kopii bazy danych.".into())
}

#[derive(Serialize)]
struct RestorePreview { token: String, health: storage_safety::DatabaseHealth }

#[tauri::command]
fn prepare_backup_restore(state: State<'_, Restore>, path: String) -> Cmd<RestorePreview> {
    let path = std::path::Path::new(path.trim());
    if !path.is_absolute() { return Err("Podaj pełną ścieżkę do pliku kopii.".into()); }
    let prepared = storage_safety::prepare_restore(path)
        .map_err(|_| "Nie można odczytać tej kopii lub jej format jest niezgodny. Bieżące dane nie zostały zmienione.".to_string())?;
    let health = prepared.health.clone();
    let mut state = state.lock().map_err(|_| "Nie można przygotować kopii.".to_string())?;
    state.sequence = state.sequence.checked_add(1).ok_or("Nie można przygotować kolejnej kopii.")?;
    let token = state.sequence.to_string();
    state.pending = Some(prepared);
    Ok(RestorePreview { token, health })
}

#[tauri::command]
fn cancel_backup_restore(state: State<'_, Restore>, token: String) -> Cmd<()> {
    let mut state = state.lock().map_err(|_| "Nie można anulować przygotowania.".to_string())?;
    if state.sequence.to_string() == token { state.pending = None; }
    Ok(())
}

#[tauri::command]
fn apply_backup_restore(app: tauri::AppHandle, state: State<'_, Shared>, restore: State<'_, Restore>, token: String, confirmed: bool) -> Cmd<String> {
    if !confirmed { return Err("Potwierdź przywrócenie kopii.".into()); }
    let data_dir = app.path().app_data_dir().map_err(|_| "Nie można ustalić katalogu danych aplikacji.".to_string())?;
    let mut restore = restore.lock().map_err(|_| "Nie można odczytać przygotowanej kopii.".to_string())?;
    let mut tracker = locked(&state)?;
    apply_prepared_restore(&mut tracker, &mut restore, &token, &data_dir)
}

fn apply_prepared_restore(tracker: &mut Tracker, restore: &mut RestoreState, token: &str, data_dir: &std::path::Path) -> Cmd<String> {
    if restore.sequence.to_string() != token || restore.pending.is_none() { return Err("Przygotowana kopia jest nieaktualna. Sprawdź ją ponownie.".into()); }
    if snapshot(tracker)?.active.is_some() { return Err("Najpierw zakończ lub rozlicz aktywny pomiar.".into()); }
    let prepared = restore.pending.as_ref().ok_or("Nie znaleziono przygotowanej kopii.")?;
    let safety = storage_safety::restore_prepared(&mut tracker.db, prepared, data_dir)
        .map_err(|_| "Nie udało się przywrócić kopii. Sprawdź dane i kopie bezpieczeństwa przed ponowieniem.".to_string())?;
    restore.pending = None;
    tracker.running_since = None;
    tracker.restored = true;
    Ok(safety.to_string_lossy().into_owned())
}

#[tauri::command]
fn exit_after_restore(app: tauri::AppHandle, state: State<'_, Shared>) -> Cmd<()> {
    let tracker = state.lock().map_err(|_| "Błąd dostępu do danych lokalnych.".to_string())?;
    if !tracker.restored { return Err("Nie wykonano przywrócenia kopii.".into()); }
    app.exit(0);
    Ok(())
}

const WIDGET_WIDTH: f64 = 440.0;
const WIDGET_COMPACT_HEIGHT: f64 = 76.0;
const WIDGET_EXPANDED_HEIGHT: f64 = 390.0;

#[tauri::command]
async fn open_widget(app: tauri::AppHandle) -> Cmd<()> {
    if let Some(window) = app.get_webview_window("widget") {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        if let Ok(mut hotkey) = app.state::<Hotkey>().lock() { hotkey.widget_ready = false; }
        let window = tauri::WebviewWindowBuilder::new(&app, "widget", tauri::WebviewUrl::default())
            .title("TrackerMaster — mini timer").inner_size(WIDGET_WIDTH, WIDGET_COMPACT_HEIGHT)
            .decorations(false).resizable(false).build().map_err(|e| e.to_string())?;
        let position_path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("widget-position.txt");
        if let Ok(saved) = std::fs::read_to_string(&position_path) {
            let mut coordinates = saved.split_whitespace().filter_map(|value| value.parse::<i32>().ok());
            if let (Some(x), Some(y), None) = (coordinates.next(), coordinates.next(), coordinates.next()) {
                if let Ok(monitors) = window.available_monitors() {
                    let visible = monitors.iter().any(|monitor| {
                        let origin = monitor.position();
                        let size = monitor.size();
                        i64::from(x) >= i64::from(origin.x) && i64::from(y) >= i64::from(origin.y)
                            && i64::from(x) + 100 <= i64::from(origin.x) + i64::from(size.width)
                            && i64::from(y) + 100 <= i64::from(origin.y) + i64::from(size.height)
                    });
                    if visible { let _ = window.set_position(tauri::PhysicalPosition::new(x, y)); }
                }
            }
        }
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Moved(position) = event {
                let _ = std::fs::write(&position_path, format!("{} {}", position.x, position.y));
            }
        });
    }
    Ok(())
}

#[tauri::command]
async fn widget_panel(app: tauri::AppHandle, expanded: bool) -> Cmd<()> {
    let window = app.get_webview_window("widget").ok_or("Widget nie jest otwarty.")?;
    let height = if expanded { WIDGET_EXPANDED_HEIGHT } else { WIDGET_COMPACT_HEIGHT };
    if expanded {
        if let (Ok(Some(monitor)), Ok(position), Ok(scale)) = (window.current_monitor(), window.outer_position(), window.scale_factor()) {
            let bottom = i64::from(monitor.position().y) + i64::from(monitor.size().height);
            let target_bottom = i64::from(position.y) + (height * scale) as i64;
            if target_bottom > bottom {
                let y = (i64::from(position.y) - (target_bottom - bottom)).max(i64::from(monitor.position().y));
                window.set_position(tauri::PhysicalPosition::new(position.x, y as i32)).map_err(|e| e.to_string())?;
            }
        }
    }
    window.set_size(tauri::LogicalSize::new(WIDGET_WIDTH, height)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn widget_drag(app: tauri::AppHandle) -> Cmd<()> {
    app.get_webview_window("widget").ok_or("Widget nie jest otwarty.")?.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_widget(app: tauri::AppHandle) -> Cmd<()> {
    if let Ok(mut hotkey) = app.state::<Hotkey>().lock() { hotkey.widget_ready = false; }
    app.get_webview_window("widget").ok_or("Widget nie jest otwarty.")?.close().map_err(|e| e.to_string())
}

#[tauri::command]
async fn show_main(app: tauri::AppHandle) -> Cmd<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())
    } else {
        let config = app.config().app.windows.first().ok_or("Brak konfiguracji okna aplikacji.")?;
        tauri::WebviewWindowBuilder::from_config(&app, config).map_err(|e| e.to_string())?
            .build().map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn add_client(db: &Connection, name: &str) -> Cmd<i64> {
    db.execute("INSERT INTO clients(name) VALUES(?1)", [valid_name(name)?]).map_err(db_err)?;
    Ok(db.last_insert_rowid())
}
#[tauri::command]
fn create_client(state: State<'_, Shared>, name: String) -> Cmd<i64> {
    let tracker = locked(&state)?;
    add_client(&tracker.db, &name)
}
fn add_project(db: &Connection, client_id: i64, name: &str) -> Cmd<i64> {
    let name = valid_name(name)?;
    if !db.query_row("SELECT EXISTS(SELECT 1 FROM clients WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM client_archives a WHERE a.client_id=clients.id))", [client_id], |r| r.get::<_, bool>(0)).map_err(db_err)? {
        return Err("Wybierz istniejącego klienta.".into());
    }
    db.execute("INSERT INTO projects(client_id,name) VALUES(?1,?2)", params![client_id,name]).map_err(db_err)?;
    Ok(db.last_insert_rowid())
}
#[tauri::command]
fn create_project(state: State<'_, Shared>, client_id: i64, name: String) -> Cmd<i64> {
    let tracker = locked(&state)?;
    add_project(&tracker.db, client_id, &name)
}
#[tauri::command]
fn create_task(state: State<'_, Shared>, project_id: i64, name: String) -> Cmd<i64> {
    let tracker = locked(&state)?;
    let name = valid_name(&name)?;
    if !tracker.db.query_row("SELECT EXISTS(SELECT 1 FROM projects p WHERE p.id=?1 AND p.archived=0 AND NOT EXISTS (SELECT 1 FROM client_archives a WHERE a.client_id=p.client_id))", [project_id], |r| r.get::<_, bool>(0)).map_err(db_err)? {
        return Err("Wybierz istniejący, niezarchiwizowany projekt.".into());
    }
    tracker.db.execute("INSERT INTO tasks(project_id,name) VALUES(?1,?2)", params![project_id,name]).map_err(db_err)?;
    Ok(tracker.db.last_insert_rowid())
}

fn set_project_billing(db: &mut Connection, project_id: i64, expected: bool, billable: bool) -> Cmd<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let current: Option<bool> = tx.query_row("SELECT EXISTS(SELECT 1 FROM billable_projects b WHERE b.project_id=projects.id) FROM projects WHERE id=?1", [project_id], |r| r.get(0)).optional().map_err(db_err)?;
    if current != Some(expected) { return Err("Projekt zmienił się lub już nie istnieje. Odśwież dane.".into()); }
    if billable { tx.execute("INSERT OR IGNORE INTO billable_projects(project_id) VALUES(?1)", [project_id]).map_err(db_err)?; }
    else { tx.execute("DELETE FROM billable_projects WHERE project_id=?1", [project_id]).map_err(db_err)?; }
    tx.commit().map_err(db_err)
}

fn set_entry_billing(db: &mut Connection, entry_id: i64, expected: bool, billable: bool, changed_at: &str) -> Cmd<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let current: Option<bool> = tx.query_row("SELECT EXISTS(SELECT 1 FROM billable_entries b WHERE b.entry_id=time_entries.id) FROM time_entries WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id)", [entry_id], |r| r.get(0)).optional().map_err(db_err)?;
    if current != Some(expected) { return Err("Wpis zmienił się lub został usunięty. Odśwież dane.".into()); }
    if expected != billable {
        if billable { tx.execute("INSERT INTO billable_entries(entry_id) VALUES(?1)", [entry_id]).map_err(db_err)?; }
        else { tx.execute("DELETE FROM billable_entries WHERE entry_id=?1", [entry_id]).map_err(db_err)?; }
        tx.execute("INSERT INTO billing_revisions(entry_id,changed_at,before_billable,after_billable) VALUES(?1,?2,?3,?4)", params![entry_id,changed_at,expected,billable]).map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

fn set_description(db: &mut Connection, entry_id: i64, expected: &str, description: &str, changed_at: &str) -> Cmd<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    update_description(&tx, entry_id, expected, description, changed_at)?;
    tx.commit().map_err(db_err)
}

fn update_description(db: &rusqlite::Transaction<'_>, entry_id: i64, expected: &str, description: &str, changed_at: &str) -> Cmd<()> {
    let description = valid_description(description)?;
    let current: Option<String> = db.query_row("SELECT COALESCE((SELECT description FROM entry_descriptions d WHERE d.entry_id=time_entries.id),'') FROM time_entries WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id)", [entry_id], |r| r.get(0)).optional().map_err(db_err)?;
    if current.as_deref() != Some(expected) { return Err("Wpis lub opis zmienił się w innym oknie. Odśwież dane.".into()); }
    if expected != description {
        if description.is_empty() { db.execute("DELETE FROM entry_descriptions WHERE entry_id=?1", [entry_id]).map_err(db_err)?; }
        else { db.execute("INSERT INTO entry_descriptions(entry_id,description) VALUES(?1,?2) ON CONFLICT(entry_id) DO UPDATE SET description=excluded.description", params![entry_id,description]).map_err(db_err)?; }
        db.execute("INSERT INTO description_revisions(entry_id,changed_at,before_description,after_description) VALUES(?1,?2,?3,?4)", params![entry_id,changed_at,expected,description]).map_err(db_err)?;
    }
    Ok(())
}

#[tauri::command]
fn set_entry_description(state: State<'_, Shared>, entry_id: i64, expected: String, description: String) -> Cmd<()> {
    let mut tracker = locked(&state)?;
    set_description(&mut tracker.db, entry_id, &expected, &description, &now())
}

#[tauri::command]
fn set_project_billable(state: State<'_, Shared>, project_id: i64, expected: bool, billable: bool) -> Cmd<()> {
    let mut tracker = locked(&state)?;
    set_project_billing(&mut tracker.db, project_id, expected, billable)
}

#[tauri::command]
fn set_entry_billable(state: State<'_, Shared>, entry_id: i64, expected: bool, billable: bool) -> Cmd<()> {
    let mut tracker = locked(&state)?;
    set_entry_billing(&mut tracker.db, entry_id, expected, billable, &now())
}

// Rename only the existing entity: relationships and historical entries keep
// their IDs. Compare the displayed name so stale windows cannot overwrite it.
fn rename_entity(db: &Connection, kind: &str, id: i64, expected: &str, name: &str) -> Cmd<()> {
    let name = valid_name(name)?;
    let sql = match kind {
        "client" => "UPDATE clients SET name=?1 WHERE id=?2 AND name=?3",
        "project" => "UPDATE projects SET name=?1 WHERE id=?2 AND name=?3",
        "task" => "UPDATE tasks SET name=?1 WHERE id=?2 AND name=?3",
        _ => return Err("Nieznany rodzaj pozycji.".into()),
    };
    if db.execute(sql, params![name, id, expected]).map_err(db_err)? != 1 {
        return Err("Pozycja zmieniła się lub już nie istnieje. Odśwież dane i spróbuj ponownie.".into());
    }
    Ok(())
}

#[tauri::command]
fn rename_item(state: State<'_, Shared>, kind: String, id: i64, expected_name: String, name: String) -> Cmd<()> {
    let tracker = locked(&state)?;
    rename_entity(&tracker.db, &kind, id, &expected_name, &name)
}

fn set_project_archived(db: &mut Connection, project_id: i64, archived: bool) -> Cmd<()> {
    let project_column = entry_project_sql(db, "e")?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    if archived && tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM time_entries e WHERE {project_column}=?1 AND e.ended_at IS NULL)"), [project_id], |r| r.get::<_, bool>(0)).map_err(db_err)? {
        return Err("Najpierw zakończ lub rozstrzygnij aktywny pomiar tego projektu.".into());
    }
    if !archived && tx.query_row("SELECT EXISTS(SELECT 1 FROM projects p JOIN client_archives a ON a.client_id=p.client_id WHERE p.id=?1)", [project_id], |r| r.get::<_,bool>(0)).map_err(db_err)? { return Err("Najpierw przywróć klienta, do którego należy ten projekt.".into()); }
    let changed = tx.execute("UPDATE projects SET archived=?1 WHERE id=?2", params![archived, project_id]).map_err(db_err)?;
    if changed == 0 { return Err("Nie znaleziono projektu.".into()); }
    tx.commit().map_err(db_err)
}

fn set_client_archived(db: &mut Connection, client_id: i64, archived: bool) -> Cmd<()> {
    let project_column = entry_project_sql(db, "e")?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    if !tx.query_row("SELECT EXISTS(SELECT 1 FROM clients WHERE id=?1)", [client_id], |r| r.get::<_,bool>(0)).map_err(db_err)? { return Err("Nie znaleziono klienta.".into()); }
    if archived {
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE client_id=?1 AND archived=0)", [client_id], |r| r.get::<_,bool>(0)).map_err(db_err)? { return Err("Klient ma aktywne projekty. Zarchiwizuj je przed archiwizacją klienta.".into()); }
        if tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM time_entries e JOIN projects p ON p.id={project_column} WHERE p.client_id=?1 AND e.ended_at IS NULL)"), [client_id], |r| r.get::<_,bool>(0)).map_err(db_err)? { return Err("Najpierw zakończ lub rozstrzygnij aktywny pomiar klienta.".into()); }
        tx.execute("INSERT OR IGNORE INTO client_archives(client_id) VALUES(?1)", [client_id]).map_err(db_err)?;
    } else { tx.execute("DELETE FROM client_archives WHERE client_id=?1", [client_id]).map_err(db_err)?; }
    tx.commit().map_err(db_err)
}

#[tauri::command]
fn archive_client(state: State<'_, Shared>, client_id: i64, archived: bool) -> Cmd<()> {
    let mut tracker = locked(&state)?;
    set_client_archived(&mut tracker.db, client_id, archived)
}

fn set_task_archived(db: &mut Connection, task_id: i64, archived: bool) -> Cmd<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let parent: Option<(bool,bool)> = tx.query_row("SELECT p.archived, EXISTS(SELECT 1 FROM client_archives a WHERE a.client_id=p.client_id) FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?1", [task_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_err)?;
    let (project_archived, client_archived) = parent.ok_or("Nie znaleziono zadania.")?;
    if archived {
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM time_entries WHERE task_id=?1 AND ended_at IS NULL)", [task_id], |r| r.get::<_,bool>(0)).map_err(db_err)? { return Err("Na tym zadaniu trwa pomiar czasu. Zatrzymaj timer przed archiwizacją.".into()); }
        tx.execute("INSERT OR IGNORE INTO task_archives(task_id) VALUES(?1)", [task_id]).map_err(db_err)?;
    } else {
        if project_archived || client_archived { return Err("Najpierw przywróć projekt i klienta, do których należy to zadanie.".into()); }
        tx.execute("DELETE FROM task_archives WHERE task_id=?1", [task_id]).map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

#[tauri::command]
fn archive_task(state: State<'_, Shared>, task_id: i64, archived: bool) -> Cmd<()> {
    let mut tracker = locked(&state)?;
    set_task_archived(&mut tracker.db, task_id, archived)
}

#[tauri::command]
fn archive_project(state: State<'_, Shared>, project_id: i64, archived: bool) -> Cmd<()> {
    let mut tracker = locked(&state)?;
    set_project_archived(&mut tracker.db, project_id, archived)
}

// A persisted timer surviving a process restart cannot safely infer how much time was worked.
// Reject stop/switch and leave the durable row for manual recovery.
fn close_active(tracker: &mut Tracker, end: &str, next_task: Option<i64>) -> Cmd<()> {
    close_active_with_description(tracker, end, next_task, "")
}

fn close_active_with_description(tracker: &mut Tracker, end: &str, next_task: Option<i64>, description: &str) -> Cmd<()> {
    let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(db_err)?;
    if (11..=LATEST_SCHEMA_VERSION).contains(&version) {
        let active: Option<i64> = tracker.db.query_row("SELECT id FROM time_entries WHERE ended_at IS NULL", [], |r|r.get(0)).optional().map_err(db_err)?;
        let action = match next_task {
            Some(task_id) => {
                let project_id: Option<i64> = tracker.db.query_row("SELECT project_id FROM tasks WHERE id=?1", [task_id], |r|r.get(0)).optional().map_err(db_err)?;
                optional_task_migration::TimerAction::Start { project_id: project_id.ok_or("Nie znaleziono zadania.")?, task_id:Some(task_id), description }
            },
            None => optional_task_migration::TimerAction::Stop,
        };
        return optional_task_migration::transition(tracker,active,end,action);
    }
    change_timer(tracker, end, next_task, description, None)
}

fn change_timer(tracker: &mut Tracker, end: &str, next_task: Option<i64>, description: &str, resume_id: Option<i64>) -> Cmd<()> {
    ensure_available(tracker)?;
    valid_description(description)?;
    let elapsed = tracker.running_since.as_ref().map(|clock| clock.since.elapsed().as_secs() as i64);
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let source: Option<(i64, String, bool)> = if let Some(id) = resume_id {
        Some(tx.query_row("SELECT task_id,COALESCE((SELECT description FROM entry_descriptions d WHERE d.entry_id=e.id),''),EXISTS(SELECT 1 FROM billable_entries b WHERE b.entry_id=e.id) FROM time_entries e WHERE e.id=?1 AND e.ended_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM entry_deletions d WHERE d.entry_id=e.id)", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db_err)?.ok_or("Wpis do wznowienia nie istnieje lub został usunięty.")?)
    } else { None };
    let next_task = source.as_ref().map(|s| s.0).or(next_task);
    let description = source.as_ref().map(|s| s.1.as_str()).unwrap_or(description);
    valid_description(description)?;
    let active: Option<(i64, i64, String)> = tx.query_row("SELECT id,task_id,started_at FROM time_entries WHERE ended_at IS NULL", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db_err)?;
    if let Some((id, active_task, started)) = active {
        let seconds = elapsed.ok_or("Pomiar wymaga ręcznego ustalenia czasu zakończenia.")?;
        let uncertain = match power_sample() {
            Ok(end_power) => sleep_or_invalid(tracker.running_since.as_ref().unwrap().power, end_power),
            Err(_) => true,
        };
        if uncertain {
            drop(tx);
            tracker.running_since = None;
            return Err("Wykryto przerwę w pracy systemu lub błąd zegara. Pomiar wymaga weryfikacji; nie został zakończony.".into());
        }
        if next_task == Some(active_task) && source.is_none() {
            return Ok(());
        }
        let start_dt = DateTime::parse_from_rfc3339(&started).map_err(|_| "Niepoprawny zapis czasu w bazie.")?;
        let end_dt = DateTime::parse_from_rfc3339(end).map_err(|_| "Niepoprawny czas systemowy.")?;
        let wall = end_dt.signed_duration_since(start_dt).num_seconds();
        if wall < 0 || (wall - seconds).abs() > 2 {
            drop(tx);
            tracker.running_since = None;
            return Err("Wykryto zmianę zegara lub przerwę w pracy systemu. Pomiar wymaga weryfikacji; nie został zakończony.".into());
        }
        if end_dt > start_dt {
            if let Err(error) = ensure_no_overlap(&tx, start_dt.with_timezone(&Utc), end_dt.with_timezone(&Utc), Some(id)) {
                drop(tx);
                tracker.running_since = None;
                return Err(format!("{error} Pomiar wymaga weryfikacji; nie został zakończony."));
            }
        }
        tx.execute("UPDATE time_entries SET ended_at=?1,duration_seconds=?2 WHERE id=?3 AND ended_at IS NULL",params![end,seconds,id]).map_err(db_err)?;
    } else if next_task.is_none() {
        return Err("Nie ma aktywnego pomiaru.".into());
    }
    if let Some(task_id) = next_task {
        if !tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?1 AND p.archived=0 AND NOT EXISTS (SELECT 1 FROM client_archives a WHERE a.client_id=p.client_id) AND NOT EXISTS (SELECT 1 FROM task_archives a WHERE a.task_id=t.id))", [task_id], |r|r.get::<_,bool>(0)).map_err(db_err)? {
            return Err("Wybierz istniejące zadanie w niezarchiwizowanym projekcie.".into());
        }
        let start = DateTime::parse_from_rfc3339(end).map_err(|_| "Niepoprawny czas systemowy.")?.with_timezone(&Utc);
        ensure_no_overlap(&tx, start, DateTime::<Utc>::MAX_UTC, None).map_err(|_| "Nie można rozpocząć pomiaru: inny wpis trwa teraz lub znajduje się w przyszłości. Sprawdź zegar i historię.".to_string())?;
        tx.execute("INSERT INTO time_entries(task_id,started_at) VALUES(?1,?2)",params![task_id,end]).map_err(db_err)?;
        let id = tx.last_insert_rowid();
        if let Some((_, _, billable)) = &source {
            if *billable { tx.execute("INSERT INTO billable_entries(entry_id) VALUES(?1)", [id]).map_err(db_err)?; }
        } else {
            tx.execute("INSERT INTO billable_entries(entry_id) SELECT ?1 WHERE EXISTS(SELECT 1 FROM tasks t JOIN billable_projects b ON b.project_id=t.project_id WHERE t.id=?2)", params![id,task_id]).map_err(db_err)?;
        }
        if !description.is_empty() { tx.execute("INSERT INTO entry_descriptions(entry_id,description) VALUES(?1,?2)", params![id,description]).map_err(db_err)?; }
    }
    let next_clock = if next_task.is_some() { Some(RunningClock { since: Instant::now(), power: power_sample()? }) } else { None };
    tx.commit().map_err(db_err)?;
    tracker.running_since = next_clock;
    Ok(())
}

fn resume_saved_entry(tracker: &mut Tracker, source_id: i64, expected_active_id: Option<i64>, at: &str) -> Cmd<()> {
    let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r|r.get(0)).map_err(db_err)?;
    if (11..=LATEST_SCHEMA_VERSION).contains(&version) { return optional_task_migration::transition(tracker,expected_active_id,at,optional_task_migration::TimerAction::Resume { entry_id:source_id }); }
    if snapshot(tracker)?.active.as_ref().map(|entry| entry.id) != expected_active_id { return Err("Pomiar zmienił się w innym oknie. Sprawdź aktualny stan i spróbuj ponownie.".into()); }
    change_timer(tracker, at, None, "", Some(source_id))
}

#[tauri::command]
fn start_project_timer(state: State<'_, Shared>, project_id: i64, task_id: Option<i64>, expected_active_id: Option<i64>, description: Option<String>) -> Cmd<Snapshot> {
    let mut tracker=locked(&state)?;
    optional_task_migration::transition(&mut tracker,expected_active_id,&now(),optional_task_migration::TimerAction::Start { project_id, task_id, description:description.as_deref().unwrap_or("") })?;
    snapshot(&tracker)
}

#[tauri::command]
fn resume_entry(state: State<'_, Shared>, source_id: i64, expected_active_id: Option<i64>) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    resume_saved_entry(&mut tracker, source_id, expected_active_id, &now())?;
    snapshot(&tracker)
}

fn stop_expected_for_exit(tracker: &mut Tracker, expected_id: i64) -> Cmd<()> {
    if snapshot(tracker)?.active.as_ref().map(|entry| entry.id) != Some(expected_id) {
        return Err("Pomiar zmienił się podczas potwierdzania. Sprawdź aktualny stan i spróbuj ponownie.".into());
    }
    close_active(tracker, &now(), None)
}

fn change_timer_if_current(tracker: &mut Tracker, expected_active_id: Option<i64>, next_task: Option<i64>) -> Cmd<()> {
    if snapshot(tracker)?.active.as_ref().map(|entry| entry.id) != expected_active_id {
        return Err("Pomiar zmienił się w innym oknie. Sprawdź aktualny stan i spróbuj ponownie.".into());
    }
    close_active(tracker, &now(), next_task)
}
#[tauri::command]
fn start_timer(state: State<'_, Shared>, task_id: i64, expected_active_id: Option<i64>, description: Option<String>) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    if snapshot(&tracker)?.active.as_ref().map(|entry| entry.id) != expected_active_id { return Err("Pomiar zmienił się w innym oknie. Sprawdź aktualny stan i spróbuj ponownie.".into()); }
    close_active_with_description(&mut tracker, &now(), Some(task_id), description.as_deref().unwrap_or(""))?;
    snapshot(&tracker)
}
#[tauri::command]
fn stop_timer(state: State<'_, Shared>, expected_active_id: i64) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    change_timer_if_current(&mut tracker, Some(expected_active_id), None)?;
    snapshot(&tracker)
}

#[tauri::command]
fn set_shortcut_task(state: State<'_, Hotkey>, project_id: Option<i64>, task_id: Option<i64>) -> Cmd<()> {
    let mut hotkey=state.lock().map_err(|_| "Błąd skrótu.".to_string())?;
    hotkey.project_id = project_id;
    hotkey.task_id = task_id;
    Ok(())
}
#[tauri::command]
fn widget_shortcut_ready(state: State<'_, Hotkey>) -> Cmd<()> {
    let mut hotkey = state.lock().map_err(|_| "Błąd skrótu.".to_string())?;
    hotkey.widget_ready = true;
    if hotkey.registered { hotkey.message.clear(); }
    Ok(())
}
#[derive(Serialize)]
struct ShortcutStatus { registered: bool, message: String, shortcut: String }
#[tauri::command]
fn shortcut_status(state: State<'_, Hotkey>) -> Cmd<ShortcutStatus> {
    let hotkey = state.lock().map_err(|_| "Błąd skrótu.".to_string())?;
    Ok(ShortcutStatus { registered: hotkey.registered, message: hotkey.message.clone(), shortcut: hotkey.shortcut.clone() })
}

fn valid_shortcut(value: &str) -> bool {
    let key = value.strip_prefix("Ctrl+Shift+").or_else(|| value.strip_prefix("Ctrl+Alt+"));
    let Some(key) = key else { return false; };
    let valid_key = key == "Space" || (key.len() == 1 && key.as_bytes()[0].is_ascii_uppercase()) ||
        key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=12).contains(&n) && key == format!("F{n}"));
    valid_key && value.parse::<Shortcut>().is_ok()
}

fn save_shortcut_preference(dir: &std::path::Path, value: &str) -> Cmd<()> {
    if !valid_shortcut(value) { return Err("Nieprawidłowy skrót.".into()); }
    ui_preferences::save_preference(dir, "shortcut.txt", value)
        .map_err(|_| "Nie udało się zapisać ustawienia skrótu.".into())
}

fn replace_shortcut<R, P, U>(old: &str, new: &str, registered: bool, mut register: R, mut persist: P, mut unregister: U) -> Cmd<()>
where R: FnMut(&str) -> Cmd<()>, P: FnMut(&str) -> Cmd<()>, U: FnMut(&str) -> Cmd<()> {
    register(new).map_err(|_| "Ten skrót jest niedostępny lub zajęty. Poprzedni skrót pozostaje bez zmian.".to_string())?;
    if let Err(err) = persist(new) {
        if unregister(new).is_err() { return Err("Nie udało się zapisać ustawienia ani zwolnić nowego skrótu. Uruchom aplikację ponownie i sprawdź ustawienia.".into()); }
        return Err(err);
    }
    if registered && old != new && unregister(old).is_err() {
        let restored = persist(old).is_ok();
        let removed = unregister(new).is_ok();
        return Err(if restored && removed { "Nie udało się zmienić skrótu. Poprzedni pozostał aktywny." } else { "Nie udało się w pełni przywrócić ustawienia skrótu. Uruchom aplikację ponownie i sprawdź ustawienia." }.into());
    }
    Ok(())
}

#[tauri::command]
async fn set_global_shortcut(app: tauri::AppHandle, shortcut: String, expected: String) -> Cmd<ShortcutStatus> {
    if !valid_shortcut(&shortcut) { return Err("Wybierz poprawną kombinację klawiszy.".into()); }
    let change = app.state::<HotkeyChange>();
    let _change = change.0.lock().map_err(|_| "Błąd ustawień skrótu.")?;
    let (old, registered) = {
        let state = app.state::<Hotkey>();
        let hotkey = state.lock().map_err(|_| "Błąd skrótu.")?;
        if hotkey.shortcut != expected { return Err("Ustawienie zmieniło się w innym oknie. Odśwież i spróbuj ponownie.".into()); }
        (hotkey.shortcut.clone(), hotkey.registered)
    };
    if shortcut.ends_with("+F12") && shortcut != old {
        return Err("Klawisz F12 jest zarezerwowany przez system Windows. Wybierz inny klawisz.".into());
    }
    if old == shortcut && registered { return shortcut_status(app.state::<Hotkey>()); }
    let dir = app.path().app_data_dir().map_err(|_| "Nie można ustalić katalogu ustawień.")?;
    replace_shortcut(&old, &shortcut, registered,
        |value| app.global_shortcut().register(value).map_err(|_| "Błąd rejestracji.".into()),
        |value| save_shortcut_preference(&dir, value),
        |value| app.global_shortcut().unregister(value).map_err(|_| "Błąd wyrejestrowania.".into()))?;
    let state = app.state::<Hotkey>();
    let mut hotkey = state.lock().map_err(|_| "Błąd skrótu.")?;
    hotkey.shortcut = shortcut; hotkey.registered = true; hotkey.message.clear();
    Ok(ShortcutStatus { registered: true, message: String::new(), shortcut: hotkey.shortcut.clone() })
}

#[tauri::command]
fn widget_start(state: State<'_, Shared>, task_id: i64, description: Option<String>) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    if snapshot(&tracker)?.active.is_some() { return Err("Pomiar już trwa. Sprawdź aktualny stan.".into()); }
    close_active_with_description(&mut tracker, &now(), Some(task_id), description.as_deref().unwrap_or(""))?;
    snapshot(&tracker)
}

#[tauri::command]
fn widget_project_start(state: State<'_, Shared>, project_id: i64, task_id: Option<i64>, description: Option<String>) -> Cmd<Snapshot> {
    let mut tracker=locked(&state)?;
    optional_task_migration::transition(&mut tracker,None,&now(),optional_task_migration::TimerAction::Start { project_id,task_id,description:description.as_deref().unwrap_or("") })?;
    snapshot(&tracker)
}

#[tauri::command]
fn widget_stop(state: State<'_, Shared>, entry_id: i64) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    if snapshot(&tracker)?.active.as_ref().map(|entry| entry.id) != Some(entry_id) {
        return Err("Pomiar uległ zmianie. Sprawdź aktualny stan.".into());
    }
    close_active(&mut tracker, &now(), None)?;
    snapshot(&tracker)
}

fn resolve_recovered(tracker: &mut Tracker, end: &str, current: DateTime<Utc>) -> Cmd<()> {
    if tracker.running_since.is_some() { return Err("Ten pomiar nadal działa. Użyj przycisku Zatrzymaj.".into()); }
    let end = DateTime::parse_from_rfc3339(end).map_err(|_| "Podaj poprawną datę zakończenia.")?.with_timezone(&Utc);
    if end > current { return Err("Zakończenie nie może być w przyszłości.".into()); }
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let active: Option<(i64, String)> = tx.query_row("SELECT id, started_at FROM time_entries WHERE ended_at IS NULL", [], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_err)?;
    let (id, start_text) = active.ok_or("Nie ma pomiaru do odzyskania.")?;
    let start = DateTime::parse_from_rfc3339(&start_text).map_err(|_| "Niepoprawny zapis czasu w bazie.")?.with_timezone(&Utc);
    if end < start { return Err("Zakończenie nie może być przed rozpoczęciem pomiaru.".into()); }
    if end > start { ensure_no_overlap(&tx, start, end, Some(id))?; }
    let end_text = end.to_rfc3339_opts(SecondsFormat::Millis, true);
    let seconds = if has_sleep_periods(&tx,id)? {
        sleep_periods::completed_periods(&tx,id,&start_text,&end_text).map_err(|_| "Najpierw ustal prawidłowy koniec każdego okresu uśpienia; nie może on wypadać po końcu pomiaru.")?.ok_or("Brakuje danych okresu uśpienia.")?.0
    } else { (end - start).num_seconds() };
    tx.execute("UPDATE time_entries SET ended_at=?1,duration_seconds=?2,manually_resolved=1 WHERE id=?3 AND ended_at IS NULL", params![end_text,seconds,id]).map_err(db_err)?;
    tx.commit().map_err(db_err)
}

#[tauri::command]
fn recover_timer(state: State<'_, Shared>, ended_at: String, expected_active_id: i64) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    if snapshot(&tracker)?.active.as_ref().map(|entry| entry.id) != Some(expected_active_id) {
        return Err("Pomiar zmienił się w innym oknie. Sprawdź aktualny stan i spróbuj ponownie.".into());
    }
    resolve_recovered(&mut tracker, &ended_at, Utc::now())?;
    snapshot(&tracker)
}

fn parse_manual_range(started_at: &str, ended_at: &str, current: DateTime<Utc>) -> Cmd<(DateTime<Utc>, DateTime<Utc>)> {
    let start = DateTime::parse_from_rfc3339(started_at).map_err(|_| "Podaj poprawny czas rozpoczęcia.")?.with_timezone(&Utc);
    let end = DateTime::parse_from_rfc3339(ended_at).map_err(|_| "Podaj poprawny czas zakończenia.")?.with_timezone(&Utc);
    if start.timestamp_subsec_nanos() != 0 || end.timestamp_subsec_nanos() != 0 {
        return Err("Podaj czas z dokładnością do pełnej sekundy.".into());
    }
    if end <= start { return Err("Koniec musi być późniejszy od początku.".into()); }
    if end > current { return Err("Czas zakończenia nie może być w przyszłości.".into()); }
    Ok((start, end))
}

fn ensure_no_overlap(db: &Connection, start: DateTime<Utc>, end: DateTime<Utc>, exclude_id: Option<i64>) -> Cmd<()> {
    let mut stmt = db.prepare("SELECT id,started_at,ended_at FROM time_entries WHERE NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id)").map_err(db_err)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))).map_err(db_err)?;
    for row in rows {
        let (id, other_start, other_end) = row.map_err(db_err)?;
        if Some(id) == exclude_id { continue; }
        let other_start = DateTime::parse_from_rfc3339(&other_start).map_err(|_| "Nie można zweryfikować istniejącego wpisu. Zmiany nie zostały zapisane.")?.with_timezone(&Utc);
        let other_end = other_end.map(|value| DateTime::parse_from_rfc3339(&value).map(|v| v.with_timezone(&Utc))).transpose()
            .map_err(|_| "Nie można zweryfikować istniejącego wpisu. Zmiany nie zostały zapisane.")?;
        if other_end.is_some_and(|value| value < other_start) { return Err("Nie można zweryfikować istniejącego wpisu. Zmiany nie zostały zapisane.".into()); }
        if other_end == Some(other_start) { continue; }
        if other_start < end && other_end.map_or(true, |value| value > start) {
            return Err("Ten czas nakłada się na istniejący pomiar. Popraw godziny przed zapisaniem.".into());
        }
    }
    Ok(())
}

fn add_manual_entry(tracker: &mut Tracker, task_id: i64, started_at: &str, ended_at: &str, current: DateTime<Utc>) -> Cmd<i64> {
    add_manual_entry_with_description(tracker, task_id, started_at, ended_at, current, "")
}

fn add_manual_entry_with_description(tracker: &mut Tracker, task_id: i64, started_at: &str, ended_at: &str, current: DateTime<Utc>, description: &str) -> Cmd<i64> {
    let version: i64=tracker.db.pragma_query_value(None,"user_version",|r|r.get(0)).map_err(db_err)?;
    if (11..=LATEST_SCHEMA_VERSION).contains(&version) {
        let project_id: Option<i64>=tracker.db.query_row("SELECT project_id FROM tasks WHERE id=?1",[task_id],|r|r.get(0)).optional().map_err(db_err)?;
        return optional_task_migration::insert_manual(tracker,project_id.ok_or("Nie znaleziono zadania.")?,Some(task_id),started_at,ended_at,current,description);
    }
    let description = valid_description(description)?;
    let (start, end) = parse_manual_range(started_at, ended_at, current)?;
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let valid_task = tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?1 AND p.archived=0 AND NOT EXISTS (SELECT 1 FROM client_archives a WHERE a.client_id=p.client_id) AND NOT EXISTS (SELECT 1 FROM task_archives a WHERE a.task_id=t.id))", [task_id], |r| r.get::<_, bool>(0)).map_err(db_err)?;
    if !valid_task { return Err("Wybierz zadanie w aktywnym projekcie.".into()); }
    ensure_no_overlap(&tx, start, end, None)?;
    let start_text = start.to_rfc3339_opts(SecondsFormat::Millis, true);
    let end_text = end.to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds,manually_resolved) VALUES(?1,?2,?3,?4,1)", params![task_id,start_text,end_text,(end-start).num_seconds()]).map_err(db_err)?;
    let id = tx.last_insert_rowid();
    tx.execute("INSERT INTO billable_entries(entry_id) SELECT ?1 WHERE EXISTS(SELECT 1 FROM tasks t JOIN billable_projects b ON b.project_id=t.project_id WHERE t.id=?2)", params![id,task_id]).map_err(db_err)?;
    if !description.is_empty() { tx.execute("INSERT INTO entry_descriptions(entry_id,description) VALUES(?1,?2)", params![id,description]).map_err(db_err)?; }
    tx.commit().map_err(db_err)?;
    Ok(id)
}

fn correct_entry(tracker: &mut Tracker, entry_id: i64, expected_start: &str, expected_end: &str, started_at: &str, ended_at: &str, current: DateTime<Utc>) -> Cmd<()> {
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    update_entry_time(&tx, entry_id, expected_start, expected_end, started_at, ended_at, current)?;
    tx.commit().map_err(db_err)
}

fn update_entry_time(db: &rusqlite::Transaction<'_>, entry_id: i64, expected_start: &str, expected_end: &str, started_at: &str, ended_at: &str, current: DateTime<Utc>) -> Cmd<()> {
    let (start, end) = parse_manual_range(started_at, ended_at, current)?;
    let previous: Option<(String, String, i64)> = db.query_row("SELECT started_at,ended_at,duration_seconds FROM time_entries WHERE id=?1 AND ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id)", [entry_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db_err)?;
    let (old_start, old_end, old_seconds) = previous.ok_or("Nie znaleziono zakończonego wpisu.")?;
    ensure_no_sleep_periods(db, entry_id)?;
    if old_start != expected_start || old_end != expected_end { return Err("Wpis zmienił się w innym oknie. Odśwież dane przed korektą.".into()); }
    ensure_no_overlap(db, start, end, Some(entry_id))?;
    let new_start = start.to_rfc3339_opts(SecondsFormat::Millis, true);
    let new_end = end.to_rfc3339_opts(SecondsFormat::Millis, true);
    let seconds = (end - start).num_seconds();
    if old_start == new_start && old_end == new_end { return Ok(()); }
    db.execute("INSERT INTO entry_revisions(entry_id,changed_at,before_start,before_end,before_seconds,after_start,after_end,after_seconds) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![entry_id,current.to_rfc3339_opts(SecondsFormat::Millis, true),old_start,old_end,old_seconds,new_start,new_end,seconds]).map_err(db_err)?;
    db.execute("UPDATE time_entries SET started_at=?1,ended_at=?2,duration_seconds=?3,manually_resolved=1 WHERE id=?4", params![new_start,new_end,seconds,entry_id]).map_err(db_err)?;
    Ok(())
}

#[tauri::command]
fn edit_time_entry(state: State<'_, Shared>, entry_id: i64, expected_start: String, expected_end: String, started_at: String, ended_at: String) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    correct_entry(&mut tracker, entry_id, &expected_start, &expected_end, &started_at, &ended_at, Utc::now())?;
    snapshot(&tracker)
}

#[tauri::command]
fn entry_revisions(state: State<'_, Shared>, entry_id: i64) -> Cmd<Vec<EntryRevision>> {
    let tracker = locked(&state)?;
    let mut stmt = tracker.db.prepare("SELECT id,changed_at,before_start,before_end,before_seconds,after_start,after_end,after_seconds FROM entry_revisions WHERE entry_id=?1 ORDER BY id DESC").map_err(db_err)?;
    let revisions = stmt.query_map([entry_id], |r| Ok(EntryRevision { id:r.get(0)?,changed_at:r.get(1)?,before_start:r.get(2)?,before_end:r.get(3)?,before_seconds:r.get(4)?,after_start:r.get(5)?,after_end:r.get(6)?,after_seconds:r.get(7)? })).map_err(db_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    Ok(revisions)
}

#[tauri::command]
fn billing_revisions(state: State<'_, Shared>, entry_id: i64) -> Cmd<Vec<BillingRevision>> {
    let tracker = locked(&state)?;
    let mut stmt = tracker.db.prepare("SELECT id,changed_at,before_billable,after_billable FROM billing_revisions WHERE entry_id=?1 ORDER BY id DESC").map_err(db_err)?;
    let revisions = stmt.query_map([entry_id], |r| Ok(BillingRevision { id:r.get(0)?, changed_at:r.get(1)?, before_billable:r.get(2)?, after_billable:r.get(3)? })).map_err(db_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    Ok(revisions)
}

#[tauri::command]
fn description_revisions(state: State<'_, Shared>, entry_id: i64) -> Cmd<Vec<DescriptionRevision>> {
    let tracker = locked(&state)?;
    let mut stmt = tracker.db.prepare("SELECT id,changed_at,before_description,after_description FROM description_revisions WHERE entry_id=?1 ORDER BY id DESC").map_err(db_err)?;
    let revisions = stmt.query_map([entry_id], |r| Ok(DescriptionRevision { id:r.get(0)?, changed_at:r.get(1)?, before_description:r.get(2)?, after_description:r.get(3)? })).map_err(db_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    Ok(revisions)
}

fn mark_entry_deleted(tracker: &mut Tracker, entry_id: i64, expected_start: &str, expected_end: &str, deleted_at: &str) -> Cmd<()> {
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let entry: Option<(String, String)> = tx.query_row("SELECT started_at,ended_at FROM time_entries WHERE id=?1 AND ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id)", [entry_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_err)?;
    let (start, end) = entry.ok_or("Nie znaleziono zakończonego wpisu lub wpis został już usunięty.")?;
    ensure_no_sleep_periods(&tx, entry_id)?;
    if start != expected_start || end != expected_end { return Err("Wpis zmienił się w innym oknie. Odśwież dane przed usunięciem.".into()); }
    tx.execute("INSERT INTO entry_deletions(entry_id,deleted_at) VALUES(?1,?2)", params![entry_id,deleted_at]).map_err(db_err)?;
    tx.commit().map_err(db_err)
}

#[tauri::command]
fn delete_time_entry(state: State<'_, Shared>, entry_id: i64, expected_start: String, expected_end: String) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    mark_entry_deleted(&mut tracker, entry_id, &expected_start, &expected_end, &now())?;
    snapshot(&tracker)
}

#[tauri::command]
fn deleted_entries(state: State<'_, Shared>) -> Cmd<Vec<DeletedEntry>> {
    let tracker = locked(&state)?;
    let project = entry_project_sql(&tracker.db, "e")?;
    let mut stmt = tracker.db.prepare(&format!("SELECT e.id,e.task_id,e.started_at,e.ended_at,e.duration_seconds,d.deleted_at,{project} FROM entry_deletions d JOIN time_entries e ON e.id=d.entry_id ORDER BY d.deleted_at DESC,e.id DESC LIMIT 500")).map_err(db_err)?;
    let entries = stmt.query_map([], |r| Ok(DeletedEntry { id:r.get(0)?,task_id:r.get(1)?,started_at:r.get(2)?,ended_at:r.get(3)?,duration_seconds:r.get(4)?,deleted_at:r.get(5)?,project_id:r.get(6)? })).map_err(db_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    Ok(entries)
}

#[tauri::command]
fn create_manual_entry(state: State<'_, Shared>, task_id: i64, started_at: String, ended_at: String, description: Option<String>) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    add_manual_entry_with_description(&mut tracker, task_id, &started_at, &ended_at, Utc::now(), description.as_deref().unwrap_or(""))?;
    snapshot(&tracker)
}

#[tauri::command]
fn create_project_manual_entry(state: State<'_, Shared>, project_id: i64, task_id: Option<i64>, started_at: String, ended_at: String, description: Option<String>) -> Cmd<Snapshot> {
    let mut tracker=locked(&state)?;
    optional_task_migration::insert_manual(&mut tracker,project_id,task_id,&started_at,&ended_at,Utc::now(),description.as_deref().unwrap_or(""))?;
    snapshot(&tracker)
}

fn validate_schema(db: &Connection) -> rusqlite::Result<()> {
    for query in [
        "SELECT id, name FROM clients LIMIT 0",
        "SELECT id, client_id, name, archived FROM projects LIMIT 0",
        "SELECT id, project_id, name FROM tasks LIMIT 0",
        "SELECT id, task_id, started_at, ended_at, duration_seconds, manually_resolved FROM time_entries LIMIT 0",
    ] {
        db.prepare(query)?;
    }
    for (table, from, target, to) in [
        ("projects", "client_id", "clients", "id"),
        ("tasks", "project_id", "projects", "id"),
        ("time_entries", "task_id", "tasks", "id"),
    ] {
        let found = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list(?1) WHERE \"from\"=?2 AND \"table\"=?3 AND \"to\"=?4)",
            params![table, from, target, to], |row| row.get::<_, bool>(0),
        )?;
        if !found { return Err(rusqlite::Error::InvalidQuery); }
    }
    if db.prepare("PRAGMA foreign_key_check")?.query([])?.next()?.is_some() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    storage_safety::validate_timer_index(db)?;
    Ok(())
}

fn validate_revisions_schema(db: &Connection) -> rusqlite::Result<()> {
    db.prepare("SELECT id,entry_id,changed_at,before_start,before_end,before_seconds,after_start,after_end,after_seconds FROM entry_revisions LIMIT 0")?;
    let found = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('entry_revisions') WHERE \"from\"='entry_id' AND \"table\"='time_entries' AND \"to\"='id')", [], |row| row.get::<_, bool>(0))?;
    if !found { return Err(rusqlite::Error::InvalidQuery); }
    Ok(())
}

fn validate_deletions_schema(db: &Connection) -> rusqlite::Result<()> {
    db.prepare("SELECT entry_id,deleted_at FROM entry_deletions LIMIT 0")?;
    let fk_ok = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('entry_deletions') WHERE \"from\"='entry_id' AND \"table\"='time_entries' AND \"to\"='id')", [], |row| row.get::<_, bool>(0))?;
    let key_ok = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('entry_deletions') WHERE name='entry_id' AND UPPER(type)='INTEGER' AND pk=1) AND (SELECT COUNT(*) FROM pragma_table_info('entry_deletions') WHERE pk>0)=1 AND EXISTS(SELECT 1 FROM pragma_table_info('entry_deletions') WHERE name='deleted_at' AND \"notnull\"=1)", [], |row| row.get::<_, bool>(0))?;
    let active_deleted = db.query_row("SELECT EXISTS(SELECT 1 FROM entry_deletions d JOIN time_entries e ON e.id=d.entry_id WHERE e.ended_at IS NULL)", [], |row| row.get::<_, bool>(0))?;
    if !fk_ok || !key_ok || active_deleted { return Err(rusqlite::Error::InvalidQuery); }
    Ok(())
}

fn validate_settings_schema(db: &Connection) -> rusqlite::Result<()> {
    let key_ok = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('app_settings') WHERE name='id' AND UPPER(type)='INTEGER' AND pk=1) AND (SELECT COUNT(*) FROM pragma_table_info('app_settings') WHERE pk>0)=1 AND EXISTS(SELECT 1 FROM pragma_table_info('app_settings') WHERE name='report_timezone' AND UPPER(type)='TEXT' AND \"notnull\"=1)", [], |r| r.get::<_,bool>(0))?;
    let row_ok = db.query_row("SELECT COUNT(*)=1 AND COALESCE(MIN(id),0)=1 AND COALESCE(LENGTH(MIN(report_timezone)),0) BETWEEN 1 AND 128 FROM app_settings", [], |r| r.get::<_,bool>(0))?;
    if !key_ok || !row_ok { return Err(rusqlite::Error::InvalidQuery); }
    Ok(())
}

fn validate_client_archives_schema(db: &Connection) -> rusqlite::Result<()> {
    let fk = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('client_archives') WHERE \"from\"='client_id' AND \"table\"='clients' AND \"to\"='id')", [], |r| r.get::<_,bool>(0))?;
    let pk = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('client_archives') WHERE name='client_id' AND UPPER(type)='INTEGER' AND pk=1) AND (SELECT COUNT(*) FROM pragma_table_info('client_archives') WHERE pk>0)=1", [], |r| r.get::<_,bool>(0))?;
    let conflict = db.query_row("SELECT EXISTS(SELECT 1 FROM client_archives a JOIN projects p ON p.client_id=a.client_id WHERE p.archived=0)", [], |r| r.get::<_,bool>(0))?;
    let active = db.query_row("SELECT EXISTS(SELECT 1 FROM client_archives a JOIN projects p ON p.client_id=a.client_id JOIN tasks t ON t.project_id=p.id JOIN time_entries e ON e.task_id=t.id WHERE e.ended_at IS NULL)", [], |r| r.get::<_,bool>(0))?;
    if !fk || !pk || conflict || active { return Err(rusqlite::Error::InvalidQuery); }
    Ok(())
}

fn validate_project_timer_activity(db: &Connection) -> rusqlite::Result<()> {
    let invalid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM time_entries e JOIN projects p ON p.id=e.project_id WHERE e.ended_at IS NULL AND (p.archived=1 OR EXISTS(SELECT 1 FROM client_archives c WHERE c.client_id=p.client_id)))", [], |r| r.get(0))?;
    if invalid { return Err(rusqlite::Error::InvalidQuery); }
    Ok(())
}

fn validate_billing_schema(db: &Connection) -> rusqlite::Result<()> {
    for (table, column, target) in [("billable_projects", "project_id", "projects"), ("billable_entries", "entry_id", "time_entries")] {
        let valid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2 AND UPPER(type)='INTEGER' AND pk=1) AND (SELECT COUNT(*) FROM pragma_table_info(?1) WHERE pk>0)=1 AND EXISTS(SELECT 1 FROM pragma_foreign_key_list(?1) WHERE \"from\"=?2 AND \"table\"=?3 AND \"to\"='id')", params![table,column,target], |r| r.get(0))?;
        if !valid { return Err(rusqlite::Error::InvalidQuery); }
    }
    db.prepare("SELECT id,entry_id,changed_at,before_billable,after_billable FROM billing_revisions LIMIT 0")?;
    let fk: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('billing_revisions') WHERE \"from\"='entry_id' AND \"table\"='time_entries' AND \"to\"='id')", [], |r| r.get(0))?;
    let columns: bool = db.query_row("SELECT (SELECT COUNT(*) FROM pragma_table_info('billing_revisions') WHERE name IN ('entry_id','changed_at','before_billable','after_billable') AND \"notnull\"=1)=4 AND EXISTS(SELECT 1 FROM pragma_table_info('billing_revisions') WHERE name='id' AND UPPER(type)='INTEGER' AND pk=1) AND (SELECT COUNT(*) FROM pragma_table_info('billing_revisions') WHERE pk>0)=1", [], |r| r.get(0))?;
    let invalid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM billing_revisions WHERE before_billable NOT IN (0,1) OR after_billable NOT IN (0,1) OR before_billable=after_billable)", [], |r| r.get(0))?;
    if !fk || !columns || invalid { return Err(rusqlite::Error::InvalidQuery); }
    Ok(())
}

fn validate_task_archives_schema(db: &Connection) -> rusqlite::Result<()> {
    let valid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('task_archives') WHERE name='task_id' AND UPPER(type)='INTEGER' AND pk=1) AND (SELECT COUNT(*) FROM pragma_table_info('task_archives') WHERE pk>0)=1 AND EXISTS(SELECT 1 FROM pragma_foreign_key_list('task_archives') WHERE \"from\"='task_id' AND \"table\"='tasks' AND \"to\"='id')", [], |r| r.get(0))?;
    let active: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM task_archives a JOIN time_entries e ON e.task_id=a.task_id WHERE e.ended_at IS NULL)", [], |r| r.get(0))?;
    if !valid || active { return Err(rusqlite::Error::InvalidQuery); }
    Ok(())
}

fn validate_description_schema(db: &Connection) -> rusqlite::Result<()> {
    db.prepare("SELECT entry_id,description FROM entry_descriptions LIMIT 0")?;
    db.prepare("SELECT id,entry_id,changed_at,before_description,after_description FROM description_revisions LIMIT 0")?;
    for table in ["entry_descriptions", "description_revisions"] {
        let fk: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list(?1) WHERE \"from\"='entry_id' AND \"table\"='time_entries' AND \"to\"='id')", [table], |r| r.get(0))?;
        if !fk { return Err(rusqlite::Error::InvalidQuery); }
    }
    let valid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('entry_descriptions') WHERE name='entry_id' AND UPPER(type)='INTEGER' AND pk=1) AND (SELECT COUNT(*) FROM pragma_table_info('entry_descriptions') WHERE pk>0)=1 AND EXISTS(SELECT 1 FROM pragma_table_info('entry_descriptions') WHERE name='description' AND \"notnull\"=1) AND (SELECT COUNT(*) FROM pragma_table_info('description_revisions') WHERE name IN ('entry_id','changed_at','before_description','after_description') AND \"notnull\"=1)=4 AND EXISTS(SELECT 1 FROM pragma_table_info('description_revisions') WHERE name='id' AND UPPER(type)='INTEGER' AND pk=1)", [], |r| r.get(0))?;
    let invalid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM entry_descriptions WHERE length(description)>2000) OR EXISTS(SELECT 1 FROM description_revisions WHERE length(before_description)>2000 OR length(after_description)>2000)", [], |r| r.get(0))?;
    if !valid || invalid { return Err(rusqlite::Error::InvalidQuery); }
    Ok(())
}

fn initialise_v10(db: &mut Connection) -> rusqlite::Result<()> {
    db.pragma_update(None, "foreign_keys", true)?;
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 10 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if version == 10 {
        validate_schema(db)?;
        validate_revisions_schema(db)?;
        validate_deletions_schema(db)?;
        validate_settings_schema(db)?;
        validate_client_archives_schema(db)?;
        validate_billing_schema(db)?;
        validate_task_archives_schema(db)?;
        return validate_description_schema(db);
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("
        CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS time_entries (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER CHECK(duration_seconds >= 0), CHECK ((ended_at IS NULL AND duration_seconds IS NULL) OR (ended_at IS NOT NULL AND duration_seconds IS NOT NULL)));
        CREATE UNIQUE INDEX IF NOT EXISTS one_running_timer ON time_entries((1)) WHERE ended_at IS NULL;")?;
    for query in ["SELECT id, name FROM clients LIMIT 0", "SELECT id, client_id, name FROM projects LIMIT 0", "SELECT id, project_id, name FROM tasks LIMIT 0", "SELECT id, task_id, started_at, ended_at, duration_seconds FROM time_entries LIMIT 0"] {
        tx.prepare(query)?;
    }
    if tx.prepare("PRAGMA foreign_key_check")?.query([])?.next()?.is_some() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if version < 2 {
        tx.execute_batch("ALTER TABLE time_entries ADD COLUMN manually_resolved INTEGER NOT NULL DEFAULT 0 CHECK(manually_resolved IN (0, 1));")?;
    }
    if version < 3 {
        tx.execute_batch("ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1));")?;
    }
    validate_schema(&tx)?;
    if version < 4 {
        tx.execute_batch("CREATE TABLE entry_revisions (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES time_entries(id), changed_at TEXT NOT NULL, before_start TEXT NOT NULL, before_end TEXT NOT NULL, before_seconds INTEGER NOT NULL CHECK(before_seconds >= 0), after_start TEXT NOT NULL, after_end TEXT NOT NULL, after_seconds INTEGER NOT NULL CHECK(after_seconds >= 0)); CREATE INDEX entry_revisions_by_entry ON entry_revisions(entry_id,id);")?;
    }
    validate_revisions_schema(&tx)?;
    if version < 5 { tx.execute_batch("CREATE TABLE entry_deletions (entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id), deleted_at TEXT NOT NULL);")?; }
    validate_deletions_schema(&tx)?;
    if version < 6 { tx.execute_batch("CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK(id=1), report_timezone TEXT NOT NULL); INSERT INTO app_settings(id,report_timezone) VALUES(1,'Europe/Warsaw');")?; }
    validate_settings_schema(&tx)?;
    if version < 7 { tx.execute_batch("CREATE TABLE client_archives (client_id INTEGER PRIMARY KEY REFERENCES clients(id));")?; }
    validate_client_archives_schema(&tx)?;
    if version < 8 { tx.execute_batch("CREATE TABLE billable_projects (project_id INTEGER PRIMARY KEY REFERENCES projects(id)); CREATE TABLE billable_entries (entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id)); CREATE TABLE billing_revisions (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES time_entries(id), changed_at TEXT NOT NULL, before_billable INTEGER NOT NULL CHECK(before_billable IN (0,1)), after_billable INTEGER NOT NULL CHECK(after_billable IN (0,1)), CHECK(before_billable != after_billable)); CREATE INDEX billing_revisions_by_entry ON billing_revisions(entry_id,id);")?; }
    validate_billing_schema(&tx)?;
    if version < 9 { tx.execute_batch("CREATE TABLE task_archives (task_id INTEGER PRIMARY KEY REFERENCES tasks(id));")?; }
    validate_task_archives_schema(&tx)?;
    tx.execute_batch("CREATE TABLE entry_descriptions (entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id), description TEXT NOT NULL CHECK(length(description)<=2000)); CREATE TABLE description_revisions (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES time_entries(id), changed_at TEXT NOT NULL, before_description TEXT NOT NULL CHECK(length(before_description)<=2000), after_description TEXT NOT NULL CHECK(length(after_description)<=2000)); CREATE INDEX description_revisions_by_entry ON description_revisions(entry_id,id);")?;
    validate_description_schema(&tx)?;
    tx.pragma_update(None, "user_version", 10)?;
    tx.commit()
}

fn initialise(db: &mut Connection) -> rusqlite::Result<()> {
    db.pragma_update(None, "foreign_keys", true)?;
    let version: i64 = db.pragma_query_value(None,"user_version",|r|r.get(0))?;
    if !(0..=LATEST_SCHEMA_VERSION).contains(&version) { return Err(rusqlite::Error::InvalidQuery); }
    if version <= 10 {
        initialise_v10(db)?;
        optional_task_migration::migrate(db)?;
    }
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version == 11 { sleep_periods::migrate(db)?; }
    sleep_periods::validate(db)?;
    validate_schema(db)?;
    validate_revisions_schema(db)?;
    validate_deletions_schema(db)?;
    validate_settings_schema(db)?;
    validate_client_archives_schema(db)?;
    validate_billing_schema(db)?;
    validate_task_archives_schema(db)?;
    validate_description_schema(db)?;
    optional_task_migration::validate(db)?;
    validate_project_timer_activity(db)?;
    if version <= 12 { entry_drafts::migrate_resolutions(db)?; }
    entry_drafts::validate_resolution_schema(db)
}

// Existing databases are backed up and verified before any schema migration.
// A failed backup prevents migration; a new installation needs no backup.
fn initialise_with_backup(db: &mut Connection, dir: &std::path::Path, existing: bool) -> rusqlite::Result<()> {
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if existing && (0..LATEST_SCHEMA_VERSION).contains(&version) {
        storage_safety::create_backup(db, dir)?;
    }
    initialise(db)
}

// Reuse the same schema capabilities for global shortcuts as normal project
// starts. v12 adds sleep-period storage without removing v11 project timers.
fn start_project_from_shortcut(tracker: &mut Tracker, project_id: i64, task_id: Option<i64>, at: &str) -> Cmd<()> {
    let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(db_err)?;
    match version {
        11..=LATEST_SCHEMA_VERSION => optional_task_migration::transition(
            tracker, None, at,
            optional_task_migration::TimerAction::Start { project_id, task_id, description: "" },
        ),
        10 => match task_id {
            Some(task_id) => close_active(tracker, at, Some(task_id)),
            None => Err("Ten projekt wymaga aktualizacji bazy przed pomiarem bez zadania.".into()),
        },
        _ => Err("Nie można odczytać wersji bazy danych.".into()),
    }
}

fn request_quit(app: &tauri::AppHandle) {
    let shared = app.state::<Shared>();
    let guard = shared.lock();
    let active = guard.as_ref().map_err(|_| "Błąd dostępu do danych lokalnych.".to_string())
        .and_then(|tracker| snapshot(tracker).map(|s| s.active));
    if matches!(active, Ok(None)) { app.exit(0); }
    else {
        use std::sync::atomic::Ordering;
        if app.state::<QuitDialog>().0.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return;
        }
        // Do not hold the tracker lock or block the UI thread during a dialog.
        drop(guard);
        let main_app = app.clone(); tauri::async_runtime::spawn(async move { let _ = show_main(main_app).await; });
        #[cfg(windows)]
        {
            let app = app.clone();
            std::thread::spawn(move || {
                struct ResetQuit<'a>(&'a std::sync::atomic::AtomicBool);
                impl Drop for ResetQuit<'_> {
                    fn drop(&mut self) { self.0.store(false, Ordering::Release); }
                }
                let pending = app.state::<QuitDialog>();
                let _reset = ResetQuit(&pending.0);
                match active {
                Ok(Some(entry)) if !entry.recovered => {
                    if !confirm_stop_and_exit() { return; }
                    let shared = app.state::<Shared>();
                    let mut tracker = match shared.lock() {
                        Ok(tracker) => tracker,
                        Err(_) => { show_start_error("Nie można odczytać pomiaru. Aplikacja pozostaje otwarta."); return; }
                    };
                    if let Err(err) = stop_expected_for_exit(&mut tracker, entry.id) {
                        drop(tracker);
                        show_start_error(&format!("{err}\n\nAplikacja pozostaje otwarta."));
                    } else { app.exit(0); }
                }
                Ok(Some(_)) => show_start_error("Pomiar wymaga ręcznej weryfikacji. Rozlicz go przed zakończeniem aplikacji."),
                Err(err) => show_start_error(&format!("{err}\n\nAplikacja pozostaje otwarta.")),
                Ok(None) => {}
                }
            });
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed { return; }
            let hotkey = app.state::<Hotkey>();
            let Ok(mut hotkey) = hotkey.lock() else { return; };
            if !hotkey.registered || hotkey.shortcut.parse::<Shortcut>().map(|active| active.id()).ok() != Some(shortcut.id()) { return; }
            if let Some(widget) = app.get_webview_window("widget") {
                if !hotkey.widget_ready {
                    hotkey.message = "Mini timer nie jest jeszcze gotowy do obsługi skrótu.".into();
                } else {
                    hotkey.message = widget.emit("tracker-shortcut", ()).err().map(|_| "Nie udało się przekazać skrótu do mini timera.".to_string()).unwrap_or_default();
                }
                return;
            }
            let shared = app.state::<Shared>();
            let Ok(mut tracker) = shared.lock() else { hotkey.message = "Nie można odczytać timera.".into(); return; };
            let result = match snapshot(&tracker) {
                Ok(current) if current.active.is_some() => close_active(&mut tracker, &now(), None),
                Ok(_) => match (hotkey.project_id,hotkey.task_id) {
                    (Some(project_id), task_id) => start_project_from_shortcut(&mut tracker, project_id, task_id, &now()),
                    (None,Some(task_id)) => close_active(&mut tracker, &now(), Some(task_id)),
                    (None,None) => Err("Wybierz projekt w mini timerze przed użyciem skrótu.".into()),
                },
                Err(err) => Err(err),
            };
            hotkey.message = result.err().unwrap_or_default();
        }).build())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            #[cfg(windows)]
            let activation = match instance_activation::start(&dir) {
                Ok(instance_activation::Startup::Primary { guard, activation }) => {
                    app.manage(guard);
                    activation
                }
                Ok(instance_activation::Startup::Activated) => std::process::exit(0),
                Err(err) => {
                    let message = if err.raw_os_error() == Some(instance_activation::SHARING_VIOLATION) {
                        "TrackerMaster jest już uruchomiony. Otwórz jego okno z ikony w zasobniku systemowym."
                    } else {
                        "Nie można zabezpieczyć dostępu do danych. Sprawdź uprawnienia katalogu aplikacji."
                    };
                    show_start_error(message);
                    return Err(err.into());
                }
            };
            let database_path = dir.join("tracker.sqlite3");
            let existing_database = database_path.exists();
            storage_safety::preflight_existing(&database_path).map_err(|err| {
                #[cfg(windows)]
                show_start_error("Nie można bezpiecznie zweryfikować bazy danych. Nie zmieniaj ani nie usuwaj pliku; sprawdź kopię zapasową.");
                err
            })?;
            let mut db = Connection::open(&database_path)?;
            initialise_with_backup(&mut db, &dir, existing_database).map_err(|err| {
                #[cfg(windows)]
                show_start_error("Nie można bezpiecznie otworzyć bazy danych. Nie zmieniaj ani nie usuwaj jej; sprawdź kopię i skontaktuj się z osobą pomagającą w obsłudze aplikacji.");
                err
            })?;
            let tracker = Arc::new(Mutex::new(Tracker { db, running_since: None, restored: false }));
            app.manage(tracker.clone());
            #[cfg(windows)]
            if power_events::register(tracker).is_err() {
                show_start_error("Nie udało się uruchomić monitorowania uśpienia. Po przerwie pomiar może wymagać ręcznej weryfikacji.");
            }
            app.manage(Mutex::new(HotkeyState::default()));
            app.manage(HotkeyChange(Mutex::new(())));
            app.manage(QuitDialog(std::sync::atomic::AtomicBool::new(false)));
            app.manage(Mutex::new(RestoreState::default()));
            app.manage(editor_close::EditorClose::default());
            let saved = std::fs::read_to_string(dir.join("shortcut.txt")).ok().filter(|value| valid_shortcut(value)).unwrap_or_else(|| DEFAULT_SHORTCUT.into());
            let registered = app.global_shortcut().register(saved.as_str());
            if let Ok(mut state) = app.state::<Hotkey>().lock() {
                state.shortcut = saved;
                state.registered = registered.is_ok();
                if registered.is_err() { state.message = "Wybrany globalny skrót jest niedostępny lub zajęty. Możesz wybrać inny w ustawieniach.".into(); }
            }
            let show = MenuItem::with_id(app, "show", "Otwórz TrackerMaster", true, None::<&str>)?;
            let widget = MenuItem::with_id(app, "widget", "Otwórz mini timer", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Zakończ aplikację", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &widget, &quit])?;
            let icon = app.default_window_icon().ok_or("Brak ikony aplikacji")?.clone();
            TrayIconBuilder::with_id("tracker-tray").icon(icon).tooltip("TrackerMaster")
                .menu(&menu).show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => { let app = app.clone(); tauri::async_runtime::spawn(async move { let _ = show_main(app).await; }); }
                    "widget" => { let app = app.clone(); tauri::async_runtime::spawn(async move { let _ = open_widget(app).await; }); }
                    "quit" => {
                        if !editor_close::intercept(app, editor_close::CloseAction::Quit) {
                            request_quit(app);
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                        let app = tray.app_handle().clone();
                        tauri::async_runtime::spawn(async move { let _ = show_main(app).await; });
                    }
                }).build(app)?;
            let window_config = app.config().app.windows.first().ok_or("Brak konfiguracji okna aplikacji")?;
            tauri::WebviewWindowBuilder::from_config(app, window_config)?.build()?;
            #[cfg(windows)]
            activation.listen(app.handle().clone())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if !editor_close::intercept(window.app_handle(), editor_close::CloseAction::Hide) {
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_snapshot,get_pending_sleep,set_sleep_resume,resolve_sleep_period,get_report_data,get_client_export_data,set_report_timezone,create_backup,diagnose_database,prepare_backup_restore,cancel_backup_restore,apply_backup_restore,exit_after_restore,create_client,create_project,create_task,set_project_billable,set_entry_billable,set_entry_description,rename_item,archive_project,archive_client,archive_task,start_timer,start_project_timer,resume_entry,stop_timer,recover_timer,create_manual_entry,create_project_manual_entry,edit_time_entry,entry_revisions,billing_revisions,description_revisions,delete_time_entry,deleted_entries,open_widget,show_main,ui_preferences::get_report_filter,ui_preferences::set_report_filter,ui_preferences::get_report_scope,ui_preferences::set_report_scope,ui_preferences::restore_widget_on_top,ui_preferences::set_widget_on_top,ui_preferences::get_draft_sort,ui_preferences::set_draft_sort,entry_drafts::get_entry_edit_source,entry_drafts::get_entry_drafts,entry_drafts::save_entry_draft,entry_drafts::check_entry_draft_source,entry_drafts::apply_entry_draft,entry_drafts::get_entry_draft_origin,entry_drafts::discard_entry_draft,editor_close::set_entry_editor_guard,editor_close::resolve_entry_editor_close,widget_start,widget_project_start,widget_stop,widget_panel,widget_drag,close_widget,set_shortcut_task,widget_shortcut_ready,shortcut_status,set_global_shortcut])
        .run(tauri::generate_context!())
        .expect("Nie można uruchomić aplikacji");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_backup_restore_can_be_retried_with_the_same_preview() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tracker-restore-retry-{}-{suffix}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let source_path = dir.join("source.sqlite3");
        let mut source = Connection::open(&source_path).unwrap();
        initialise(&mut source).unwrap();
        source.execute("INSERT INTO clients(name) VALUES('Copied')", []).unwrap();
        drop(source);

        let prepared = storage_safety::prepare_restore(&source_path).unwrap();
        let mut restore = RestoreState { sequence: 1, pending: Some(prepared) };
        let mut tracker = seeded();
        let obstacle = dir.join("backups");
        std::fs::write(&obstacle, b"test").unwrap();
        assert!(apply_prepared_restore(&mut tracker, &mut restore, "1", &dir).is_err());
        assert!(restore.pending.is_some());
        assert!(!tracker.restored);
        assert_eq!(tracker.db.query_row("SELECT name FROM clients WHERE id=1", [], |row| row.get::<_, String>(0)).unwrap(), "A");
        std::fs::remove_file(&obstacle).unwrap();

        let safety = apply_prepared_restore(&mut tracker, &mut restore, "1", &dir).unwrap();
        assert!(std::path::Path::new(&safety).is_file());
        assert!(restore.pending.is_none());
        assert!(tracker.restored);
        assert_eq!(tracker.db.query_row("SELECT name FROM clients WHERE id=1", [], |row| row.get::<_, String>(0)).unwrap(), "Copied");
        drop(tracker);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn instance_guard_rejects_second_open_and_releases_on_drop() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tracker-instance-test-{}-{suffix}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let first = lock_instance(&dir).unwrap();
        assert_eq!(lock_instance(&dir).err().unwrap().raw_os_error(), Some(32));
        drop(first);
        let next = lock_instance(&dir).unwrap();
        drop(next);
        std::fs::remove_file(dir.join("instance.lock")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    fn seeded() -> Tracker {
        let mut db = Connection::open_in_memory().unwrap();
        initialise_v10(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES (1,'A');
            INSERT INTO projects(id,client_id,name) VALUES (1,1,'P');
            INSERT INTO tasks(id,project_id,name) VALUES (1,1,'T1'),(2,1,'T2');").unwrap();
        Tracker { db, running_since: None, restored: false }
    }

    #[cfg(windows)]
    #[test]
    fn client_project_timer_and_export_survive_restart_on_isolated_file() {
        use std::time::{Duration, SystemTime, UNIX_EPOCH};
        let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir=std::env::temp_dir().join(format!("trackermaster-journey-{}-{suffix}",std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path=dir.join("journey.sqlite3");
        {
            let mut db=Connection::open(&path).unwrap();
            initialise(&mut db).unwrap();
            assert!(add_client(&db,"   ").is_err());
            let client=add_client(&db,"Klient testowy").unwrap();
            assert!(add_project(&db,client+1000,"Brak klienta").is_err());
            let project=add_project(&db,client,"Projekt testowy").unwrap();
            let other_client=add_client(&db,"Drugi klient").unwrap();
            let mut tracker=Tracker { db,running_since:None,restored:false };
            optional_task_migration::transition(&mut tracker,None,&now(),optional_task_migration::TimerAction::Start { project_id:project,task_id:None,description:"Fikcyjna praca" }).unwrap();
            let active=snapshot(&tracker).unwrap().active.unwrap();
            assert_eq!((active.project_id,active.task_id,active.description.as_str()),(project,None,"Fikcyjna praca"));
            std::thread::sleep(Duration::from_millis(1200));
            optional_task_migration::transition(&mut tracker,Some(active.id),&now(),optional_task_migration::TimerAction::Stop).unwrap();
            let entry=snapshot(&tracker).unwrap().entries.remove(0);
            assert_eq!(entry.id,active.id);
            assert!(entry.duration_seconds>=1);
            let exported=client_export_data(&tracker.db,client).unwrap();
            assert_eq!(exported.entries.len(),1);
            assert_eq!((exported.entries[0].id,exported.entries[0].description.as_str()),(entry.id,"Fikcyjna praca"));
            assert!(client_export_data(&tracker.db,other_client).unwrap().entries.is_empty());
        }
        {
            let mut db=Connection::open(&path).unwrap();
            initialise(&mut db).unwrap();
            let tracker=Tracker { db,running_since:None,restored:false };
            let state=snapshot(&tracker).unwrap();
            assert_eq!((state.clients.len(),state.projects.len(),state.entries.len()),(2,1,1));
            assert_eq!(state.entries[0].description,"Fikcyjna praca");
            assert!(state.active.is_none());
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn global_shortcut_starts_project_after_v12_sleep_migration() {
        for task_id in [None, Some(1)] {
            let mut tracker = seeded();
            initialise(&mut tracker.db).unwrap();
            let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
            assert_eq!(version, LATEST_SCHEMA_VERSION);
            start_project_from_shortcut(&mut tracker, 1, task_id, &now()).unwrap();
            let active = snapshot(&tracker).unwrap().active.expect("Shortcut should create one running entry");
            assert_eq!(active.project_id, 1);
            assert_eq!(active.task_id, task_id);
            let number: i64 = tracker.db.query_row("SELECT COUNT(*) FROM time_entries WHERE ended_at IS NULL", [], |r| r.get(0)).unwrap();
            assert_eq!(number, 1);
        }
    }

    #[test]
    fn shortcut_validation_and_preference_survive_replacement() {
        assert!(valid_shortcut("Ctrl+Shift+Space"));
        assert!(valid_shortcut("Ctrl+Alt+Q"));
        assert!(valid_shortcut("Ctrl+Shift+F12"));
        for bad in ["Ctrl+S", "Ctrl+Shift+F13", "Ctrl+Alt+F01", "Ctrl+Alt+q", "Ctrl+Shift+Space\n"] { assert!(!valid_shortcut(bad)); }
        let suffix=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir=std::env::temp_dir().join(format!("tracker-shortcut-{}-{suffix}",std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        save_shortcut_preference(&dir,"Ctrl+Shift+Space").unwrap();
        save_shortcut_preference(&dir,"Ctrl+Alt+Q").unwrap();
        assert!(save_shortcut_preference(&dir,"bad").is_err());
        assert_eq!(std::fs::read_to_string(dir.join("shortcut.txt")).unwrap(),"Ctrl+Alt+Q");
        std::fs::remove_file(dir.join("shortcut.txt")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn failed_shortcut_conflict_or_save_keeps_the_old_registration() {
        use std::{cell::RefCell, collections::HashSet, rc::Rc};
        let old="Ctrl+Shift+Space"; let new="Ctrl+Alt+Q";
        let registered=Rc::new(RefCell::new(HashSet::from([old.to_string()])));
        let saved=Rc::new(RefCell::new(old.to_string()));
        let r=registered.clone(); let p=saved.clone(); let u=registered.clone();
        assert!(replace_shortcut(old,new,true, move |_| Err("occupied".into()), move |v| { *p.borrow_mut()=v.into(); Ok(()) }, move |v| { u.borrow_mut().remove(v); Ok(()) }).is_err());
        assert!(r.borrow().contains(old)); assert_eq!(&*saved.borrow(),old);
        let r=registered.clone(); let u=registered.clone();
        assert!(replace_shortcut(old,new,true, move |v| { r.borrow_mut().insert(v.into()); Ok(()) }, move |_| Err("disk".into()), move |v| { u.borrow_mut().remove(v); Ok(()) }).is_err());
        assert!(registered.borrow().contains(old)); assert!(!registered.borrow().contains(new)); assert_eq!(&*saved.borrow(),old);
        let r=registered.clone(); let p=saved.clone(); let u=registered.clone();
        replace_shortcut(old,new,true, move |v| { r.borrow_mut().insert(v.into()); Ok(()) }, move |v| { *p.borrow_mut()=v.into(); Ok(()) }, move |v| { u.borrow_mut().remove(v); Ok(()) }).unwrap();
        assert!(!registered.borrow().contains(old)); assert!(registered.borrow().contains(new)); assert_eq!(&*saved.borrow(),new);
    }

    #[test]
    fn export_query_isolates_clients_and_excludes_open_and_deleted_entries() {
        let mut tracker = seeded();
        initialise(&mut tracker.db).unwrap();
        tracker.db.execute_batch("INSERT INTO clients(id,name) VALUES(2,'A podobny');
            INSERT INTO projects(id,client_id,name) VALUES(2,2,'Obcy projekt');
            INSERT INTO time_entries(id,task_id,project_id,started_at,ended_at,duration_seconds) VALUES
              (1,1,1,'2026-01-01T09:00:00Z','2026-01-01T10:00:00Z',3600),
              (2,NULL,1,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600),
              (3,NULL,2,'2026-01-01T11:00:00Z','2026-01-01T12:00:00Z',3600),
              (4,NULL,1,'2026-01-01T12:00:00Z','2026-01-01T13:00:00Z',3600),
              (5,NULL,1,'2026-01-01T13:00:00Z',NULL,NULL);
            INSERT INTO entry_deletions(entry_id,deleted_at) VALUES(4,'2026-01-01T14:00:00Z');").unwrap();
        let export = client_export_data(&tracker.db, 1).unwrap();
        assert_eq!(export.client, "A");
        assert_eq!(export.entries.iter().map(|e|e.id).collect::<Vec<_>>(), vec![1,2]);
        assert_eq!(export.entries[1].task, "");
        assert_eq!(client_export_data(&tracker.db, 2).unwrap().entries[0].project, "Obcy projekt");
        assert!(client_export_data(&tracker.db, 99).is_err());
        tracker.db.pragma_update(None, "foreign_keys", false).unwrap();
        tracker.db.execute("INSERT INTO time_entries(id,task_id,project_id,started_at,ended_at,duration_seconds) VALUES(6,1,2,'2026-01-01T14:00:00Z','2026-01-01T15:00:00Z',3600)", []).unwrap();
        assert!(client_export_data(&tracker.db, 2).is_err());
    }

    #[test]
    fn report_and_export_validate_and_isolate_the_saved_hierarchy() {
        let mut tracker = seeded();
        initialise(&mut tracker.db).unwrap();
        tracker.db.execute_batch("
            INSERT INTO clients(id,name) VALUES(2,'B');
            INSERT INTO projects(id,client_id,name) VALUES(2,2,'Wspólny'),(3,1,'Wspólny');
            UPDATE projects SET archived=1,name='Zmieniony' WHERE id=1;
            INSERT INTO tasks(id,project_id,name) VALUES(22,2,'Zadanie'),(33,3,'Zadanie');
            INSERT INTO time_entries(id,task_id,project_id,started_at,ended_at,duration_seconds) VALUES
              (1,1,1,'2026-01-01T09:00:00Z','2026-01-01T10:00:00Z',3600),
              (2,NULL,1,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600),
              (3,22,2,'2026-01-01T11:00:00Z','2026-01-01T12:00:00Z',3600),
              (4,33,3,'2026-01-01T12:00:00Z','2026-01-01T13:00:00Z',3600),
              (5,22,2,'2026-01-01T13:00:00Z',NULL,NULL);").unwrap();
        let selected = ReportScope { client_id: Some(1), project_id: Some(1), task_id: Some(1) };
        let by_project = ReportScope { task_id: None, ..selected };
        let by_client = ReportScope { project_id: None, task_id: None, ..selected };
        for (scope, ids) in [(selected, vec![1]), (by_project, vec![1, 2]), (by_client, vec![1, 2, 4])] {
            let report = report_data_for_scope(&tracker, Utc::now(), Err("unused".into()), scope).unwrap();
            let csv = client_export_data_for_scope(&tracker.db, scope).unwrap();
            assert_eq!(report.entries.iter().map(|entry| entry.id).collect::<Vec<_>>(), ids);
            assert_eq!(csv.entries.iter().map(|entry| entry.id).collect::<Vec<_>>(), ids);
            assert_eq!(csv.entries[0].project, "Zmieniony");
            assert!(report.active.is_none());
        }
        assert!(report_data(&tracker, Utc::now(), Err("unused".into())).unwrap().active.is_some());
        assert!(client_export_data_for_scope(&tracker.db, ReportScope::default()).is_err());
        for invalid in [
            ReportScope { client_id: Some(99), ..by_client },
            ReportScope { project_id: Some(99), ..by_project },
            ReportScope { task_id: Some(99), ..selected },
            ReportScope { project_id: Some(2), ..selected },
            ReportScope { task_id: Some(33), ..selected },
            ReportScope { client_id: None, ..selected },
        ] {
            assert!(report_data_for_scope(&tracker, Utc::now(), Err("unused".into()), invalid).is_err());
            assert!(client_export_data_for_scope(&tracker.db, invalid).is_err());
        }
    }

    #[test]
    fn snapshot_and_report_include_the_entries_project() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        add_manual_entry(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        assert_eq!(snapshot(&tracker).unwrap().entries[0].project_id, 1);
        assert_eq!(report_data(&tracker, current, Err("clock".into())).unwrap().entries[0].project_id, 1);
        close_active(&mut tracker, &now(), Some(2)).unwrap();
        assert_eq!(snapshot(&tracker).unwrap().active.unwrap().project_id, 1);
        assert_eq!(report_data(&tracker, Utc::now(), power_sample()).unwrap().active.unwrap().project_id, 1);
    }

    #[test]
    fn descriptions_are_optional_persisted_and_changes_are_audited() {
        let mut tracker = seeded();
        close_active_with_description(&mut tracker, &now(), Some(1), "Dokumentacja\nZażółć").unwrap();
        let active = snapshot(&tracker).unwrap().active.unwrap();
        assert_eq!(active.description, "Dokumentacja\nZażółć");
        set_description(&mut tracker.db, active.id, &active.description, "Zmieniony", &now()).unwrap();
        assert!(set_description(&mut tracker.db, active.id, &active.description, "stary", &now()).is_err());
        tracker.db.execute_batch("CREATE TRIGGER reject_desc BEFORE INSERT ON description_revisions BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(set_description(&mut tracker.db, active.id, "Zmieniony", "", &now()).is_err());
        assert_eq!(snapshot(&tracker).unwrap().active.unwrap().description, "Zmieniony");
        tracker.db.execute_batch("DROP TRIGGER reject_desc;").unwrap();
        set_description(&mut tracker.db, active.id, "Zmieniony", "", &now()).unwrap();
        close_active(&mut tracker, &now(), None).unwrap();
        assert_eq!(snapshot(&tracker).unwrap().entries[0].description, "");
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM description_revisions WHERE entry_id=?1", [active.id], |r|r.get::<_,i64>(0)).unwrap(), 2);
        assert!(set_description(&mut tracker.db, active.id, "", &"x".repeat(2001), &now()).is_err());
    }

    #[test]
    fn failed_description_insert_does_not_end_running_timer() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        let original = snapshot(&tracker).unwrap().active.unwrap().id;
        tracker.db.execute_batch("CREATE TRIGGER reject_desc_insert BEFORE INSERT ON entry_descriptions BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(close_active_with_description(&mut tracker, &now(), Some(2), "Nowy opis").is_err());
        let state = snapshot(&tracker).unwrap();
        assert_eq!(state.active.unwrap().id, original);
        assert!(state.entries.is_empty());
        assert!(tracker.running_since.is_some());
        tracker.db.execute_batch("DROP TRIGGER reject_desc_insert;").unwrap();
        close_active_with_description(&mut tracker, &now(), Some(2), "Nowy opis").unwrap();
        let state = snapshot(&tracker).unwrap();
        assert_eq!(state.active.unwrap().description, "Nowy opis");
        assert_eq!(state.entries.len(), 1);
    }

    #[test]
    fn resume_copies_source_and_switches_atomically() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        let source = add_manual_entry_with_description(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current, "Oryginalny opis").unwrap();
        set_entry_billing(&mut tracker.db, source, false, true, &now()).unwrap();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        let active = snapshot(&tracker).unwrap().active.unwrap().id;
        assert!(resume_saved_entry(&mut tracker, source, None, &now()).is_err());
        tracker.db.execute_batch("CREATE TRIGGER reject_resume BEFORE INSERT ON entry_descriptions BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(resume_saved_entry(&mut tracker, source, Some(active), &now()).is_err());
        assert_eq!(snapshot(&tracker).unwrap().active.unwrap().id, active);
        tracker.db.execute_batch("DROP TRIGGER reject_resume;").unwrap();
        resume_saved_entry(&mut tracker, source, Some(active), &now()).unwrap();
        let state = snapshot(&tracker).unwrap();
        let resumed = state.active.unwrap();
        assert_ne!(resumed.id, active);
        assert_eq!(resumed.description, "Oryginalny opis");
        assert!(resumed.billable);
        assert_eq!(state.entries.iter().find(|e| e.id == source).unwrap().description, "Oryginalny opis");
        assert!(state.entries.iter().any(|e| e.id == active));
    }

    #[test]
    fn resume_rejects_archived_task_and_deleted_source_without_stopping_active() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        let source = add_manual_entry_with_description(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current, "").unwrap();
        set_task_archived(&mut tracker.db, 1, true).unwrap();
        close_active(&mut tracker, &now(), Some(2)).unwrap();
        let active = snapshot(&tracker).unwrap().active.unwrap().id;
        assert!(resume_saved_entry(&mut tracker, source, Some(active), &now()).is_err());
        assert_eq!(snapshot(&tracker).unwrap().active.unwrap().id, active);
        set_task_archived(&mut tracker.db, 1, false).unwrap();
        tracker.db.execute("INSERT INTO entry_deletions(entry_id,deleted_at) VALUES(?1,?2)", params![source,now()]).unwrap();
        assert!(resume_saved_entry(&mut tracker, source, Some(active), &now()).is_err());
        assert_eq!(snapshot(&tracker).unwrap().active.unwrap().id, active);
    }

    #[test]
    fn manual_entry_description_and_old_migration_are_preserved() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        let id = add_manual_entry_with_description(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current, "Projekt; opis").unwrap();
        assert_eq!(report_data(&tracker, current, Err("clock".into())).unwrap().entries[0].description, "Projekt; opis");
        tracker.db.execute_batch("DROP TABLE description_revisions; DROP TABLE entry_descriptions; PRAGMA user_version=9;").unwrap();
        initialise_v10(&mut tracker.db).unwrap();
        let entry = snapshot(&tracker).unwrap().entries.remove(0);
        assert_eq!(entry.id, id);
        assert_eq!(entry.description, "");
        assert_eq!(entry.duration_seconds, 3600);
    }

    #[test]
    fn task_archive_preserves_history_blocks_timer_and_restores_only_after_project() {
        let mut tracker = seeded();
        set_project_billing(&mut tracker.db, 1, false, true).unwrap();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        assert!(set_task_archived(&mut tracker.db, 1, true).is_err());
        assert!(snapshot(&tracker).unwrap().active.is_some());
        close_active(&mut tracker, &now(), None).unwrap();
        set_task_archived(&mut tracker.db, 1, true).unwrap();
        assert!(close_active(&mut tracker, &now(), Some(1)).is_err());
        let state = snapshot(&tracker).unwrap();
        assert!(state.tasks.iter().find(|t| t.id == 1).unwrap().archived);
        assert!(state.entries[0].billable);
        set_project_archived(&mut tracker.db, 1, true).unwrap();
        assert!(set_task_archived(&mut tracker.db, 1, false).is_err());
        set_project_archived(&mut tracker.db, 1, false).unwrap();
        assert!(snapshot(&tracker).unwrap().tasks.iter().find(|t| t.id == 1).unwrap().archived);
        set_task_archived(&mut tracker.db, 1, false).unwrap();
        assert!(!snapshot(&tracker).unwrap().tasks.iter().find(|t| t.id == 1).unwrap().archived);
    }

    #[test]
    fn version_eight_migration_keeps_billing_and_tasks_active() {
        let mut tracker = seeded();
        set_project_billing(&mut tracker.db, 1, false, true).unwrap();
        tracker.db.execute_batch("DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; PRAGMA user_version=8;").unwrap();
        initialise_v10(&mut tracker.db).unwrap();
        let state = snapshot(&tracker).unwrap();
        assert!(state.projects[0].billable);
        assert!(state.tasks.iter().all(|t| !t.archived));
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_,i64>(0)).unwrap(), 10);
    }

    #[test]
    fn billing_inherits_project_but_keeps_previous_entries_and_audits_changes() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        let old = add_manual_entry(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        assert!(!snapshot(&tracker).unwrap().entries[0].billable);
        set_project_billing(&mut tracker.db, 1, false, true).unwrap();
        let next = add_manual_entry(&mut tracker, 1, "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", current).unwrap();
        let state = snapshot(&tracker).unwrap();
        assert!(state.projects[0].billable);
        assert!(!state.entries.iter().find(|e| e.id == old).unwrap().billable);
        assert!(state.entries.iter().find(|e| e.id == next).unwrap().billable);
        assert!(set_project_billing(&mut tracker.db, 1, false, false).is_err());
        set_project_billing(&mut tracker.db, 1, true, false).unwrap();
        assert!(snapshot(&tracker).unwrap().entries.iter().find(|e| e.id == next).unwrap().billable);
        set_entry_billing(&mut tracker.db, next, true, false, &now()).unwrap();
        assert!(set_entry_billing(&mut tracker.db, next, true, true, &now()).is_err());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM billing_revisions WHERE entry_id=?1", [next], |r| r.get::<_,i64>(0)).unwrap(), 1);
        set_entry_billing(&mut tracker.db, old, false, true, &now()).unwrap();
        assert!(report_data(&tracker, current, Err("clock".into())).unwrap().entries.iter().find(|e| e.id == old).unwrap().billable);
        tracker.db.execute_batch("CREATE TRIGGER reject_billing_audit BEFORE INSERT ON billing_revisions BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(set_entry_billing(&mut tracker.db, old, true, false, &now()).is_err());
        assert!(snapshot(&tracker).unwrap().entries.iter().find(|e| e.id == old).unwrap().billable);
        tracker.db.execute_batch("DROP TRIGGER reject_billing_audit;").unwrap();
        set_entry_billing(&mut tracker.db, old, true, false, &now()).unwrap();
    }

    #[test]
    fn timer_inherits_billing_and_future_changes_do_not_rewrite_it() {
        let mut tracker = seeded();
        set_project_billing(&mut tracker.db, 1, false, true).unwrap();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        assert!(snapshot(&tracker).unwrap().active.unwrap().billable);
        set_project_billing(&mut tracker.db, 1, true, false).unwrap();
        assert!(snapshot(&tracker).unwrap().active.unwrap().billable);
        close_active(&mut tracker, &now(), None).unwrap();
        assert!(snapshot(&tracker).unwrap().entries[0].billable);
    }

    #[test]
    fn version_seven_migration_preserves_entries_as_nonbillable_by_default() {
        let mut tracker = seeded();
        tracker.db.execute_batch("INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds) VALUES(1,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600); DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; PRAGMA user_version=7;").unwrap();
        initialise_v10(&mut tracker.db).unwrap();
        let state = snapshot(&tracker).unwrap();
        assert!(!state.projects[0].billable && !state.entries[0].billable);
        assert_eq!(state.entries[0].duration_seconds, 3600);
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_,i64>(0)).unwrap(), 10);
    }

    #[test]
    fn recovery_rejects_overlapping_history_and_allows_touching_end() {
        let mut tracker = seeded();
        tracker.db.execute_batch("INSERT INTO time_entries(id,task_id,started_at,ended_at,duration_seconds) VALUES(1,1,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600); INSERT INTO time_entries(id,task_id,started_at) VALUES(2,2,'2026-01-01T09:00:00Z');").unwrap();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        assert!(resolve_recovered(&mut tracker, "2026-01-01T10:30:00Z", current).is_err());
        assert!(snapshot(&tracker).unwrap().active.is_some());
        assert_eq!(snapshot(&tracker).unwrap().entries[0].duration_seconds, 3600);
        resolve_recovered(&mut tracker, "2026-01-01T10:00:00Z", current).unwrap();
        assert!(snapshot(&tracker).unwrap().active.is_none());
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 2);
    }

    #[test]
    fn timer_start_rejects_existing_future_entry_without_modifying_it() {
        let mut tracker = seeded();
        let start = Utc::now() + chrono::Duration::minutes(30);
        let end = start + chrono::Duration::minutes(30);
        tracker.db.execute("INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds) VALUES(1,?1,?2,1800)", params![start.to_rfc3339(),end.to_rfc3339()]).unwrap();
        assert!(close_active(&mut tracker, &now(), Some(2)).is_err());
        let state = snapshot(&tracker).unwrap();
        assert!(state.active.is_none());
        assert_eq!(state.entries.len(), 1);
        assert_eq!(state.entries[0].duration_seconds, 1800);
    }

    #[test]
    fn client_archival_requires_archived_projects_and_restores_independently() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        let id = add_manual_entry(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        assert!(set_client_archived(&mut tracker.db, 1, true).is_err());
        assert!(!snapshot(&tracker).unwrap().clients[0].archived);
        set_project_archived(&mut tracker.db, 1, true).unwrap();
        set_client_archived(&mut tracker.db, 1, true).unwrap();
        assert!(snapshot(&tracker).unwrap().clients[0].archived);
        assert!(set_project_archived(&mut tracker.db, 1, false).is_err());
        assert!(close_active(&mut tracker, &now(), Some(1)).is_err());
        let state = snapshot(&tracker).unwrap();
        assert_eq!(state.entries[0].id, id);
        assert_eq!(state.entries[0].duration_seconds, 3600);
        assert!(state.projects[0].archived);
        set_client_archived(&mut tracker.db, 1, false).unwrap();
        assert!(!snapshot(&tracker).unwrap().clients[0].archived);
        assert!(snapshot(&tracker).unwrap().projects[0].archived);
        set_project_archived(&mut tracker.db, 1, false).unwrap();
        assert!(set_client_archived(&mut tracker.db, 1, true).is_err());
    }

    #[test]
    fn version_six_migrates_clients_without_changing_history_or_settings() {
        let mut tracker = seeded();
        update_report_timezone(&tracker.db, "Europe/Warsaw", "Europe/London").unwrap();
        tracker.db.execute_batch("DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; DROP TABLE client_archives; PRAGMA user_version=6;").unwrap();
        initialise_v10(&mut tracker.db).unwrap();
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_,i64>(0)).unwrap(), 10);
        assert!(!snapshot(&tracker).unwrap().clients[0].archived);
        assert_eq!(report_data(&tracker, Utc::now(), Err("clock".into())).unwrap().time_zone, "Europe/London");
    }

    #[test]
    fn renaming_keeps_relationships_and_history_and_rejects_stale_updates() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        let entry = add_manual_entry(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        set_project_archived(&mut tracker.db, 1, true).unwrap();
        rename_entity(&tracker.db, "client", 1, "A", " Nowy klient ").unwrap();
        rename_entity(&tracker.db, "project", 1, "P", "Nowy projekt").unwrap();
        rename_entity(&tracker.db, "task", 1, "T1", "Nowe zadanie").unwrap();
        assert!(rename_entity(&tracker.db, "client", 1, "A", "Stara zmiana").is_err());
        assert!(rename_entity(&tracker.db, "task", 1, "Nowe zadanie", "  ").is_err());
        assert!(rename_entity(&tracker.db, "invalid", 1, "x", "y").is_err());
        let s = snapshot(&tracker).unwrap();
        assert_eq!(s.clients[0].name, "Nowy klient");
        assert_eq!(s.projects[0].name, "Nowy projekt");
        assert!(s.projects[0].archived);
        let task = s.tasks.iter().find(|task| task.id == 1).unwrap();
        assert_eq!(task.name, "Nowe zadanie");
        assert_eq!(task.project_id, 1);
        assert_eq!(s.entries[0].id, entry);
        assert_eq!(s.entries[0].task_id, Some(1));
        assert_eq!(s.entries[0].duration_seconds, 3600);
        rename_entity(&tracker.db, "client", 1, "Nowy klient", "Poprawiona nazwa").unwrap();
    }

    #[test]
    fn timezone_migration_preserves_history_and_uses_optimistic_updates() {
        let mut tracker = seeded();
        tracker.db.execute_batch("INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds) VALUES(1,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600); DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; DROP TABLE client_archives; DROP TABLE app_settings; PRAGMA user_version=5;").unwrap();
        initialise_v10(&mut tracker.db).unwrap();
        let report = report_data(&tracker, Utc::now(), Err("clock".into())).unwrap();
        assert_eq!(report.time_zone, "Europe/Warsaw");
        assert_eq!(report.entries.len(), 1);
        update_report_timezone(&tracker.db, "Europe/Warsaw", "Europe/London").unwrap();
        assert!(update_report_timezone(&tracker.db, "Europe/Warsaw", "Europe/Berlin").is_err());
        assert!(update_report_timezone(&tracker.db, "Europe/London", "invalid zone").is_err());
        initialise_v10(&mut tracker.db).unwrap();
        assert_eq!(report_data(&tracker, Utc::now(), Err("clock".into())).unwrap().time_zone, "Europe/London");
    }

    #[test]
    fn timezone_migration_rolls_back_when_table_already_exists() {
        let mut tracker = seeded();
        tracker.db.pragma_update(None, "user_version", 5).unwrap();
        assert!(initialise_v10(&mut tracker.db).is_err());
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 5);
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM tasks",[],|r|r.get::<_,i64>(0)).unwrap(), 2);
    }

    #[test]
    fn migration_requires_verified_backup_and_can_retry_after_failure() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tracker-migration-{}-{suffix}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let blocker = dir.join("not-a-directory");
        std::fs::write(&blocker, b"test").unwrap();
        let mut tracker = seeded();
        tracker.db.execute_batch("INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds) VALUES(1,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600); DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; DROP TABLE client_archives; DROP TABLE app_settings; PRAGMA user_version=5;").unwrap();
        assert!(initialise_with_backup(&mut tracker.db, &blocker, true).is_err());
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 5);
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM time_entries", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        initialise_with_backup(&mut tracker.db, &dir, true).unwrap();
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), LATEST_SCHEMA_VERSION);
        let backups: Vec<_> = std::fs::read_dir(dir.join("backups")).unwrap().map(|entry| entry.unwrap().path()).collect();
        assert_eq!(backups.len(), 1);
        storage_safety::preflight_existing(&backups[0]).unwrap();
        let old = Connection::open_with_flags(&backups[0], rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(old.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 5);
        assert_eq!(old.query_row("SELECT COUNT(*) FROM time_entries", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        drop(old);
        std::fs::remove_file(&backups[0]).unwrap();
        std::fs::remove_dir(dir.join("backups")).unwrap();
        std::fs::remove_file(blocker).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn reports_include_full_history_but_exclude_deleted_entries() {
        let tracker = seeded();
        tracker.db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<501) INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds) SELECT 1,'2026-01-01T10:00:00Z','2026-01-01T10:01:00Z',60 FROM n; INSERT INTO entry_deletions(entry_id,deleted_at) VALUES(1,'2026-01-02T00:00:00Z');").unwrap();
        let report = report_data(&tracker, Utc::now(), Err("no clock".into())).unwrap();
        assert_eq!(report.entries.len(), 500);
        assert!(report.entries.iter().all(|entry| entry.id != 1));
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 500);
        tracker.db.execute("DELETE FROM entry_deletions WHERE entry_id=1", []).unwrap();
        assert_eq!(report_data(&tracker, Utc::now(), Err("no clock".into())).unwrap().entries.len(), 501);
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 500);
    }

    #[test]
    fn reports_withhold_active_projection_after_sleep_or_restart() {
        let mut tracker = seeded();
        let current = Utc::now();
        let start = current.to_rfc3339_opts(SecondsFormat::Millis, true);
        tracker.db.execute("INSERT INTO time_entries(task_id,started_at) VALUES(1,?1)", [&start]).unwrap();
        let base = PowerSample { total_ms: 10_000, awake_ms: 8_000 };
        let recovered = report_data(&tracker, current, Ok(base)).unwrap().active.unwrap();
        assert!(recovered.unresolved && recovered.duration_seconds.is_none());
        tracker.running_since = Some(RunningClock { since: Instant::now(), power: base });
        let live = report_data(&tracker, current, Ok(base)).unwrap().active.unwrap();
        assert!(!live.unresolved && live.duration_seconds == Some(0));
        let slept = report_data(&tracker, current, Ok(PowerSample { total_ms: 15_000, awake_ms: 8_000 })).unwrap().active.unwrap();
        assert!(slept.unresolved && slept.ended_at.is_none());
        assert!(report_data(&tracker, current, Err("clock".into())).unwrap().active.unwrap().unresolved);
        assert!(report_data(&tracker, current + chrono::Duration::hours(1), Ok(base)).unwrap().active.unwrap().unresolved);
    }

    #[test]
    fn restored_session_blocks_old_window_and_shortcut_operations() {
        let mut tracker = seeded();
        tracker.restored = true;
        assert!(ensure_available(&tracker).is_err());
        assert!(change_timer_if_current(&mut tracker, None, Some(1)).is_err());
        assert!(close_active(&mut tracker, &now(), Some(1)).is_err());
        assert!(snapshot(&tracker).unwrap().active.is_none());
    }

    #[test]
    fn power_counters_detect_sleep_and_invalid_readings() {
        let start = PowerSample { total_ms: 10_000, awake_ms: 8_000 };
        assert!(!sleep_or_invalid(start, PowerSample { total_ms: 15_000, awake_ms: 13_010 }));
        assert!(!sleep_or_invalid(start, PowerSample { total_ms: 17_000, awake_ms: 13_000 }));
        assert!(sleep_or_invalid(start, PowerSample { total_ms: 17_001, awake_ms: 13_000 }));
        assert!(sleep_or_invalid(start, PowerSample { total_ms: 15_000, awake_ms: 16_000 }));
        assert!(sleep_or_invalid(start, PowerSample { total_ms: 9_999, awake_ms: 9_000 }));
        assert!(sleep_or_invalid(start, PowerSample { total_ms: 11_000, awake_ms: 7_999 }));
    }

    #[test]
    fn sleep_detection_preserves_entry_for_manual_recovery() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        let current = power_sample().unwrap();
        assert!(current.total_ms >= 5_000);
        tracker.running_since.as_mut().unwrap().power = PowerSample {
            total_ms: current.total_ms - 5_000,
            awake_ms: current.awake_ms,
        };
        assert!(close_active(&mut tracker, &now(), Some(2)).is_err());
        let state = snapshot(&tracker).unwrap();
        assert!(state.active.unwrap().recovered);
        assert!(state.entries.is_empty());
        resolve_recovered(&mut tracker, &now(), Utc::now()).unwrap();
        assert!(snapshot(&tracker).unwrap().entries[0].manually_resolved);
    }

    #[test]
    fn archive_preserves_history_and_prevents_new_timer_until_restored() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        assert!(set_project_archived(&mut tracker.db, 1, true).is_err());
        close_active(&mut tracker, &now(), None).unwrap();
        set_project_archived(&mut tracker.db, 1, true).unwrap();
        set_project_archived(&mut tracker.db, 1, true).unwrap();
        let saved = snapshot(&tracker).unwrap();
        assert!(saved.projects[0].archived);
        assert_eq!(saved.entries.len(), 1);
        assert!(close_active(&mut tracker, &now(), Some(1)).is_err());
        assert!(snapshot(&tracker).unwrap().active.is_none());
        set_project_archived(&mut tracker.db, 1, false).unwrap();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
    }

    #[test]
    fn version_two_migration_keeps_history() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        close_active(&mut tracker, &now(), None).unwrap();
        tracker.db.execute_batch("DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; DROP TABLE client_archives; DROP TABLE app_settings; DROP TABLE entry_deletions; DROP TABLE entry_revisions; ALTER TABLE projects DROP COLUMN archived; PRAGMA user_version=2;").unwrap();
        initialise_v10(&mut tracker.db).unwrap();
        let state = snapshot(&tracker).unwrap();
        assert!(!state.projects[0].archived);
        assert_eq!(state.entries.len(), 1);
    }

    #[test]
    fn file_database_migrates_and_retains_archive_and_history_after_reopen() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("tracker-master-test-{}-{suffix}.sqlite3", std::process::id()));
        struct TempDatabase(std::path::PathBuf);
        impl Drop for TempDatabase {
            fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
        }
        std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
        let _cleanup = TempDatabase(path.clone());
        {
            let mut db = Connection::open(&path).unwrap();
            initialise_v10(&mut db).unwrap();
            db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient testowy'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt testowy'); INSERT INTO tasks(id,project_id,name) VALUES(1,1,'Zadanie testowe'); INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds) VALUES(1,'2026-01-01T10:00:00Z','2026-01-01T10:01:00Z',60); DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; DROP TABLE client_archives; DROP TABLE app_settings; DROP TABLE entry_deletions; DROP TABLE entry_revisions; ALTER TABLE projects DROP COLUMN archived; PRAGMA user_version=2;").unwrap();
        }
        {
            let mut db = Connection::open(&path).unwrap();
            initialise_v10(&mut db).unwrap();
            set_project_archived(&mut db, 1, true).unwrap();
        }
        {
            let mut db = Connection::open(&path).unwrap();
            initialise_v10(&mut db).unwrap();
            let tracker = Tracker { db, running_since: None, restored: false };
            let state = snapshot(&tracker).unwrap();
            assert!(state.projects[0].archived);
            assert_eq!(state.entries.len(), 1);
            assert_eq!(state.entries[0].duration_seconds, 60);
            assert_eq!(state.tasks[0].name, "Zadanie testowe");
        }
    }

    #[test]
    fn invalid_version_two_schema_rolls_back_archive_migration() {
        let mut tracker = seeded();
        tracker.db.execute_batch("DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; DROP TABLE client_archives; DROP TABLE app_settings; DROP TABLE entry_deletions; DROP TABLE entry_revisions; ALTER TABLE projects DROP COLUMN archived; ALTER TABLE time_entries DROP COLUMN manually_resolved; PRAGMA user_version=2;").unwrap();
        assert!(initialise_v10(&mut tracker.db).is_err());
        let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 2);
        assert!(tracker.db.prepare("SELECT archived FROM projects LIMIT 0").is_err());
    }

    #[test]
    fn switching_timer_closes_old_entry_and_starts_new_one() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        close_active(&mut tracker, &now(), Some(2)).unwrap();
        let s = snapshot(&tracker).unwrap();
        assert_eq!(s.entries.len(), 1);
        assert_eq!(s.entries[0].task_id, Some(1));
        assert_eq!(s.active.unwrap().task_id, Some(2));
    }

    #[test]
    fn invalid_switch_rolls_back_the_old_timer() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        assert!(close_active(&mut tracker, &now(), Some(999)).is_err());
        let s = snapshot(&tracker).unwrap();
        assert_eq!(s.active.unwrap().task_id, Some(1));
        assert!(s.entries.is_empty());
    }

    #[test]
    fn database_failure_during_switch_rolls_back_and_retry_succeeds() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        let active_id = snapshot(&tracker).unwrap().active.unwrap().id;
        tracker.db.execute_batch("CREATE TRIGGER reject_new_entry BEFORE INSERT ON time_entries BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;").unwrap();

        assert!(close_active(&mut tracker, &now(), Some(2)).is_err());
        let state = snapshot(&tracker).unwrap();
        let active = state.active.unwrap();
        assert_eq!((active.id, active.task_id), (active_id, Some(1)));
        assert!(!active.recovered);
        assert!(state.entries.is_empty());

        tracker.db.execute_batch("DROP TRIGGER reject_new_entry;").unwrap();
        close_active(&mut tracker, &now(), Some(2)).unwrap();
        let state = snapshot(&tracker).unwrap();
        assert_eq!(state.active.unwrap().task_id, Some(2));
        assert_eq!(state.entries.len(), 1);
        assert_eq!(state.entries[0].id, active_id);
        assert_eq!(state.entries[0].task_id, Some(1));
    }

    #[test]
    fn database_failure_during_stop_preserves_timer_until_retry() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        let active_id = snapshot(&tracker).unwrap().active.unwrap().id;
        tracker.db.execute_batch("CREATE TRIGGER reject_close BEFORE UPDATE ON time_entries BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;").unwrap();

        assert!(close_active(&mut tracker, &now(), None).is_err());
        let state = snapshot(&tracker).unwrap();
        let active = state.active.unwrap();
        assert_eq!(active.id, active_id);
        assert!(!active.recovered);
        assert!(state.entries.is_empty());

        tracker.db.execute_batch("DROP TRIGGER reject_close;").unwrap();
        close_active(&mut tracker, &now(), None).unwrap();
        let state = snapshot(&tracker).unwrap();
        assert!(state.active.is_none());
        assert_eq!(state.entries.len(), 1);
        assert_eq!(state.entries[0].id, active_id);
    }

    #[test]
    fn repeated_start_does_not_split_active_entry() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        let original_id = snapshot(&tracker).unwrap().active.unwrap().id;
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        let s = snapshot(&tracker).unwrap();
        assert_eq!(s.active.unwrap().id, original_id);
        assert!(s.entries.is_empty());
    }

    #[test]
    fn recovered_timer_is_not_falsely_closed() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        tracker.running_since = None;
        assert!(close_active(&mut tracker, &now(), None).is_err());
        assert!(snapshot(&tracker).unwrap().active.unwrap().recovered);
    }

    #[test]
    fn exit_stops_only_the_confirmed_timer_and_preserves_failed_writes() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        let first_id = snapshot(&tracker).unwrap().active.unwrap().id;
        assert!(stop_expected_for_exit(&mut tracker, first_id + 1).is_err());
        assert_eq!(snapshot(&tracker).unwrap().active.unwrap().id, first_id);

        tracker.db.execute_batch("CREATE TRIGGER reject_exit_close BEFORE UPDATE ON time_entries BEGIN SELECT RAISE(FAIL, 'test'); END;").unwrap();
        assert!(stop_expected_for_exit(&mut tracker, first_id).is_err());
        assert_eq!(snapshot(&tracker).unwrap().active.unwrap().id, first_id);
        tracker.db.execute_batch("DROP TRIGGER reject_exit_close;").unwrap();

        stop_expected_for_exit(&mut tracker, first_id).unwrap();
        let state = snapshot(&tracker).unwrap();
        assert!(state.active.is_none());
        assert_eq!(state.entries[0].id, first_id);
    }

    #[test]
    fn stale_window_cannot_start_switch_or_stop_another_timer() {
        let mut tracker = seeded();
        change_timer_if_current(&mut tracker, None, Some(1)).unwrap();
        let first_id = snapshot(&tracker).unwrap().active.unwrap().id;
        assert!(change_timer_if_current(&mut tracker, None, Some(2)).is_err());
        assert_eq!(snapshot(&tracker).unwrap().active.unwrap().id, first_id);

        change_timer_if_current(&mut tracker, Some(first_id), Some(2)).unwrap();
        let second_id = snapshot(&tracker).unwrap().active.unwrap().id;
        assert_ne!(first_id, second_id);
        assert!(change_timer_if_current(&mut tracker, Some(first_id), None).is_err());
        assert!(change_timer_if_current(&mut tracker, Some(first_id), Some(1)).is_err());
        assert_eq!(snapshot(&tracker).unwrap().active.unwrap().id, second_id);
        change_timer_if_current(&mut tracker, Some(second_id), None).unwrap();
        assert!(snapshot(&tracker).unwrap().active.is_none());
    }

    #[test]
    fn manual_entries_reject_overlaps_and_allow_touching_boundaries() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        add_manual_entry(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        assert!(add_manual_entry(&mut tracker, 2, "2026-01-01T09:30:00Z", "2026-01-01T10:30:00Z", current).is_err());
        add_manual_entry(&mut tracker, 2, "2026-01-01T11:00:00+01:00", "2026-01-01T12:00:00+01:00", current).unwrap();
        let entries = snapshot(&tracker).unwrap().entries;
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry.duration_seconds == 3600 && entry.manually_resolved));
        assert!(add_manual_entry(&mut tracker, 1, "2026-01-01T12:00:00Z", "2026-01-01T12:00:00Z", current).is_err());
        assert!(add_manual_entry(&mut tracker, 1, "2026-01-01T23:30:00Z", "2026-01-02T00:00:01Z", current).is_err());
        assert!(add_manual_entry(&mut tracker, 99, "2026-01-01T12:00:00Z", "2026-01-01T13:00:00Z", current).is_err());
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 2);
    }

    #[test]
    fn manual_entry_cannot_overlap_a_running_timer_or_use_an_archived_project() {
        let mut tracker = seeded();
        tracker.db.execute("INSERT INTO time_entries(task_id,started_at) VALUES(1,'2026-01-01T10:00:00Z')", []).unwrap();
        let current = DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z").unwrap().with_timezone(&Utc);
        assert!(add_manual_entry(&mut tracker, 2, "2026-01-01T09:30:00Z", "2026-01-01T10:30:00Z", current).is_err());
        add_manual_entry(&mut tracker, 2, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        tracker.db.execute("UPDATE projects SET archived=1 WHERE id=1", []).unwrap();
        assert!(add_manual_entry(&mut tracker, 1, "2026-01-01T08:00:00Z", "2026-01-01T09:00:00Z", current).is_err());
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 1);
        assert!(snapshot(&tracker).unwrap().active.is_some());
    }

    #[test]
    fn corrections_keep_history_reject_conflicts_and_roll_back_together() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        let first = add_manual_entry(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        add_manual_entry(&mut tracker, 2, "2026-01-01T11:00:00Z", "2026-01-01T12:00:00Z", current).unwrap();
        let original = snapshot(&tracker).unwrap().entries.into_iter().find(|e| e.id == first).unwrap();
        assert!(correct_entry(&mut tracker, first, &original.started_at, &original.ended_at, "2026-01-01T10:30:00Z", "2026-01-01T11:30:00Z", current).is_err());
        tracker.db.execute_batch("CREATE TRIGGER reject_correction BEFORE UPDATE ON time_entries BEGIN SELECT RAISE(ABORT, 'test'); END;").unwrap();
        assert!(correct_entry(&mut tracker, first, &original.started_at, &original.ended_at, "2026-01-01T09:00:00Z", "2026-01-01T10:30:00Z", current).is_err());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM entry_revisions", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        tracker.db.execute_batch("DROP TRIGGER reject_correction;").unwrap();
        correct_entry(&mut tracker, first, &original.started_at, &original.ended_at, "2026-01-01T09:00:00Z", "2026-01-01T10:30:00Z", current).unwrap();
        assert!(correct_entry(&mut tracker, first, &original.started_at, &original.ended_at, "2026-01-01T08:30:00Z", "2026-01-01T10:00:00Z", current).is_err());
        let updated = snapshot(&tracker).unwrap().entries.into_iter().find(|e| e.id == first).unwrap();
        correct_entry(&mut tracker, first, &updated.started_at, &updated.ended_at, "2026-01-01T08:30:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        let revisions: Vec<(i64,i64)> = tracker.db.prepare("SELECT before_seconds,after_seconds FROM entry_revisions WHERE entry_id=?1 ORDER BY id").unwrap().query_map([first], |r| Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(revisions, vec![(3600, 5400), (5400, 5400)]);
    }

    #[test]
    fn version_three_migrates_to_revision_history_without_losing_entries() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        add_manual_entry(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        tracker.db.execute_batch("DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; DROP TABLE client_archives; DROP TABLE app_settings; DROP TABLE entry_deletions; DROP TABLE entry_revisions; PRAGMA user_version=3;").unwrap();
        initialise_v10(&mut tracker.db).unwrap();
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 1);
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 10);
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM entry_revisions", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn deleted_entry_is_excluded_but_original_and_revisions_are_preserved() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        let id = add_manual_entry(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        let initial = snapshot(&tracker).unwrap().entries.remove(0);
        correct_entry(&mut tracker, id, &initial.started_at, &initial.ended_at, "2026-01-01T09:00:00Z", "2026-01-01T10:30:00Z", current).unwrap();
        let entry = snapshot(&tracker).unwrap().entries.remove(0);
        assert!(mark_entry_deleted(&mut tracker, id, &initial.started_at, &initial.ended_at, &now()).is_err());
        tracker.db.execute_batch("CREATE TRIGGER reject_deletion BEFORE INSERT ON entry_deletions BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(mark_entry_deleted(&mut tracker, id, &entry.started_at, &entry.ended_at, &now()).is_err());
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 1);
        tracker.db.execute_batch("DROP TRIGGER reject_deletion;").unwrap();
        mark_entry_deleted(&mut tracker, id, &entry.started_at, &entry.ended_at, &now()).unwrap();
        assert!(mark_entry_deleted(&mut tracker, id, &entry.started_at, &entry.ended_at, &now()).is_err());
        assert!(snapshot(&tracker).unwrap().entries.is_empty());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM time_entries WHERE id=?1", [id], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM entry_revisions WHERE entry_id=?1", [id], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert!(correct_entry(&mut tracker, id, &entry.started_at, &entry.ended_at, "2026-01-01T08:00:00Z", "2026-01-01T09:00:00Z", current).is_err());
        add_manual_entry(&mut tracker, 2, "2026-01-01T09:00:00Z", "2026-01-01T10:30:00Z", current).unwrap();
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 1);
    }

    #[test]
    fn deletion_migration_preserves_entries_and_revisions() {
        let mut tracker = seeded();
        let current = DateTime::parse_from_rfc3339("2026-01-02T00:00:00Z").unwrap().with_timezone(&Utc);
        let id = add_manual_entry(&mut tracker, 1, "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", current).unwrap();
        let entry = snapshot(&tracker).unwrap().entries.remove(0);
        correct_entry(&mut tracker, id, &entry.started_at, &entry.ended_at, "2026-01-01T09:00:00Z", "2026-01-01T10:30:00Z", current).unwrap();
        tracker.db.execute_batch("DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; DROP TABLE client_archives; DROP TABLE app_settings; DROP TABLE entry_deletions; PRAGMA user_version=4;").unwrap();
        initialise_v10(&mut tracker.db).unwrap();
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 1);
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM entry_revisions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 10);
    }

    #[test]
    fn active_timer_cannot_be_deleted_and_corrupt_marker_is_rejected_on_startup() {
        let mut tracker = seeded();
        tracker.db.execute("INSERT INTO time_entries(task_id,started_at) VALUES(1,'2026-01-01T10:00:00Z')", []).unwrap();
        let id = snapshot(&tracker).unwrap().active.unwrap().id;
        assert!(mark_entry_deleted(&mut tracker, id, "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", &now()).is_err());
        assert!(snapshot(&tracker).unwrap().active.is_some());
        tracker.db.execute("INSERT INTO entry_deletions(entry_id,deleted_at) VALUES(?1,?2)", params![id,now()]).unwrap();
        assert!(initialise_v10(&mut tracker.db).is_err());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM entry_deletions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn deletion_migration_rolls_back_if_unexpected_table_exists() {
        let mut tracker = seeded();
        tracker.db.execute_batch("DROP TABLE description_revisions; DROP TABLE entry_descriptions; DROP TABLE task_archives; DROP TABLE billing_revisions; DROP TABLE billable_entries; DROP TABLE billable_projects; DROP TABLE client_archives; DROP TABLE app_settings; DROP TABLE entry_deletions; CREATE TABLE entry_deletions(unexpected TEXT); PRAGMA user_version=4;").unwrap();
        assert!(initialise_v10(&mut tracker.db).is_err());
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 4);
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn clock_discrepancy_preserves_entry_for_manual_recovery() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        let erroneous_end = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        assert!(close_active(&mut tracker, &erroneous_end, None).is_err());
        let state = snapshot(&tracker).unwrap();
        assert!(state.active.unwrap().recovered);
        assert!(state.entries.is_empty());
        let valid_end = now();
        resolve_recovered(&mut tracker, &valid_end, Utc::now()).unwrap();
        assert!(snapshot(&tracker).unwrap().entries[0].manually_resolved);
    }

    #[test]
    fn recovery_requires_valid_explicit_end_and_marks_the_entry() {
        let mut tracker = seeded();
        tracker.db.execute("INSERT INTO time_entries(task_id,started_at) VALUES(1,'2026-01-01T10:00:00.000Z')", []).unwrap();
        let current = DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z").unwrap().with_timezone(&Utc);
        assert!(resolve_recovered(&mut tracker, "2026-01-01T09:59:59Z", current).is_err());
        assert!(resolve_recovered(&mut tracker, "2026-01-01T12:00:01Z", current).is_err());
        assert!(snapshot(&tracker).unwrap().active.is_some());
        resolve_recovered(&mut tracker, "2026-01-01T10:30:00Z", current).unwrap();
        let s = snapshot(&tracker).unwrap();
        assert!(s.active.is_none());
        assert_eq!(s.entries[0].duration_seconds, 1800);
        assert!(s.entries[0].manually_resolved);
        assert!(resolve_recovered(&mut tracker, "2026-01-01T10:30:00Z", current).is_err());
    }

    #[test]
    fn schema_prevents_two_concurrent_timers() {
        let tracker = seeded();
        tracker.db.execute("INSERT INTO time_entries(task_id,started_at) VALUES(1,?1)", [now()]).unwrap();
        assert!(tracker.db.execute("INSERT INTO time_entries(task_id,started_at) VALUES(2,?1)", [now()]).is_err());
    }

    #[test]
    fn initialization_is_repeatable_and_preserves_data() {
        let mut tracker = seeded();
        initialise_v10(&mut tracker.db).unwrap();
        let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 10);
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM tasks",[],|r|r.get::<_,i64>(0)).unwrap(), 2);
    }

    #[test]
    fn current_schema_missing_timer_guard_is_rejected_without_repair() {
        let mut tracker = seeded();
        tracker.db.execute_batch("DROP INDEX one_running_timer;").unwrap();
        assert!(initialise_v10(&mut tracker.db).is_err());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        let index_exists: bool = tracker.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='one_running_timer')", [], |r| r.get(0)).unwrap();
        assert!(!index_exists);
    }

    #[test]
    fn current_schema_with_broken_relationship_is_rejected() {
        let mut tracker = seeded();
        tracker.db.pragma_update(None, "foreign_keys", false).unwrap();
        tracker.db.execute("INSERT INTO projects(id,client_id,name) VALUES(2,999,'Orphan')", []).unwrap();
        assert!(initialise_v10(&mut tracker.db).is_err());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM projects WHERE id=2", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn current_schema_without_foreign_key_is_rejected() {
        let mut tracker = seeded();
        tracker.db.pragma_update(None, "foreign_keys", false).unwrap();
        tracker.db.execute_batch("DROP TABLE tasks; CREATE TABLE tasks(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL);").unwrap();
        assert!(initialise_v10(&mut tracker.db).is_err());
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 10);
    }

    #[test]
    fn unversioned_prototype_database_keeps_its_data() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE projects (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL); CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL); CREATE TABLE time_entries (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER); INSERT INTO clients VALUES(1,'A'); INSERT INTO projects VALUES(1,1,'P'); INSERT INTO tasks VALUES(1,1,'T');").unwrap();
        initialise_v10(&mut db).unwrap();
        let tracker = Tracker { db, running_since: None, restored: false };
        assert_eq!(snapshot(&tracker).unwrap().tasks.len(), 1);
        let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 10);
    }

    #[test]
    fn version_one_database_is_migrated_without_losing_entries() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE projects (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL); CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL); CREATE TABLE time_entries (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER); INSERT INTO clients VALUES(1,'A'); INSERT INTO projects VALUES(1,1,'P'); INSERT INTO tasks VALUES(1,1,'T'); INSERT INTO time_entries VALUES(1,1,'2026-01-01T10:00:00Z','2026-01-01T10:01:00Z',60); PRAGMA user_version=1;").unwrap();
        initialise_v10(&mut db).unwrap();
        let tracker = Tracker { db, running_since: None, restored: false };
        let entry = snapshot(&tracker).unwrap().entries.remove(0);
        assert_eq!(entry.duration_seconds, 60);
        assert!(!entry.manually_resolved);
    }

    #[test]
    fn newer_database_version_is_rejected_without_changes() {
        let mut tracker = seeded();
        tracker.db.pragma_update(None, "user_version", 11).unwrap();
        assert!(initialise_v10(&mut tracker.db).is_err());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM tasks",[],|r|r.get::<_,i64>(0)).unwrap(), 2);
        let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 11);
    }

    #[test]
    fn incompatible_legacy_schema_does_not_get_versioned() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE clients (unexpected TEXT);").unwrap();
        assert!(initialise_v10(&mut db).is_err());
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 0);
        assert!(!db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'projects')", [], |r| r.get::<_, bool>(0)).unwrap());
    }
    #[test]
    fn completed_sleep_is_separate_in_report_and_client_export() {
        let mut db = Connection::open_in_memory().unwrap();
        initialise(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'A'),(2,'B'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt A'),(2,2,'Projekt B'); INSERT INTO time_entries(id,project_id,started_at,ended_at,duration_seconds) VALUES(1,1,'2026-01-01T10:00:00Z','2026-01-01T13:00:00Z',10800),(2,2,'2026-01-01T10:00:00Z','2026-01-01T13:00:00Z',10800);").unwrap();
        let start=DateTime::parse_from_rfc3339("2026-01-01T11:00:00Z").unwrap().timestamp_millis();
        db.execute("INSERT INTO sleep_periods(entry_id,started_ms,ended_ms) VALUES(1,?1,?2)",params![start,start+7200000]).unwrap();
        db.execute("INSERT INTO sleep_periods(entry_id,started_ms,ended_ms) VALUES(2,?1,?2)",params![start,start+7200000]).unwrap();
        let mut tracker=Tracker { db, running_since:None, restored:false };
        let report=report_data(&tracker,Utc::now(),Err("unused".into())).unwrap();
        let first=report.entries.iter().find(|entry|entry.id==1).unwrap();
        assert_eq!(first.duration_seconds,3600);
        assert_eq!(first.sleep_periods.as_ref().unwrap()[0].decision,"pending");
        let client=client_export_data(&tracker.db,1).unwrap();
        assert_eq!(client.entries.len(),1);
        assert_eq!(client.entries[0].id,1);
        assert_eq!(client.entries[0].duration_seconds,3600);
        let pending=pending_sleep(&tracker.db).unwrap();
        assert_eq!(pending.len(),2);
        let period_id=client.entries[0].sleep_periods.as_ref().unwrap()[0].id;
        let current=DateTime::parse_from_rfc3339("2026-01-02T10:00:00Z").unwrap().with_timezone(&Utc);
        assert!(correct_entry(&mut tracker,1,"2026-01-01T10:00:00Z","2026-01-01T13:00:00Z","2026-01-01T10:30:00Z","2026-01-01T13:00:00Z",current).is_err());
        assert!(mark_entry_deleted(&mut tracker,1,"2026-01-01T10:00:00Z","2026-01-01T13:00:00Z","2026-01-02T10:00:00Z").is_err());
        crate::sleep_periods::resolve(&mut tracker.db,1,period_id,true,start+7200001).unwrap();
        let report=report_data(&tracker,Utc::now(),Err("unused".into())).unwrap();
        assert_eq!(report.entries.iter().find(|entry|entry.id==1).unwrap().duration_seconds,10800);
        assert_eq!(report.entries.iter().find(|entry|entry.id==2).unwrap().duration_seconds,3600);
        let pending=pending_sleep(&tracker.db).unwrap();
        assert_eq!(pending.len(),1);
        assert_eq!(pending[0].entry_id,2);
    }

    #[test]
    fn recovered_timer_preserves_manually_supplied_sleep_and_pending_decision() {
        let mut db=Connection::open_in_memory().unwrap();
        initialise(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'A'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'P'); INSERT INTO time_entries(id,project_id,started_at) VALUES(1,1,'2026-01-01T10:00:00Z');").unwrap();
        let suspend=DateTime::parse_from_rfc3339("2026-01-01T11:00:00Z").unwrap().timestamp_millis();
        let id=sleep_periods::record_suspend(&mut db,1,suspend).unwrap();
        let mut tracker=Tracker { db,running_since:None,restored:false };
        let now=DateTime::parse_from_rfc3339("2026-01-01T14:00:00Z").unwrap().with_timezone(&Utc);
        assert!(resolve_recovered(&mut tracker,"2026-01-01T13:00:00Z",now).is_err());
        sleep_periods::record_resume_manual(&mut tracker.db,1,id,suspend+7_200_000,now.timestamp_millis()).unwrap();
        assert!(resolve_recovered(&mut tracker,"2026-01-01T12:00:00Z",now).is_err());
        resolve_recovered(&mut tracker,"2026-01-01T13:00:00Z",now).unwrap();
        let snapshot=snapshot(&tracker).unwrap();
        assert!(snapshot.active.is_none());
        assert_eq!(snapshot.entries[0].duration_seconds,3600);
        let period=&snapshot.entries[0].sleep_periods.as_ref().unwrap()[0];
        assert!(period.manual_resume);
        assert_eq!(period.decision,"pending");
    }

}
