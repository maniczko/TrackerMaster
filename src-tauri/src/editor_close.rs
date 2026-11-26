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
        return false;
    };
    if !guard.editor_open {
        guard.waiting = None;
        return false;
    }
    if guard.waiting.is_some() {
        return true;
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
        true
    } else {
        guard.waiting = None;
        false
    }
}

#[tauri::command]
pub(super) fn set_entry_editor_guard(state: State<'_, EditorClose>, open: bool) -> Cmd<()> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Nie można ustalić stanu formularza.")?;
    guard.editor_open = open;
    if !open {
        guard.waiting = None;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_clears_waiting_when_closed_and_tracks_sequence() {
        let close = EditorClose::default();
        {
            let mut guard = close.0.lock().unwrap();
            guard.editor_open = true;
            guard.sequence = 1;
            guard.waiting = Some(CloseRequest {
                id: 1,
                action: CloseAction::Hide,
            });
            guard.editor_open = false;
            guard.waiting = None;
        }
        let guard = close.0.lock().unwrap();
        assert!(!guard.editor_open);
        assert!(guard.waiting.is_none());
    }
}
