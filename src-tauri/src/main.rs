#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage_safety;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::{sync::Mutex, time::Instant};
use tauri::{Manager, State};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

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
    #[link(name = "user32")]
    extern "system" { fn MessageBoxW(hwnd: *mut std::ffi::c_void, text: *const u16, caption: *const u16, flags: u32) -> i32; }
    let message: Vec<u16> = "Pomiar nadal trwa. Czy chcesz go zatrzymać i zakończyć aplikację?\n\nWybierz Nie, aby kontynuować pomiar."
        .encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "TrackerMaster".encode_utf16().chain(Some(0)).collect();
    // Yes/No, question icon, default to No.
    unsafe { MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), 0x4 | 0x20 | 0x100) == 6 }
}
type Shared = Mutex<Tracker>;
#[derive(Default)]
struct HotkeyState { task_id: Option<i64>, registered: bool, message: String }
type Hotkey = Mutex<HotkeyState>;
#[derive(Default)]
struct RestoreState { sequence: u64, pending: Option<storage_safety::PreparedRestore> }
type Restore = Mutex<RestoreState>;
type Cmd<T> = Result<T, String>;

#[derive(Serialize)]
struct Client { id: i64, name: String }
#[derive(Serialize)]
struct Project { id: i64, client_id: i64, name: String, archived: bool }
#[derive(Serialize)]
struct Task { id: i64, project_id: i64, name: String }
#[derive(Serialize)]
struct Active { id: i64, task_id: i64, started_at: String, recovered: bool }
#[derive(Serialize)]
struct Entry { id: i64, task_id: i64, started_at: String, ended_at: String, duration_seconds: i64, manually_resolved: bool }
#[derive(Serialize)]
struct DeletedEntry { id: i64, task_id: i64, started_at: String, ended_at: String, duration_seconds: i64, deleted_at: String }
#[derive(Serialize)]
struct EntryRevision { id: i64, changed_at: String, before_start: String, before_end: String, before_seconds: i64, after_start: String, after_end: String, after_seconds: i64 }
#[derive(Serialize)]
struct Snapshot { clients: Vec<Client>, projects: Vec<Project>, tasks: Vec<Task>, active: Option<Active>, entries: Vec<Entry> }
#[derive(Serialize)]
struct ReportActive { id: i64, task_id: i64, started_at: String, ended_at: Option<String>, duration_seconds: Option<i64>, unresolved: bool }
#[derive(Serialize)]
struct ReportData { entries: Vec<Entry>, active: Option<ReportActive>, time_zone: String }

fn now() -> String { Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true) }
fn valid_name(name: &str) -> Cmd<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err("Nazwa musi mieć od 1 do 200 znaków i nie może zawierać znaków sterujących.".into());
    }
    Ok(name)
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

fn snapshot(tracker: &Tracker) -> Cmd<Snapshot> {
    let db = &tracker.db;
    let clients = db.prepare("SELECT id,name FROM clients ORDER BY name COLLATE NOCASE,id").map_err(db_err)?
        .query_map([], |r| Ok(Client { id:r.get(0)?, name:r.get(1)? })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let projects = db.prepare("SELECT id,client_id,name,archived FROM projects ORDER BY name COLLATE NOCASE,id").map_err(db_err)?
        .query_map([], |r| Ok(Project { id:r.get(0)?, client_id:r.get(1)?, name:r.get(2)?, archived:r.get(3)? })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let tasks = db.prepare("SELECT id,project_id,name FROM tasks ORDER BY name COLLATE NOCASE,id").map_err(db_err)?
        .query_map([], |r| Ok(Task { id:r.get(0)?, project_id:r.get(1)?, name:r.get(2)? })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let active = db.query_row("SELECT id,task_id,started_at FROM time_entries WHERE ended_at IS NULL", [], |r| Ok(Active {
        id:r.get(0)?, task_id:r.get(1)?, started_at:r.get(2)?, recovered:tracker.running_since.is_none()
    })).optional().map_err(db_err)?;
    let entries = db.prepare("SELECT id,task_id,started_at,ended_at,duration_seconds,manually_resolved FROM time_entries WHERE ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id) ORDER BY id DESC LIMIT 500").map_err(db_err)?
        .query_map([], |r| Ok(Entry { id:r.get(0)?, task_id:r.get(1)?, started_at:r.get(2)?, ended_at:r.get(3)?, duration_seconds:r.get(4)?, manually_resolved:r.get(5)? })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    Ok(Snapshot { clients, projects, tasks, active, entries })
}

#[tauri::command]
fn get_snapshot(state: State<'_, Shared>) -> Cmd<Snapshot> {
    let tracker = locked(&state)?;
    snapshot(&tracker)
}

// Unlike the history preview, a report must include every non-deleted entry.
// The active interval is only a provisional projection and is withheld whenever
// sleep, a clock change, a restart, or an unavailable power sample is detected.
fn report_data(tracker: &Tracker, current: DateTime<Utc>, power: Cmd<PowerSample>) -> Cmd<ReportData> {
    ensure_available(tracker)?;
    let entries = tracker.db.prepare("SELECT id,task_id,started_at,ended_at,duration_seconds,manually_resolved FROM time_entries WHERE ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id) ORDER BY id").map_err(db_err)?
        .query_map([], |r| Ok(Entry { id:r.get(0)?, task_id:r.get(1)?, started_at:r.get(2)?, ended_at:r.get(3)?, duration_seconds:r.get(4)?, manually_resolved:r.get(5)? })).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    let row: Option<(i64, i64, String)> = tracker.db.query_row("SELECT id,task_id,started_at FROM time_entries WHERE ended_at IS NULL", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(db_err)?;
    let active = row.map(|(id, task_id, started_at)| {
        let projection = tracker.running_since.as_ref().and_then(|clock| {
            let power = power.as_ref().ok()?;
            if sleep_or_invalid(clock.power, *power) { return None; }
            let start = DateTime::parse_from_rfc3339(&started_at).ok()?;
            let wall_ms = current.timestamp_millis().checked_sub(start.timestamp_millis())?;
            if wall_ms < 0 { return None; }
            let wall = wall_ms / 1_000;
            let elapsed = i64::try_from(clock.since.elapsed().as_secs()).ok()?;
            if wall < 0 || (wall - elapsed).abs() > 2 { return None; }
            Some((current.to_rfc3339_opts(SecondsFormat::Millis, true), wall))
        });
        let unresolved = projection.is_none();
        let (ended_at, duration_seconds) = match projection { Some((end, duration)) => (Some(end), Some(duration)), None => (None, None) };
        ReportActive { id, task_id, started_at, ended_at, duration_seconds, unresolved }
    });
    let time_zone = tracker.db.query_row("SELECT report_timezone FROM app_settings WHERE id=1", [], |r| r.get(0)).map_err(db_err)?;
    Ok(ReportData { entries, active, time_zone })
}

#[tauri::command]
fn get_report_data(state: State<'_, Shared>) -> Cmd<ReportData> {
    let tracker = locked(&state)?;
    report_data(&tracker, Utc::now(), power_sample())
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
    if restore.sequence.to_string() != token || restore.pending.is_none() { return Err("Przygotowana kopia jest nieaktualna. Sprawdź ją ponownie.".into()); }
    let mut tracker = locked(&state)?;
    if snapshot(&tracker)?.active.is_some() { return Err("Najpierw zakończ lub rozlicz aktywny pomiar.".into()); }
    let prepared = restore.pending.take().ok_or("Nie znaleziono przygotowanej kopii.")?;
    let safety = storage_safety::restore_prepared(&mut tracker.db, &prepared, &data_dir)
        .map_err(|_| "Nie udało się przywrócić kopii. Sprawdź dane i kopie bezpieczeństwa przed ponowieniem.".to_string())?;
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

#[tauri::command]
async fn open_widget(app: tauri::AppHandle) -> Cmd<()> {
    if let Some(window) = app.get_webview_window("widget") {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        let window = tauri::WebviewWindowBuilder::new(&app, "widget", tauri::WebviewUrl::default())
            .title("TrackerMaster — mini timer").inner_size(520.0, 76.0)
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
    let height = if expanded { 390.0 } else { 76.0 };
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
    window.set_size(tauri::LogicalSize::new(520.0, height)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn widget_drag(app: tauri::AppHandle) -> Cmd<()> {
    app.get_webview_window("widget").ok_or("Widget nie jest otwarty.")?.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_widget(app: tauri::AppHandle) -> Cmd<()> {
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

#[tauri::command]
fn set_widget_on_top(app: tauri::AppHandle, on_top: bool) -> Cmd<()> {
    app.get_webview_window("widget").ok_or("Nie znaleziono widgetu.")?
        .set_always_on_top(on_top).map_err(|e| e.to_string())
}
#[tauri::command]
fn create_client(state: State<'_, Shared>, name: String) -> Cmd<i64> {
    let tracker = locked(&state)?;
    tracker.db.execute("INSERT INTO clients(name) VALUES(?1)", [valid_name(&name)?]).map_err(db_err)?;
    Ok(tracker.db.last_insert_rowid())
}
#[tauri::command]
fn create_project(state: State<'_, Shared>, client_id: i64, name: String) -> Cmd<i64> {
    let tracker = locked(&state)?;
    let name = valid_name(&name)?;
    if !tracker.db.query_row("SELECT EXISTS(SELECT 1 FROM clients WHERE id=?1)", [client_id], |r| r.get::<_, bool>(0)).map_err(db_err)? {
        return Err("Wybierz istniejącego klienta.".into());
    }
    tracker.db.execute("INSERT INTO projects(client_id,name) VALUES(?1,?2)", params![client_id,name]).map_err(db_err)?;
    Ok(tracker.db.last_insert_rowid())
}
#[tauri::command]
fn create_task(state: State<'_, Shared>, project_id: i64, name: String) -> Cmd<i64> {
    let tracker = locked(&state)?;
    let name = valid_name(&name)?;
    if !tracker.db.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND archived=0)", [project_id], |r| r.get::<_, bool>(0)).map_err(db_err)? {
        return Err("Wybierz istniejący, niezarchiwizowany projekt.".into());
    }
    tracker.db.execute("INSERT INTO tasks(project_id,name) VALUES(?1,?2)", params![project_id,name]).map_err(db_err)?;
    Ok(tracker.db.last_insert_rowid())
}

fn set_project_archived(db: &mut Connection, project_id: i64, archived: bool) -> Cmd<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    if archived && tx.query_row("SELECT EXISTS(SELECT 1 FROM time_entries e JOIN tasks t ON t.id=e.task_id WHERE t.project_id=?1 AND e.ended_at IS NULL)", [project_id], |r| r.get::<_, bool>(0)).map_err(db_err)? {
        return Err("Najpierw zakończ lub rozstrzygnij aktywny pomiar tego projektu.".into());
    }
    let changed = tx.execute("UPDATE projects SET archived=?1 WHERE id=?2", params![archived, project_id]).map_err(db_err)?;
    if changed == 0 { return Err("Nie znaleziono projektu.".into()); }
    tx.commit().map_err(db_err)
}

#[tauri::command]
fn archive_project(state: State<'_, Shared>, project_id: i64, archived: bool) -> Cmd<()> {
    let mut tracker = locked(&state)?;
    set_project_archived(&mut tracker.db, project_id, archived)
}

// A persisted timer surviving a process restart cannot safely infer how much time was worked.
// Reject stop/switch and leave the durable row for manual recovery.
fn close_active(tracker: &mut Tracker, end: &str, next_task: Option<i64>) -> Cmd<()> {
    ensure_available(tracker)?;
    let elapsed = tracker.running_since.as_ref().map(|clock| clock.since.elapsed().as_secs() as i64);
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
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
        if next_task == Some(active_task) {
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
        tx.execute("UPDATE time_entries SET ended_at=?1,duration_seconds=?2 WHERE id=?3 AND ended_at IS NULL",params![end,seconds,id]).map_err(db_err)?;
    } else if next_task.is_none() {
        return Err("Nie ma aktywnego pomiaru.".into());
    }
    if let Some(task_id) = next_task {
        if !tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?1 AND p.archived=0)", [task_id], |r|r.get::<_,bool>(0)).map_err(db_err)? {
            return Err("Wybierz istniejące zadanie w niezarchiwizowanym projekcie.".into());
        }
        tx.execute("INSERT INTO time_entries(task_id,started_at) VALUES(?1,?2)",params![task_id,end]).map_err(db_err)?;
    }
    let next_clock = if next_task.is_some() { Some(RunningClock { since: Instant::now(), power: power_sample()? }) } else { None };
    tx.commit().map_err(db_err)?;
    tracker.running_since = next_clock;
    Ok(())
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
fn start_timer(state: State<'_, Shared>, task_id: i64, expected_active_id: Option<i64>) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    change_timer_if_current(&mut tracker, expected_active_id, Some(task_id))?;
    snapshot(&tracker)
}
#[tauri::command]
fn stop_timer(state: State<'_, Shared>, expected_active_id: i64) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    change_timer_if_current(&mut tracker, Some(expected_active_id), None)?;
    snapshot(&tracker)
}

#[tauri::command]
fn set_shortcut_task(state: State<'_, Hotkey>, task_id: Option<i64>) -> Cmd<()> {
    state.lock().map_err(|_| "Błąd skrótu.".to_string())?.task_id = task_id;
    Ok(())
}
#[derive(Serialize)]
struct ShortcutStatus { registered: bool, message: String }
#[tauri::command]
fn shortcut_status(state: State<'_, Hotkey>) -> Cmd<ShortcutStatus> {
    let hotkey = state.lock().map_err(|_| "Błąd skrótu.".to_string())?;
    Ok(ShortcutStatus { registered: hotkey.registered, message: hotkey.message.clone() })
}

#[tauri::command]
fn widget_start(state: State<'_, Shared>, task_id: i64) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    if snapshot(&tracker)?.active.is_some() { return Err("Pomiar już trwa. Sprawdź aktualny stan.".into()); }
    close_active(&mut tracker, &now(), Some(task_id))?;
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
    let (id, start) = active.ok_or("Nie ma pomiaru do odzyskania.")?;
    let start = DateTime::parse_from_rfc3339(&start).map_err(|_| "Niepoprawny zapis czasu w bazie.")?.with_timezone(&Utc);
    if end < start { return Err("Zakończenie nie może być przed rozpoczęciem pomiaru.".into()); }
    tx.execute("UPDATE time_entries SET ended_at=?1,duration_seconds=?2,manually_resolved=1 WHERE id=?3 AND ended_at IS NULL", params![end.to_rfc3339_opts(SecondsFormat::Millis, true), (end - start).num_seconds(), id]).map_err(db_err)?;
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
    let (start, end) = parse_manual_range(started_at, ended_at, current)?;
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let valid_task = tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?1 AND p.archived=0)", [task_id], |r| r.get::<_, bool>(0)).map_err(db_err)?;
    if !valid_task { return Err("Wybierz zadanie w aktywnym projekcie.".into()); }
    ensure_no_overlap(&tx, start, end, None)?;
    let start_text = start.to_rfc3339_opts(SecondsFormat::Millis, true);
    let end_text = end.to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds,manually_resolved) VALUES(?1,?2,?3,?4,1)", params![task_id,start_text,end_text,(end-start).num_seconds()]).map_err(db_err)?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(db_err)?;
    Ok(id)
}

fn correct_entry(tracker: &mut Tracker, entry_id: i64, expected_start: &str, expected_end: &str, started_at: &str, ended_at: &str, current: DateTime<Utc>) -> Cmd<()> {
    let (start, end) = parse_manual_range(started_at, ended_at, current)?;
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let previous: Option<(String, String, i64)> = tx.query_row("SELECT started_at,ended_at,duration_seconds FROM time_entries WHERE id=?1 AND ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id)", [entry_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db_err)?;
    let (old_start, old_end, old_seconds) = previous.ok_or("Nie znaleziono zakończonego wpisu.")?;
    if old_start != expected_start || old_end != expected_end { return Err("Wpis zmienił się w innym oknie. Odśwież dane przed korektą.".into()); }
    ensure_no_overlap(&tx, start, end, Some(entry_id))?;
    let new_start = start.to_rfc3339_opts(SecondsFormat::Millis, true);
    let new_end = end.to_rfc3339_opts(SecondsFormat::Millis, true);
    let seconds = (end - start).num_seconds();
    if old_start == new_start && old_end == new_end { return Ok(()); }
    tx.execute("INSERT INTO entry_revisions(entry_id,changed_at,before_start,before_end,before_seconds,after_start,after_end,after_seconds) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![entry_id,current.to_rfc3339_opts(SecondsFormat::Millis, true),old_start,old_end,old_seconds,new_start,new_end,seconds]).map_err(db_err)?;
    tx.execute("UPDATE time_entries SET started_at=?1,ended_at=?2,duration_seconds=?3,manually_resolved=1 WHERE id=?4", params![new_start,new_end,seconds,entry_id]).map_err(db_err)?;
    tx.commit().map_err(db_err)
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

fn mark_entry_deleted(tracker: &mut Tracker, entry_id: i64, expected_start: &str, expected_end: &str, deleted_at: &str) -> Cmd<()> {
    let tx = tracker.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
    let entry: Option<(String, String)> = tx.query_row("SELECT started_at,ended_at FROM time_entries WHERE id=?1 AND ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entry_deletions d WHERE d.entry_id=time_entries.id)", [entry_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_err)?;
    let (start, end) = entry.ok_or("Nie znaleziono zakończonego wpisu lub wpis został już usunięty.")?;
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
    let mut stmt = tracker.db.prepare("SELECT e.id,e.task_id,e.started_at,e.ended_at,e.duration_seconds,d.deleted_at FROM entry_deletions d JOIN time_entries e ON e.id=d.entry_id ORDER BY d.deleted_at DESC,e.id DESC LIMIT 500").map_err(db_err)?;
    let entries = stmt.query_map([], |r| Ok(DeletedEntry { id:r.get(0)?,task_id:r.get(1)?,started_at:r.get(2)?,ended_at:r.get(3)?,duration_seconds:r.get(4)?,deleted_at:r.get(5)? })).map_err(db_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    Ok(entries)
}

#[tauri::command]
fn create_manual_entry(state: State<'_, Shared>, task_id: i64, started_at: String, ended_at: String) -> Cmd<Snapshot> {
    let mut tracker = locked(&state)?;
    add_manual_entry(&mut tracker, task_id, &started_at, &ended_at, Utc::now())?;
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

fn initialise(db: &mut Connection) -> rusqlite::Result<()> {
    db.pragma_update(None, "foreign_keys", true)?;
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > 6 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if version == 6 {
        validate_schema(db)?;
        validate_revisions_schema(db)?;
        validate_deletions_schema(db)?;
        return validate_settings_schema(db);
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
    tx.execute_batch("CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK(id=1), report_timezone TEXT NOT NULL); INSERT INTO app_settings(id,report_timezone) VALUES(1,'Europe/Warsaw');")?;
    validate_settings_schema(&tx)?;
    tx.pragma_update(None, "user_version", 6)?;
    tx.commit()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
            if event.state() != ShortcutState::Pressed { return; }
            let hotkey = app.state::<Hotkey>();
            let Ok(mut hotkey) = hotkey.lock() else { return; };
            let shared = app.state::<Shared>();
            let Ok(mut tracker) = shared.lock() else { hotkey.message = "Nie można odczytać timera.".into(); return; };
            let result = match snapshot(&tracker) {
                Ok(current) if current.active.is_some() => close_active(&mut tracker, &now(), None),
                Ok(_) => match hotkey.task_id {
                    Some(task_id) => close_active(&mut tracker, &now(), Some(task_id)),
                    None => Err("Wybierz zadanie w mini timerze przed użyciem skrótu.".into()),
                },
                Err(err) => Err(err),
            };
            hotkey.message = result.err().unwrap_or_default();
        }).build())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            #[cfg(windows)]
            {
                let guard = lock_instance(&dir).map_err(|err| {
                    let message = if err.raw_os_error() == Some(32) {
                        "TrackerMaster jest już uruchomiony. Otwórz jego istniejące okno."
                    } else {
                        "Nie można zabezpieczyć dostępu do danych. Sprawdź uprawnienia katalogu aplikacji."
                    };
                    show_start_error(message);
                    err
                })?;
                app.manage(guard);
            }
            let database_path = dir.join("tracker.sqlite3");
            storage_safety::preflight_existing(&database_path).map_err(|err| {
                #[cfg(windows)]
                show_start_error("Nie można bezpiecznie zweryfikować bazy danych. Nie zmieniaj ani nie usuwaj pliku; sprawdź kopię zapasową.");
                err
            })?;
            let mut db = Connection::open(&database_path)?;
            initialise(&mut db).map_err(|err| {
                #[cfg(windows)]
                show_start_error("Nie można bezpiecznie otworzyć bazy danych. Nie zmieniaj ani nie usuwaj jej; sprawdź kopię i skontaktuj się z osobą pomagającą w obsłudze aplikacji.");
                err
            })?;
            app.manage(Mutex::new(Tracker { db, running_since: None, restored: false }));
            app.manage(Mutex::new(HotkeyState::default()));
            app.manage(Mutex::new(RestoreState::default()));
            let registered = app.global_shortcut().register("Ctrl+Shift+Space");
            if let Ok(mut state) = app.state::<Hotkey>().lock() {
                state.registered = registered.is_ok();
                if registered.is_err() { state.message = "Globalny skrót Ctrl+Shift+Spacja jest niedostępny lub zajęty. Działa tylko w oknie widgetu.".into(); }
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
                        let shared = app.state::<Shared>();
                        let guard = shared.lock();
                        let active = guard.as_ref().map_err(|_| "Błąd dostępu do danych lokalnych.".to_string())
                            .and_then(|tracker| snapshot(tracker).map(|s| s.active));
                        if matches!(active, Ok(None)) { app.exit(0); }
                        else {
                            // Do not hold the tracker lock or block the UI thread during a dialog.
                            drop(guard);
                            let main_app = app.clone(); tauri::async_runtime::spawn(async move { let _ = show_main(main_app).await; });
                            #[cfg(windows)]
                            {
                                let app = app.clone();
                                std::thread::spawn(move || match active {
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
                                });
                            }
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
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_snapshot,get_report_data,set_report_timezone,create_backup,diagnose_database,prepare_backup_restore,cancel_backup_restore,apply_backup_restore,exit_after_restore,create_client,create_project,create_task,archive_project,start_timer,stop_timer,recover_timer,create_manual_entry,edit_time_entry,entry_revisions,delete_time_entry,deleted_entries,open_widget,show_main,set_widget_on_top,widget_start,widget_stop,widget_panel,widget_drag,close_widget,set_shortcut_task,shortcut_status])
        .run(tauri::generate_context!())
        .expect("Nie można uruchomić aplikacji");
}

#[cfg(test)]
mod tests {
    use super::*;

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
        initialise(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES (1,'A');
            INSERT INTO projects(id,client_id,name) VALUES (1,1,'P');
            INSERT INTO tasks(id,project_id,name) VALUES (1,1,'T1'),(2,1,'T2');").unwrap();
        Tracker { db, running_since: None, restored: false }
    }

    #[test]
    fn timezone_migration_preserves_history_and_uses_optimistic_updates() {
        let mut tracker = seeded();
        tracker.db.execute_batch("INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds) VALUES(1,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z',3600); DROP TABLE app_settings; PRAGMA user_version=5;").unwrap();
        initialise(&mut tracker.db).unwrap();
        let report = report_data(&tracker, Utc::now(), Err("clock".into())).unwrap();
        assert_eq!(report.time_zone, "Europe/Warsaw");
        assert_eq!(report.entries.len(), 1);
        update_report_timezone(&tracker.db, "Europe/Warsaw", "Europe/London").unwrap();
        assert!(update_report_timezone(&tracker.db, "Europe/Warsaw", "Europe/Berlin").is_err());
        assert!(update_report_timezone(&tracker.db, "Europe/London", "invalid zone").is_err());
        initialise(&mut tracker.db).unwrap();
        assert_eq!(report_data(&tracker, Utc::now(), Err("clock".into())).unwrap().time_zone, "Europe/London");
    }

    #[test]
    fn timezone_migration_rolls_back_when_table_already_exists() {
        let mut tracker = seeded();
        tracker.db.pragma_update(None, "user_version", 5).unwrap();
        assert!(initialise(&mut tracker.db).is_err());
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 5);
        assert_eq!(snapshot(&tracker).unwrap().tasks.len(), 2);
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
        tracker.db.execute_batch("DROP TABLE app_settings; DROP TABLE entry_deletions; DROP TABLE entry_revisions; ALTER TABLE projects DROP COLUMN archived; PRAGMA user_version=2;").unwrap();
        initialise(&mut tracker.db).unwrap();
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
            initialise(&mut db).unwrap();
            db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient testowy'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt testowy'); INSERT INTO tasks(id,project_id,name) VALUES(1,1,'Zadanie testowe'); INSERT INTO time_entries(task_id,started_at,ended_at,duration_seconds) VALUES(1,'2026-01-01T10:00:00Z','2026-01-01T10:01:00Z',60); DROP TABLE app_settings; DROP TABLE entry_deletions; DROP TABLE entry_revisions; ALTER TABLE projects DROP COLUMN archived; PRAGMA user_version=2;").unwrap();
        }
        {
            let mut db = Connection::open(&path).unwrap();
            initialise(&mut db).unwrap();
            set_project_archived(&mut db, 1, true).unwrap();
        }
        {
            let mut db = Connection::open(&path).unwrap();
            initialise(&mut db).unwrap();
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
        tracker.db.execute_batch("DROP TABLE app_settings; DROP TABLE entry_deletions; DROP TABLE entry_revisions; ALTER TABLE projects DROP COLUMN archived; ALTER TABLE time_entries DROP COLUMN manually_resolved; PRAGMA user_version=2;").unwrap();
        assert!(initialise(&mut tracker.db).is_err());
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
        assert_eq!(s.entries[0].task_id, 1);
        assert_eq!(s.active.unwrap().task_id, 2);
    }

    #[test]
    fn invalid_switch_rolls_back_the_old_timer() {
        let mut tracker = seeded();
        close_active(&mut tracker, &now(), Some(1)).unwrap();
        assert!(close_active(&mut tracker, &now(), Some(999)).is_err());
        let s = snapshot(&tracker).unwrap();
        assert_eq!(s.active.unwrap().task_id, 1);
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
        assert_eq!((active.id, active.task_id), (active_id, 1));
        assert!(!active.recovered);
        assert!(state.entries.is_empty());

        tracker.db.execute_batch("DROP TRIGGER reject_new_entry;").unwrap();
        close_active(&mut tracker, &now(), Some(2)).unwrap();
        let state = snapshot(&tracker).unwrap();
        assert_eq!(state.active.unwrap().task_id, 2);
        assert_eq!(state.entries.len(), 1);
        assert_eq!(state.entries[0].id, active_id);
        assert_eq!(state.entries[0].task_id, 1);
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
        tracker.db.execute_batch("DROP TABLE app_settings; DROP TABLE entry_deletions; DROP TABLE entry_revisions; PRAGMA user_version=3;").unwrap();
        initialise(&mut tracker.db).unwrap();
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 1);
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 6);
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
        tracker.db.execute_batch("DROP TABLE app_settings; DROP TABLE entry_deletions; PRAGMA user_version=4;").unwrap();
        initialise(&mut tracker.db).unwrap();
        assert_eq!(snapshot(&tracker).unwrap().entries.len(), 1);
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM entry_revisions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 6);
    }

    #[test]
    fn active_timer_cannot_be_deleted_and_corrupt_marker_is_rejected_on_startup() {
        let mut tracker = seeded();
        tracker.db.execute("INSERT INTO time_entries(task_id,started_at) VALUES(1,'2026-01-01T10:00:00Z')", []).unwrap();
        let id = snapshot(&tracker).unwrap().active.unwrap().id;
        assert!(mark_entry_deleted(&mut tracker, id, "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", &now()).is_err());
        assert!(snapshot(&tracker).unwrap().active.is_some());
        tracker.db.execute("INSERT INTO entry_deletions(entry_id,deleted_at) VALUES(?1,?2)", params![id,now()]).unwrap();
        assert!(initialise(&mut tracker.db).is_err());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM entry_deletions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn deletion_migration_rolls_back_if_unexpected_table_exists() {
        let mut tracker = seeded();
        tracker.db.execute_batch("DROP TABLE app_settings; DROP TABLE entry_deletions; CREATE TABLE entry_deletions(unexpected TEXT); PRAGMA user_version=4;").unwrap();
        assert!(initialise(&mut tracker.db).is_err());
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
        initialise(&mut tracker.db).unwrap();
        let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 6);
        assert_eq!(snapshot(&tracker).unwrap().tasks.len(), 2);
    }

    #[test]
    fn current_schema_missing_timer_guard_is_rejected_without_repair() {
        let mut tracker = seeded();
        tracker.db.execute_batch("DROP INDEX one_running_timer;").unwrap();
        assert!(initialise(&mut tracker.db).is_err());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        let index_exists: bool = tracker.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='one_running_timer')", [], |r| r.get(0)).unwrap();
        assert!(!index_exists);
    }

    #[test]
    fn current_schema_with_broken_relationship_is_rejected() {
        let mut tracker = seeded();
        tracker.db.pragma_update(None, "foreign_keys", false).unwrap();
        tracker.db.execute("INSERT INTO projects(id,client_id,name) VALUES(2,999,'Orphan')", []).unwrap();
        assert!(initialise(&mut tracker.db).is_err());
        assert_eq!(tracker.db.query_row("SELECT COUNT(*) FROM projects WHERE id=2", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn current_schema_without_foreign_key_is_rejected() {
        let mut tracker = seeded();
        tracker.db.pragma_update(None, "foreign_keys", false).unwrap();
        tracker.db.execute_batch("DROP TABLE tasks; CREATE TABLE tasks(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL);").unwrap();
        assert!(initialise(&mut tracker.db).is_err());
        assert_eq!(tracker.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 6);
    }

    #[test]
    fn unversioned_prototype_database_keeps_its_data() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE projects (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL); CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL); CREATE TABLE time_entries (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER); INSERT INTO clients VALUES(1,'A'); INSERT INTO projects VALUES(1,1,'P'); INSERT INTO tasks VALUES(1,1,'T');").unwrap();
        initialise(&mut db).unwrap();
        let tracker = Tracker { db, running_since: None, restored: false };
        assert_eq!(snapshot(&tracker).unwrap().tasks.len(), 1);
        let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 6);
    }

    #[test]
    fn version_one_database_is_migrated_without_losing_entries() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE projects (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL); CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL); CREATE TABLE time_entries (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER); INSERT INTO clients VALUES(1,'A'); INSERT INTO projects VALUES(1,1,'P'); INSERT INTO tasks VALUES(1,1,'T'); INSERT INTO time_entries VALUES(1,1,'2026-01-01T10:00:00Z','2026-01-01T10:01:00Z',60); PRAGMA user_version=1;").unwrap();
        initialise(&mut db).unwrap();
        let tracker = Tracker { db, running_since: None, restored: false };
        let entry = snapshot(&tracker).unwrap().entries.remove(0);
        assert_eq!(entry.duration_seconds, 60);
        assert!(!entry.manually_resolved);
    }

    #[test]
    fn newer_database_version_is_rejected_without_changes() {
        let mut tracker = seeded();
        tracker.db.pragma_update(None, "user_version", 7).unwrap();
        assert!(initialise(&mut tracker.db).is_err());
        assert_eq!(snapshot(&tracker).unwrap().tasks.len(), 2);
        let version: i64 = tracker.db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 7);
    }

    #[test]
    fn incompatible_legacy_schema_does_not_get_versioned() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE clients (unexpected TEXT);").unwrap();
        assert!(initialise(&mut db).is_err());
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 0);
        assert!(!db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'projects')", [], |r| r.get::<_, bool>(0)).unwrap());
    }
}
