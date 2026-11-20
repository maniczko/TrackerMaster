use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

use crate::Cmd;

const DRAFT_SORT_FILE: &str = "draft-sort.txt";

pub(super) fn save_preference(dir: &Path, name: &str, value: &str) -> io::Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!(
        ".{name}-{}-{}-{sequence}.tmp",
        std::process::id(),
        timestamp.as_nanos()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let written = file
        .write_all(value.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    let result = written.and_then(|()| fs::rename(&temp, dir.join(name)));
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn read_preference(dir: &Path, name: &str) -> Cmd<Option<String>> {
    match fs::read_to_string(dir.join(name)) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Nie udało się odczytać ustawienia.".into()),
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DraftSort {
    Newest,
    Oldest,
}

#[tauri::command]
pub(super) fn get_draft_sort(app: AppHandle) -> Cmd<DraftSort> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Nie można ustalić katalogu ustawień.")?;
    match read_preference(&dir, DRAFT_SORT_FILE)?.as_deref() {
        None | Some("newest") => Ok(DraftSort::Newest),
        Some("oldest") => Ok(DraftSort::Oldest),
        Some(_) => Err("Nieprawidłowy zapis kolejności szkiców.".into()),
    }
}

#[tauri::command]
pub(super) fn set_draft_sort(app: AppHandle, order: DraftSort) -> Cmd<()> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Nie można ustalić katalogu ustawień.")?;
    let value = match order {
        DraftSort::Newest => "newest",
        DraftSort::Oldest => "oldest",
    };
    save_preference(&dir, DRAFT_SORT_FILE, value)
        .map_err(|_| "Nie udało się zapamiętać sortowania.".into())
}
