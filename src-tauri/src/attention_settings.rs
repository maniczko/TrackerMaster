//! Validated reminder & idle detection preferences persisted in `attention-settings.json`
//! using the atomic preference writer (TECH-12 §2.4, I22). No entry/activity data lives here.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::ui_preferences::save_preference;

pub const ATTENTION_SETTINGS_FILE: &str = "attention-settings.json";
pub const CORRUPT_SETTINGS_WARNING: &str = "Nie udało się odczytać ustawień przypomnień, przywrócono domyślne.";

pub const IDLE_THRESHOLDS: &[u32] = &[5, 10, 15, 30, 60];
pub const FIRST_REMINDER_MINUTES: &[u32] = &[5, 10, 15, 30, 60];
pub const REPEAT_REMINDER_MINUTES: &[u32] = &[15, 30, 60, 120];
pub const LONG_TIMER_HOURS: &[u32] = &[2, 3, 4, 6, 8];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSettings {
    pub idle_enabled: bool,
    pub idle_threshold_minutes: u32,
    pub start_reminder_enabled: bool,
    pub workdays: Vec<u8>,
    pub work_start: String,
    pub work_end: String,
    pub first_reminder_minutes: u32,
    pub repeat_reminder_minutes: u32,
    pub long_timer_enabled: bool,
    pub long_timer_hours: u32,
    pub notifications_enabled: bool,
}

impl Default for AttentionSettings {
    fn default() -> Self {
        Self {
            idle_enabled: true,
            idle_threshold_minutes: 10,
            start_reminder_enabled: true,
            workdays: vec![1, 2, 3, 4, 5],
            work_start: "09:00".into(),
            work_end: "17:00".into(),
            first_reminder_minutes: 15,
            repeat_reminder_minutes: 30,
            long_timer_enabled: true,
            long_timer_hours: 4,
            notifications_enabled: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSettingsRead {
    pub settings: AttentionSettings,
    pub warning: Option<String>,
}

pub fn parse_hhmm_minutes(text: &str) -> Option<u32> {
    let (h, m) = text.split_once(':')?;
    if h.len() != 2 || m.len() != 2 || !h.bytes().all(|b| b.is_ascii_digit()) || !m.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hour: u32 = h.parse().ok()?;
    let min: u32 = m.parse().ok()?;
    if hour > 23 || min > 59 {
        return None;
    }
    Some(hour * 60 + min)
}

pub fn validate(settings: &AttentionSettings) -> Result<(), &'static str> {
    if !IDLE_THRESHOLDS.contains(&settings.idle_threshold_minutes) {
        return Err("Dozwolone progi bezczynności to: 5, 10, 15, 30 lub 60 minut.");
    }
    if settings.workdays.is_empty()
        || settings.workdays.iter().any(|&day| !(1..=7).contains(&day))
    {
        return Err("Wybierz co najmniej jeden prawidłowy dzień tygodnia.");
    }
    let mut dedup = settings.workdays.clone();
    dedup.sort_unstable();
    dedup.dedup();
    if dedup.len() != settings.workdays.len() {
        return Err("Dni robocze nie mogą się powtarzać.");
    }
    let start = parse_hhmm_minutes(&settings.work_start)
        .ok_or("Nieprawidłowa godzina rozpoczęcia pracy (HH:MM).")?;
    let end = parse_hhmm_minutes(&settings.work_end)
        .ok_or("Nieprawidłowa godzina zakończenia pracy (HH:MM).")?;
    if start >= end {
        return Err("Godzina końca pracy musi być późniejsza niż godzina rozpoczęcia.");
    }
    if !FIRST_REMINDER_MINUTES.contains(&settings.first_reminder_minutes) {
        return Err("Dozwolone opóźnienie pierwszego przypomnienia to: 5, 10, 15, 30 lub 60 min.");
    }
    if !REPEAT_REMINDER_MINUTES.contains(&settings.repeat_reminder_minutes) {
        return Err("Dozwolony interwał przypomnień to: 15, 30, 60 lub 120 min.");
    }
    if !LONG_TIMER_HOURS.contains(&settings.long_timer_hours) {
        return Err("Dozwolony próg długiego pomiaru to: 2, 3, 4, 6 lub 8 godzin.");
    }
    Ok(())
}

/// Read attention settings from app data dir. Missing file -> defaults cleanly; corrupt JSON
/// or out-of-bounds values -> defaults (idle_enabled stays true!) with CORRUPT_SETTINGS_WARNING (I22).
pub fn read_settings(dir: &Path) -> AttentionSettingsRead {
    let path = dir.join(ATTENTION_SETTINGS_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return AttentionSettingsRead { settings: AttentionSettings::default(), warning: None };
        }
        Err(_) => {
            return AttentionSettingsRead {
                settings: AttentionSettings::default(),
                warning: Some(CORRUPT_SETTINGS_WARNING.into()),
            };
        }
    };
    match serde_json::from_str::<AttentionSettings>(&raw) {
        Ok(mut parsed) => {
            parsed.workdays.sort_unstable();
            if validate(&parsed).is_ok() {
                AttentionSettingsRead { settings: parsed, warning: None }
            } else {
                AttentionSettingsRead {
                    settings: AttentionSettings::default(),
                    warning: Some(CORRUPT_SETTINGS_WARNING.into()),
                }
            }
        }
        Err(_) => AttentionSettingsRead {
            settings: AttentionSettings::default(),
            warning: Some(CORRUPT_SETTINGS_WARNING.into()),
        },
    }
}

pub fn write_settings(dir: &Path, settings: &AttentionSettings) -> Result<(), String> {
    let mut normalized = settings.clone();
    normalized.workdays.sort_unstable();
    normalized.workdays.dedup();
    validate(&normalized).map_err(str::to_string)?;
    let serialized = serde_json::to_string_pretty(&normalized)
        .map_err(|_| "Nie udało się zapisać ustawień przypomnień.".to_string())?;
    save_preference(dir, ATTENTION_SETTINGS_FILE, &serialized)
        .map_err(|_| "Nie udało się zapisać ustawień przypomnień.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tm-att-settings-{label}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // I22: missing, corrupt or out-of-range settings file returns safe defaults without disabling idle.
    #[test]
    fn missing_corrupt_and_invalid_settings_fall_back_safely_keeping_idle_enabled() {
        let dir = temp_dir("i22");
        let missing = read_settings(&dir);
        assert_eq!(missing.settings, AttentionSettings::default());
        assert_eq!(missing.warning, None);

        std::fs::write(dir.join(ATTENTION_SETTINGS_FILE), "{not valid json").unwrap();
        let corrupt = read_settings(&dir);
        assert_eq!(corrupt.settings, AttentionSettings::default());
        assert!(corrupt.settings.idle_enabled);
        assert_eq!(corrupt.warning.as_deref(), Some(CORRUPT_SETTINGS_WARNING));

        let mut bad = AttentionSettings::default();
        bad.idle_enabled = false;
        bad.idle_threshold_minutes = 7; // disallowed value
        std::fs::write(dir.join(ATTENTION_SETTINGS_FILE), serde_json::to_string(&bad).unwrap()).unwrap();
        let invalid = read_settings(&dir);
        assert_eq!(invalid.settings, AttentionSettings::default());
        assert!(invalid.settings.idle_enabled, "idle detection must never silently turn off on corrupt settings");
        assert_eq!(invalid.warning.as_deref(), Some(CORRUPT_SETTINGS_WARNING));

        let mut custom = AttentionSettings::default();
        custom.idle_threshold_minutes = 15;
        custom.workdays = vec![5, 1, 3];
        custom.work_start = "08:30".into();
        custom.work_end = "16:30".into();
        write_settings(&dir, &custom).unwrap();
        let roundtrip = read_settings(&dir);
        assert_eq!(roundtrip.warning, None);
        assert_eq!(roundtrip.settings.idle_threshold_minutes, 15);
        assert_eq!(roundtrip.settings.workdays, vec![1, 3, 5]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
