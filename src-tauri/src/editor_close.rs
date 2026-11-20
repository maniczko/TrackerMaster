use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::Cmd;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum CloseAction {
    Hide,
    Quit,
}

#[derive(Clone, Copy, Serialize)]
struct CloseRequest {
    id: u32,
    action: CloseAction,
}

#[derive(Default)]
struct Guard {
    editor_open: bool,
    sequence: u32,
    waiting: Option<CloseRequest>,
}

#[derive(Default)]
pub(super) struct EditorClose(Mutex<Guard>);

pub(super) fn intercept(app: &AppHandle, action: CloseAction) -> bool {
    let state = app.state::<EditorClose>();
    let Ok(mut guard) = state.0.lock() else {
        return true;
    };
    if guard.waiting.is_some() {
        return true;
    }
    if !guard.editor_open {
        return false;
    }
    guard.sequence = guard.sequence.wrapping_add(1);
    let request = CloseRequest {
        id: guard.sequence,
        action,
    };
    if matches!(action, CloseAction::Quit) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
    if app.emit_to("main", "entry-editor-close", request).is_ok() {
        guard.waiting = Some(request);
    }
    true
}

#[tauri::command]
pub(super) fn set_entry_editor_guard(state: State<'_, EditorClose>, open: bool) -> Cmd<()> {
    state
        .0
        .lock()
        .map_err(|_| "Nie można ustalić stanu formularza.")?
        .editor_open = open;
    Ok(())
}

#[tauri::command]
pub(super) fn resolve_entry_editor_close(
    app: AppHandle,
    state: State<'_, EditorClose>,
    request_id: u32,
    proceed: bool,
) -> Cmd<()> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Nie można ustalić stanu formularza.")?;
    let request = guard
        .waiting
        .filter(|request| request.id == request_id)
        .ok_or("Żądanie zamknięcia jest nieaktualne.")?;
    guard.waiting = None;
    if !proceed {
        return Ok(());
    }
    guard.editor_open = false;
    drop(guard);
    match request.action {
        CloseAction::Hide => app
            .get_webview_window("main")
            .ok_or("Brak głównego okna.")?
            .hide()
            .map_err(|error| error.to_string()),
        CloseAction::Quit => {
            crate::request_quit(&app);
            Ok(())
        }
    }
}
