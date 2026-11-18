use chrono::NaiveDate;
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

const REPORT_FILTER_FILE: &str = "report-date-filter.txt";
const WIDGET_PIN_FILE: &str = "widget-on-top.txt";
const DRAFT_SORT_FILE: &str = "draft-sort.txt";
const INVALID_REPORT_FILTER: &str = "Nieprawidłowy zakres raportu.";

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

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(super) enum ReportFilter {
    Today,
    Week,
    Custom { from: String, through: String },
}

fn valid_report_date(value: &str) -> bool {
    value.len() == 10
        && value >= "1970-01-01"
        && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok_and(|date| date.to_string() == value)
}

impl ReportFilter {
    fn encode(&self) -> Cmd<String> {
        match self {
            Self::Today => Ok("today".into()),
            Self::Week => Ok("week".into()),
            Self::Custom { from, through }
                if valid_report_date(from) && valid_report_date(through) && from <= through =>
            {
                Ok(format!("custom\n{from}\n{through}"))
            }
            Self::Custom { .. } => Err(INVALID_REPORT_FILTER.into()),
        }
    }

    fn decode(value: &str) -> Cmd<Self> {
        let filter = match value.split('\n').collect::<Vec<_>>().as_slice() {
            ["today"] => Self::Today,
            ["week"] => Self::Week,
            ["custom", from, through] => Self::Custom {
                from: (*from).into(),
                through: (*through).into(),
            },
            _ => return Err(INVALID_REPORT_FILTER.into()),
        };
        filter.encode()?;
        Ok(filter)
    }
}

fn set_report_filter_at(dir: &Path, filter: &ReportFilter) -> Cmd<()> {
    save_preference(dir, REPORT_FILTER_FILE, &filter.encode()?)
        .map_err(|_| "Nie udało się zapisać zakresu raportu.".into())
}

fn get_report_filter_at(
    dir: &Path,
    legacy_filter: Option<ReportFilter>,
) -> Cmd<Option<ReportFilter>> {
    if let Some(stored) = read_preference(dir, REPORT_FILTER_FILE)? {
        return ReportFilter::decode(&stored).map(Some);
    }
    if let Some(filter) = &legacy_filter {
        set_report_filter_at(dir, filter)?;
    }
    Ok(legacy_filter)
}

#[tauri::command]
pub(super) fn get_report_filter(
    app: AppHandle,
    legacy_filter: Option<ReportFilter>,
) -> Cmd<Option<ReportFilter>> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Nie można ustalić katalogu ustawień.")?;
    get_report_filter_at(&dir, legacy_filter)
}

#[tauri::command]
pub(super) fn set_report_filter(app: AppHandle, filter: ReportFilter) -> Cmd<()> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Nie można ustalić katalogu ustawień.")?;
    set_report_filter_at(&dir, &filter)
}

fn widget_pin_at(dir: &Path, legacy_on_top: Option<bool>) -> Cmd<bool> {
    if let Some(stored) = read_preference(dir, WIDGET_PIN_FILE)? {
        return stored
            .parse()
            .map_err(|_| "Nieprawidłowe ustawienie przypięcia okna.".into());
    }
    if let Some(on_top) = legacy_on_top {
        save_widget_pin(dir, on_top)?;
    }
    Ok(legacy_on_top.unwrap_or(false))
}

fn save_widget_pin(dir: &Path, on_top: bool) -> Cmd<()> {
    save_preference(dir, WIDGET_PIN_FILE, if on_top { "true" } else { "false" })
        .map_err(|_| "Nie udało się zapisać przypięcia okna.".into())
}

#[tauri::command]
pub(super) fn restore_widget_on_top(app: AppHandle, legacy_on_top: Option<bool>) -> Cmd<bool> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Nie można ustalić katalogu ustawień.")?;
    let window = app
        .get_webview_window("widget")
        .ok_or("Nie znaleziono widgetu.")?;
    let on_top = widget_pin_at(&dir, legacy_on_top)?;
    window
        .set_always_on_top(on_top)
        .map_err(|e| e.to_string())?;
    Ok(on_top)
}

#[tauri::command]
pub(super) fn set_widget_on_top(app: AppHandle, on_top: bool) -> Cmd<()> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Nie można ustalić katalogu ustawień.")?;
    let window = app
        .get_webview_window("widget")
        .ok_or("Nie znaleziono widgetu.")?;
    let old = window.is_always_on_top().map_err(|e| e.to_string())?;
    window
        .set_always_on_top(on_top)
        .map_err(|e| e.to_string())?;
    if let Err(error) = save_widget_pin(&dir, on_top) {
        window
            .set_always_on_top(old)
            .map_err(|e| format!("{error} {e}"))?;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(label: &str) -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "tracker-{label}-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir(&dir).unwrap();
        dir
    }

    fn clean_up(dir: &Path, name: &str) {
        fs::remove_file(dir.join(name)).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn report_filter_migrates_once_and_keeps_the_last_valid_range() {
        let dir = test_directory("report-filter");
        let dir = dir.as_path();
        assert_eq!(get_report_filter_at(dir, None).unwrap(), None);
        assert_eq!(
            get_report_filter_at(dir, Some(ReportFilter::Week)).unwrap(),
            Some(ReportFilter::Week)
        );
        let custom = ReportFilter::Custom {
            from: "2024-02-29".into(),
            through: "2024-03-01".into(),
        };
        set_report_filter_at(dir, &custom).unwrap();
        let invalid = ReportFilter::Custom {
            from: "2025-02-29".into(),
            through: "2025-03-01".into(),
        };
        assert!(set_report_filter_at(dir, &invalid).is_err());
        assert_eq!(
            get_report_filter_at(dir, Some(ReportFilter::Today)).unwrap(),
            Some(custom)
        );
        clean_up(dir, REPORT_FILTER_FILE);
    }

    #[test]
    fn widget_pin_uses_the_native_value_after_migration() {
        let dir = test_directory("widget-pin");
        let dir = dir.as_path();
        assert!(!widget_pin_at(dir, None).unwrap());
        assert!(widget_pin_at(dir, Some(true)).unwrap());
        save_widget_pin(dir, false).unwrap();
        assert!(!widget_pin_at(dir, Some(true)).unwrap());
        assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
        clean_up(dir, WIDGET_PIN_FILE);
    }
}
