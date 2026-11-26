//! Idle detection (GetLastInputInfo / GetTickCount) & reminders (TECH-12 / DEV-39).
//! Stores zero activity logs or foreground/window titles; only idle periods >= threshold
//! enter `sleep_periods` as `source='idle'`. Lock order: Shared (`Tracker`) BEFORE AttentionState.

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat, TimeZone, Timelike, Utc};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::{
    attention_settings::{
        parse_hhmm_minutes, read_settings, write_settings, AttentionSettings, AttentionSettingsRead,
    },
    db_err, ensure_available, locked, sleep_periods, Cmd, Shared, Tracker,
};

#[cfg(windows)]
pub type SharedAttention = Arc<Mutex<AttentionRuntime>>;
#[cfg(not(windows))]
#[allow(dead_code)]
pub type SharedAttention = Arc<Mutex<AttentionRuntime>>;

static GLOBAL_ATTENTION: OnceLock<Arc<Mutex<AttentionRuntime>>> = OnceLock::new();

pub const POLL_INTERVAL_SECS: u64 = 15;
const PRESENCE_WINDOW_MS: i64 = 60_000;
const WRAP_CUTOFF_MS: u32 = 49 * 86_400_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputSample {
    pub now_utc_ms: i64,
    pub now_tick_ms: u32,
    pub last_input_tick_ms: u32,
}

/// Elapsed idle ms from Windows 32-bit tick counters with rollover protection (`I13`).
/// Values looking "from the future" (> 49 days wrap difference) clamp cleanly to 0 ms.
pub fn elapsed_idle_ms(now_tick_ms: u32, last_input_tick_ms: u32) -> i64 {
    let diff = now_tick_ms.wrapping_sub(last_input_tick_ms);
    if diff > WRAP_CUTOFF_MS {
        0
    } else {
        i64::from(diff)
    }
}

#[cfg(windows)]
pub fn read_input_sample() -> Result<InputSample, &'static str> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    let ok = unsafe { GetLastInputInfo(&mut info) };
    if ok == 0 {
        return Err("Nie można odczytać czasu ostatniej aktywności.");
    }
    let tick = unsafe { GetTickCount() };
    Ok(InputSample {
        now_utc_ms: Utc::now().timestamp_millis(),
        now_tick_ms: tick,
        last_input_tick_ms: info.dwTime,
    })
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenIdleState {
    pub period_id: i64,
    pub entry_id: i64,
    pub started_ms: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompletedIdlePrompt {
    pub period_id: i64,
    pub entry_id: i64,
    pub started_ms: i64,
    pub ended_ms: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoTimerReminder {
    pub reminded_at_ms: i64,
    pub local_date: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LongTimerReminder {
    pub entry_id: i64,
    pub started_ms: i64,
    pub level: u8,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkWindowOverride {
    pub time_zone: String,
    pub local_date: String,
    pub in_work_hours: bool,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSnapshot {
    pub open_idle: Option<OpenIdleState>,
    pub completed_idle: Option<CompletedIdlePrompt>,
    pub no_timer_reminder: Option<NoTimerReminder>,
    pub long_timer_reminder: Option<LongTimerReminder>,
    pub muted_today: Option<String>,
    pub settings_warning: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutgoingNotification {
    ReturnedFromIdle,
    NoTimerWorking,
    TimerRunningLong,
}

impl OutgoingNotification {
    pub fn title(self) -> &'static str {
        match self {
            Self::ReturnedFromIdle => "Wykryto przerwę w pracy",
            Self::NoTimerWorking => "Nic nie mierzysz",
            Self::TimerRunningLong => "Timer działa długo",
        }
    }

    /// Strict O9 rule: never reveal client, project, task or description in system notifications.
    pub fn body(self) -> &'static str {
        match self {
            Self::ReturnedFromIdle => "Otwórz TrackerMaster, aby zdecydować, jak rozliczyć przerwę.",
            Self::NoTimerWorking => "Nic nie mierzysz. Uruchom timer w TrackerMaster, jeśli pracujesz.",
            Self::TimerRunningLong => "Aktywny pomiar trwa już długo. Sprawdź go w TrackerMaster.",
        }
    }
}

pub struct AttentionRuntime {
    pub dir: PathBuf,
    pub settings: AttentionSettings,
    pub settings_warning: Option<String>,
    pub last_poll_utc_ms: Option<i64>,
    pub open_idle: Option<(i64, i64, i64, u32)>, // (period_id, entry_id, started_ms, dw_time_at_open)
    pub completed_idle: Option<CompletedIdlePrompt>,
    pub suspended_dw_time: Option<u32>,
    pub pre_suspend_input_utc_ms: Option<i64>,
    pub min_idle_start_after_resume_ms: Option<i64>,
    pub present_without_timer_since_ms: Option<i64>,
    pub last_no_timer_reminded_ms: Option<i64>,
    pub no_timer_reminder: Option<NoTimerReminder>,
    pub muted_today: Option<String>,
    pub long_timer_sent_level: Option<(i64, u8)>, // (entry_id, 1 | 2)
    pub long_timer_muted_entry_id: Option<i64>,
    pub long_timer_reminder: Option<LongTimerReminder>,
    pub work_override: Option<WorkWindowOverride>,
}

impl AttentionRuntime {
    pub fn new(dir: PathBuf) -> Self {
        let loaded = read_settings(&dir);
        Self {
            dir,
            settings: loaded.settings,
            settings_warning: loaded.warning,
            last_poll_utc_ms: None,
            open_idle: None,
            completed_idle: None,
            suspended_dw_time: None,
            pre_suspend_input_utc_ms: None,
            min_idle_start_after_resume_ms: None,
            present_without_timer_since_ms: None,
            last_no_timer_reminded_ms: None,
            no_timer_reminder: None,
            muted_today: None,
            long_timer_sent_level: None,
            long_timer_muted_entry_id: None,
            long_timer_reminder: None,
            work_override: None,
        }
    }

    pub fn reload_settings(&mut self) {
        let loaded = read_settings(&self.dir);
        self.settings = loaded.settings;
        self.settings_warning = loaded.warning;
    }

    pub fn snapshot(&self) -> AttentionSnapshot {
        AttentionSnapshot {
            open_idle: self.open_idle.map(|(period_id, entry_id, started_ms, _)| OpenIdleState {
                period_id,
                entry_id,
                started_ms,
            }),
            completed_idle: self.completed_idle.clone(),
            no_timer_reminder: self.no_timer_reminder.clone(),
            long_timer_reminder: self.long_timer_reminder.clone(),
            muted_today: self.muted_today.clone(),
            settings_warning: self.settings_warning.clone(),
        }
    }

    pub fn on_suspend(&mut self, suspend_utc_ms: i64, sample: Option<InputSample>) {
        if let Some(sample) = sample {
            let idle_ms = elapsed_idle_ms(sample.now_tick_ms, sample.last_input_tick_ms);
            self.suspended_dw_time = Some(sample.last_input_tick_ms);
            self.pre_suspend_input_utc_ms = Some(suspend_utc_ms.saturating_sub(idle_ms));
        }
        self.min_idle_start_after_resume_ms = None;
        // Close in-memory open_idle ref because record_suspend closes it in SQLite (`close_open_idle`).
        self.open_idle = None;
    }

    pub fn on_resume(&mut self, resume_utc_ms: i64) {
        self.min_idle_start_after_resume_ms = Some(resume_utc_ms);
    }
}

pub fn register_global(shared: Arc<Mutex<AttentionRuntime>>) {
    let _ = GLOBAL_ATTENTION.set(shared);
}

pub fn notify_suspend(suspend_utc_ms: i64) {
    if let Some(lock) = GLOBAL_ATTENTION.get() {
        #[cfg(windows)]
        let sample = read_input_sample().ok();
        #[cfg(not(windows))]
        let sample: Option<InputSample> = None;
        if let Ok(mut rt) = lock.lock() {
            rt.on_suspend(suspend_utc_ms, sample);
        }
    }
}

pub fn notify_resume(resume_utc_ms: i64) {
    if let Some(lock) = GLOBAL_ATTENTION.get() {
        if let Ok(mut rt) = lock.lock() {
            rt.on_resume(resume_utc_ms);
        }
    }
}

fn last_sunday_of_month(year: i32, month: u32) -> NaiveDate {
    let last_day = if month == 12 {
        NaiveDate::from_ymd_opt(year, 12, 31).unwrap()
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1).unwrap().pred_opt().unwrap()
    };
    let offset = last_day.weekday().num_days_from_sunday() as i64;
    last_day - chrono::Duration::days(offset)
}

fn warsaw_offset_seconds(utc_ms: i64) -> i64 {
    let dt = DateTime::from_timestamp_millis(utc_ms).unwrap_or_else(Utc::now);
    let year = dt.year();
    let march_sunday = last_sunday_of_month(year, 3);
    let oct_sunday = last_sunday_of_month(year, 10);
    let dst_start = Utc
        .from_utc_datetime(&NaiveDateTime::new(march_sunday, NaiveTime::from_hms_opt(1, 0, 0).unwrap()))
        .timestamp_millis();
    let dst_end = Utc
        .from_utc_datetime(&NaiveDateTime::new(oct_sunday, NaiveTime::from_hms_opt(1, 0, 0).unwrap()))
        .timestamp_millis();
    if utc_ms >= dst_start && utc_ms < dst_end {
        7200
    } else {
        3600
    }
}

/// Evaluate local date & whether `utc_ms` is inside `[work_start, work_end)` on an enabled
/// workday, handling `Europe/Warsaw` 23h/25h DST transitions (`I20`) or using synced Temporal override.
pub fn work_window_at(
    settings: &AttentionSettings,
    zone: &str,
    utc_ms: i64,
    work_override: Option<&WorkWindowOverride>,
) -> (String, bool) {
    if let Some(ov) = work_override {
        if ov.time_zone == zone {
            return (ov.local_date.clone(), ov.in_work_hours);
        }
    }
    let offset_sec = if zone == "UTC" || zone == "Etc/UTC" {
        0
    } else {
        // Default / Europe/Warsaw CET+CEST DST fallback.
        warsaw_offset_seconds(utc_ms)
    };
    let local_dt = DateTime::from_timestamp_millis(utc_ms + offset_sec * 1000).unwrap_or_else(Utc::now);
    let local_date = local_dt.date_naive().format("%Y-%m-%d").to_string();
    let iso_day = local_dt.weekday().number_from_monday() as u8;
    if !settings.workdays.contains(&iso_day) {
        return (local_date, false);
    }
    let Some(start_min) = parse_hhmm_minutes(&settings.work_start) else {
        return (local_date, false);
    };
    let Some(end_min) = parse_hhmm_minutes(&settings.work_end) else {
        return (local_date, false);
    };
    // Map local wall start/end carefully across 23h DST gap (advance skipped HH:MM to 03:00 CEST).
    let local_min = (local_dt.hour() * 60 + local_dt.minute()) as i64;
    let in_hours = if zone != "UTC" && zone != "Etc/UTC" {
        let d = local_dt.date_naive();
        if d == last_sunday_of_month(d.year(), 3) && (120..180).contains(&start_min) {
            local_min >= 180 && local_min < i64::from(end_min)
        } else {
            local_min >= i64::from(start_min) && local_min < i64::from(end_min)
        }
    } else {
        local_min >= i64::from(start_min) && local_min < i64::from(end_min)
    };
    (local_date, in_hours)
}

/// Core state transition driven by deterministic `InputSample`. Holds `Tracker` then `AttentionRuntime`.
pub fn step_with_sample(
    tracker: &mut Tracker,
    rt: &mut AttentionRuntime,
    sample: InputSample,
) -> Cmd<Vec<OutgoingNotification>> {
    let mut events = Vec::new();
    let now_ms = sample.now_utc_ms;

    // Wall-clock backwards jump protection (I14): reset transient counters safely, never emit bad bounds.
    if let Some(prev) = rt.last_poll_utc_ms {
        if now_ms < prev {
            rt.last_poll_utc_ms = Some(now_ms);
            rt.open_idle = None;
            rt.suspended_dw_time = None;
            rt.pre_suspend_input_utc_ms = None;
            rt.present_without_timer_since_ms = None;
            return Ok(events);
        }
    }
    rt.last_poll_utc_ms = Some(now_ms);

    let report_zone: String = tracker
        .db
        .query_row("SELECT report_timezone FROM app_settings WHERE id=1", [], |r| r.get(0))
        .unwrap_or_else(|_| "Europe/Warsaw".into());

    // Read active timer (if any).
    let active_row: Option<(i64, String)> = tracker
        .db
        .query_row("SELECT id, started_at FROM time_entries WHERE ended_at IS NULL", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(db_err)?;

    let active_info = match active_row {
        Some((id, started_at)) => {
            let start_ms = DateTime::parse_from_rfc3339(&started_at)
                .map_err(|_| "Niepoprawny czas wpisu.".to_string())?
                .timestamp_millis();
            Some((id, start_ms))
        }
        None => None,
    };

    // Reconcile any stale open_idle reference against DB (e.g., if closed on stop/suspend/switch).
    if let Some((period_id, entry_id, _, _)) = rt.open_idle {
        let still_open: Option<i64> = tracker
            .db
            .query_row(
                "SELECT id FROM sleep_periods WHERE id=?1 AND entry_id=?2 AND source='idle' AND ended_ms IS NULL AND decision='pending'",
                params![period_id, entry_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if still_open.is_none() || active_info.map(|a| a.0) != Some(entry_id) {
            rt.open_idle = None;
        }
    }

    // Reconcile completed_idle prompt if period was already decided or its entry ended at/before started_ms.
    if let Some(prompt) = rt.completed_idle.clone() {
        let entry_end: Option<(String, Option<String>)> = tracker
            .db
            .query_row(
                "SELECT s.decision, e.ended_at FROM sleep_periods s JOIN time_entries e ON e.id=s.entry_id \
                 WHERE s.id=?1 AND s.entry_id=?2 AND s.decision='pending' AND s.ended_ms IS NOT NULL",
                params![prompt.period_id, prompt.entry_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .unwrap_or(None);
        let keep = match entry_end {
            Some((_, None)) => true,
            Some((_, Some(ended_at))) => DateTime::parse_from_rfc3339(&ended_at)
                .map(|dt| dt.timestamp_millis() > prompt.started_ms)
                .unwrap_or(false),
            None => false,
        };
        if !keep {
            rt.completed_idle = None;
        }
    }

    // Determine effective idle duration (taking post-suspend `dw_time` unchanged check `I10` into account).
    let raw_tick_idle_ms = elapsed_idle_ms(sample.now_tick_ms, sample.last_input_tick_ms);
    let effective_absence_start_ms = match (rt.suspended_dw_time, rt.pre_suspend_input_utc_ms) {
        (Some(prev_dw), Some(pre_input_ms)) if prev_dw == sample.last_input_tick_ms => {
            // Still no input since before suspend (I10).
            pre_input_ms
        }
        _ => {
            if rt.suspended_dw_time.is_some() {
                // Input happened after suspend!
                rt.suspended_dw_time = None;
                rt.pre_suspend_input_utc_ms = None;
            }
            now_ms - raw_tick_idle_ms
        }
    };

    // Clear after-resume floor once real new user input moves `dw_time`.
    let has_new_input_since = |dw: u32| sample.last_input_tick_ms != dw;

    // 1. If open idle period exists, check if user returned (new dwTime).
    if let Some((period_id, entry_id, started_ms, open_dw)) = rt.open_idle {
        if has_new_input_since(open_dw) {
            let input_at = (now_ms - raw_tick_idle_ms)
                .max(started_ms + 1)
                .min(now_ms);
            sleep_periods::complete_idle(&mut tracker.db, entry_id, period_id, input_at)
                .map_err(db_err)?;
            rt.open_idle = None;
            rt.min_idle_start_after_resume_ms = None;
            rt.completed_idle = Some(CompletedIdlePrompt {
                period_id,
                entry_id,
                started_ms,
                ended_ms: input_at,
            });
            events.push(OutgoingNotification::ReturnedFromIdle);
        }
    } else if rt.settings.idle_enabled {
        // 2. Otherwise check if running non-recovered entry crossed idle threshold.
        if let Some((entry_id, entry_start_ms)) = active_info {
            let is_running = tracker.running_since.is_some();
            if is_running {
                let periods = sleep_periods::list_for_entry(&tracker.db, entry_id).map_err(db_err)?;
                let has_open_sleep = periods.iter().any(|p| p.ended_ms.is_none());
                if !has_open_sleep {
                    let latest_end_ms = periods
                        .iter()
                        .filter_map(|p| p.ended_ms)
                        .max()
                        .unwrap_or(entry_start_ms);
                    let resume_floor = rt.min_idle_start_after_resume_ms.unwrap_or(entry_start_ms);
                    // Clamp start per I12b: never before entry start, previous period, or resume.
                    let clamped_start = effective_absence_start_ms
                        .max(entry_start_ms)
                        .max(latest_end_ms)
                        .max(resume_floor);
                    let threshold_ms = i64::from(rt.settings.idle_threshold_minutes) * 60_000;
                    // Also verify remaining awake time since clamped_start is >= threshold (I12b & §1.3)
                    // UNLESS pre-suspend absence already accumulated across a short sleep? Wait: TECH-12 §1.5 row 3:
                    // "Próg porównujemy z nieobecnością liczoną od ostatniego wejścia (łącznie ze snem),
                    // ale okresy bezczynności zapisujemy tylko dla części obudzonych (start >= t_resume)."
                    let threshold_anchor = if rt.min_idle_start_after_resume_ms.is_some()
                        && rt.suspended_dw_time.is_some()
                    {
                        effective_absence_start_ms.max(entry_start_ms)
                    } else {
                        clamped_start
                    };
                    if clamped_start < now_ms
                        && now_ms.saturating_sub(threshold_anchor) >= threshold_ms
                        && (clamped_start == effective_absence_start_ms
                            || now_ms.saturating_sub(clamped_start) >= threshold_ms
                            || (rt.min_idle_start_after_resume_ms.is_some() && rt.suspended_dw_time.is_some()))
                    {
                        let period_id = sleep_periods::record_idle(&mut tracker.db, entry_id, clamped_start)
                            .map_err(db_err)?;
                        rt.open_idle = Some((period_id, entry_id, clamped_start, sample.last_input_tick_ms));
                    }
                }
            }
        }
    }

    // 3. Long timer reminder (`I21`, hidden while idle is open per TECH-12 §2.2).
    if let Some((entry_id, entry_start_ms)) = active_info {
        rt.present_without_timer_since_ms = None;
        rt.no_timer_reminder = None;
        if rt.settings.long_timer_enabled
            && rt.open_idle.is_none()
            && rt.long_timer_muted_entry_id != Some(entry_id)
        {
            let elapsed_ms = now_ms.saturating_sub(entry_start_ms);
            let limit_ms = i64::from(rt.settings.long_timer_hours) * 3_600_000;
            let sent = rt
                .long_timer_sent_level
                .and_then(|(id, lvl)| if id == entry_id { Some(lvl) } else { None })
                .unwrap_or(0);
            let next_level = if sent == 0 && elapsed_ms >= limit_ms {
                Some(1u8)
            } else if sent == 1 && elapsed_ms >= limit_ms.saturating_mul(2) {
                Some(2u8)
            } else {
                None
            };
            if let Some(level) = next_level {
                rt.long_timer_sent_level = Some((entry_id, level));
                rt.long_timer_reminder = Some(LongTimerReminder {
                    entry_id,
                    started_ms: entry_start_ms,
                    level,
                });
                events.push(OutgoingNotification::TimerRunningLong);
            }
        } else if rt.open_idle.is_some() {
            rt.long_timer_reminder = None;
        }
    } else {
        // Timer stopped: reset long-timer reminder state.
        rt.long_timer_sent_level = None;
        rt.long_timer_muted_entry_id = None;
        rt.long_timer_reminder = None;

        // 4. "Nic nie mierzysz" reminder (`I18`, `I19`, `I20`, AC3).
        let (local_date, in_hours) = work_window_at(
            &rt.settings,
            &report_zone,
            now_ms,
            rt.work_override.as_ref(),
        );
        if rt.muted_today.as_deref() != Some(local_date.as_str()) {
            // Drop expired yesterday's mute cleanly when day rolls over.
            if rt.muted_today.is_some() {
                rt.muted_today = None;
            }
        }
        let user_present = raw_tick_idle_ms < PRESENCE_WINDOW_MS;
        let eligible = rt.settings.start_reminder_enabled
            && in_hours
            && user_present
            && rt.muted_today.as_deref() != Some(local_date.as_str());
        if eligible {
            let since = *rt.present_without_timer_since_ms.get_or_insert(now_ms);
            let first_ms = i64::from(rt.settings.first_reminder_minutes) * 60_000;
            let repeat_ms = i64::from(rt.settings.repeat_reminder_minutes) * 60_000;
            let due = match rt.last_no_timer_reminded_ms {
                None => now_ms.saturating_sub(since) >= first_ms,
                Some(last) => now_ms.saturating_sub(last) >= repeat_ms,
            };
            if due {
                rt.last_no_timer_reminded_ms = Some(now_ms);
                rt.no_timer_reminder = Some(NoTimerReminder {
                    reminded_at_ms: now_ms,
                    local_date,
                });
                events.push(OutgoingNotification::NoTimerWorking);
            }
        } else {
            rt.present_without_timer_since_ms = None;
            if !in_hours || !rt.settings.start_reminder_enabled {
                rt.no_timer_reminder = None;
            }
        }
    }

    Ok(events)
}

/// Core transactional logic for "Zatrzymaj o HH:MM" (`O6` / `I15c`).
pub fn stop_entry_at_idle_start(
    tracker: &mut Tracker,
    expected_active_id: i64,
    period_id: i64,
    current_utc: DateTime<Utc>,
) -> Cmd<i64> {
    ensure_available(tracker)?;
    let tx = tracker
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let active: Option<(i64, String)> = tx
        .query_row("SELECT id, started_at FROM time_entries WHERE ended_at IS NULL", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(db_err)?;
    let (id, start_text) = active.ok_or("Nie ma aktywnego pomiaru.")?;
    if id != expected_active_id {
        return Err("Pomiar zmienił się w innym oknie. Odśwież dane i spróbuj ponownie.".into());
    }
    let period_started_ms: Option<i64> = tx
        .query_row(
            "SELECT started_ms FROM sleep_periods WHERE id=?1 AND entry_id=?2 AND source='idle' AND decision='pending'",
            params![period_id, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?;
    let end_ms = period_started_ms.ok_or("Nie znaleziono otwartego ani oczekującego okresu bezczynności.")?;
    let start = DateTime::parse_from_rfc3339(&start_text)
        .map_err(|_| "Niepoprawny zapis czasu w bazie.".to_string())?
        .with_timezone(&Utc);
    let end = DateTime::from_timestamp_millis(end_ms).ok_or("Niepoprawny czas końca bezczynności.")?;
    if end < start || end > current_utc {
        return Err("Czas zakończenia na początku bezczynności jest poza zakresem wpisu.".into());
    }
    if end > start {
        crate::ensure_no_overlap(&tx, start, end, Some(id))?;
    }
    let end_text = end.to_rfc3339_opts(SecondsFormat::Millis, true);
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(db_err)?;
    let seconds = if version >= 12 {
        sleep_periods::close_open_at_entry_end(&tx, id, end_ms).map_err(db_err)?;
        match sleep_periods::periods_within_entry(&tx, id, &start_text, &end_text).map_err(db_err)? {
            Some((work, _)) => work,
            None => (end - start).num_seconds(),
        }
    } else {
        (end - start).num_seconds()
    };
    let changed = tx
        .execute(
            "UPDATE time_entries SET ended_at=?1, duration_seconds=?2 WHERE id=?3 AND ended_at IS NULL",
            params![end_text, seconds, id],
        )
        .map_err(db_err)?;
    if changed != 1 {
        return Err("Nie udało się zatrzymać pomiaru.".into());
    }
    tx.commit().map_err(db_err)?;
    tracker.running_since = None;
    Ok(id)
}

fn send_notifications(app: &AppHandle, enabled: bool, notifications: &[OutgoingNotification]) {
    if !enabled || notifications.is_empty() {
        return;
    }
    for note in notifications {
        // I24: failure to send a Windows toast never blocks the in-app banner or mutates state.
        let _ = app.notification().builder().title(note.title()).body(note.body()).show();
    }
}

pub fn emit_state(app: &AppHandle, snapshot: &AttentionSnapshot) {
    let _ = app.emit("attention-updated", snapshot);
}

pub fn start_polling(app: AppHandle) {
    std::thread::Builder::new()
        .name("tm-attention".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS));
            #[cfg(windows)]
            let sample = match read_input_sample() {
                Ok(sample) => sample,
                Err(_) => continue,
            };
            #[cfg(not(windows))]
            let sample = InputSample {
                now_utc_ms: Utc::now().timestamp_millis(),
                now_tick_ms: 0,
                last_input_tick_ms: 0,
            };
            let shared = app.state::<Shared>();
            let attention = app.state::<SharedAttention>();
            let Ok(mut tracker) = shared.lock() else { continue };
            let Ok(mut rt) = attention.lock() else { continue };
            let prev = rt.snapshot();
            let result = step_with_sample(&mut tracker, &mut rt, sample);
            let next = rt.snapshot();
            let notify_enabled = rt.settings.notifications_enabled;
            drop(rt);
            drop(tracker);
            if let Ok(events) = result {
                send_notifications(&app, notify_enabled, &events);
                if next != prev || !events.is_empty() {
                    emit_state(&app, &next);
                }
            }
        })
        .expect("tm-attention thread");
}

#[tauri::command]
pub fn get_attention_settings(state: State<'_, SharedAttention>) -> Cmd<AttentionSettingsRead> {
    let mut rt = state.lock().map_err(|_| "Nie można odczytać ustawień.")?;
    rt.reload_settings();
    Ok(AttentionSettingsRead {
        settings: rt.settings.clone(),
        warning: rt.settings_warning.clone(),
    })
}

#[tauri::command]
pub fn save_attention_settings(
    app: AppHandle,
    state: State<'_, SharedAttention>,
    settings: AttentionSettings,
) -> Cmd<AttentionSettingsRead> {
    let snapshot;
    let read;
    {
        let mut rt = state.lock().map_err(|_| "Nie można zapisać ustawień.")?;
        write_settings(&rt.dir, &settings)?;
        rt.settings = settings;
        rt.settings_warning = None;
        rt.present_without_timer_since_ms = None;
        rt.last_no_timer_reminded_ms = None;
        snapshot = rt.snapshot();
        read = AttentionSettingsRead {
            settings: rt.settings.clone(),
            warning: None,
        };
    }
    emit_state(&app, &snapshot);
    Ok(read)
}

#[tauri::command]
pub fn get_attention_state(
    shared: State<'_, Shared>,
    state: State<'_, SharedAttention>,
) -> Cmd<AttentionSnapshot> {
    let mut tracker = locked(&shared)?;
    let mut rt = state.lock().map_err(|_| "Nie można odczytać stanu przypomnień.")?;
    #[cfg(windows)]
    if let Ok(sample) = read_input_sample() {
        let _ = step_with_sample(&mut tracker, &mut rt, sample);
    }
    #[cfg(not(windows))]
    let _ = &mut tracker;
    Ok(rt.snapshot())
}

#[tauri::command]
pub fn dismiss_idle_prompt(app: AppHandle, state: State<'_, SharedAttention>, period_id: i64) -> Cmd<()> {
    let snapshot;
    {
        let mut rt = state.lock().map_err(|_| "Nie można zamknąć komunikatu.")?;
        if rt.completed_idle.as_ref().is_some_and(|p| p.period_id == period_id) {
            rt.completed_idle = None;
        }
        snapshot = rt.snapshot();
    }
    emit_state(&app, &snapshot);
    Ok(())
}

#[tauri::command]
pub fn mute_start_reminder_today(
    app: AppHandle,
    shared: State<'_, Shared>,
    state: State<'_, SharedAttention>,
    local_date: Option<String>,
) -> Cmd<AttentionSnapshot> {
    let tracker = locked(&shared)?;
    let zone: String = tracker
        .db
        .query_row("SELECT report_timezone FROM app_settings WHERE id=1", [], |r| r.get(0))
        .unwrap_or_else(|_| "Europe/Warsaw".into());
    drop(tracker);
    let snapshot;
    {
        let mut rt = state.lock().map_err(|_| "Nie można wyciszyć przypomnienia.")?;
        let today = local_date
            .filter(|d| d.len() == 10)
            .unwrap_or_else(|| work_window_at(&rt.settings, &zone, Utc::now().timestamp_millis(), rt.work_override.as_ref()).0);
        rt.muted_today = Some(today);
        rt.no_timer_reminder = None;
        rt.present_without_timer_since_ms = None;
        snapshot = rt.snapshot();
    }
    emit_state(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn mute_long_timer(
    app: AppHandle,
    state: State<'_, SharedAttention>,
    entry_id: i64,
) -> Cmd<AttentionSnapshot> {
    let snapshot;
    {
        let mut rt = state.lock().map_err(|_| "Nie można wyciszyć przypomnienia.")?;
        rt.long_timer_muted_entry_id = Some(entry_id);
        rt.long_timer_reminder = None;
        snapshot = rt.snapshot();
    }
    emit_state(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn sync_attention_work_window(
    state: State<'_, SharedAttention>,
    window: WorkWindowOverride,
) -> Cmd<()> {
    let mut rt = state.lock().map_err(|_| "Nie można zaktualizować harmonogramu.")?;
    rt.work_override = Some(window);
    Ok(())
}

#[tauri::command]
pub fn stop_timer_at_idle_start(
    app: AppHandle,
    shared: State<'_, Shared>,
    state: State<'_, SharedAttention>,
    expected_active_id: i64,
    period_id: i64,
) -> Cmd<AttentionSnapshot> {
    let mut tracker = locked(&shared)?;
    stop_entry_at_idle_start(&mut tracker, expected_active_id, period_id, Utc::now())?;
    drop(tracker);
    let snapshot;
    {
        let mut rt = state.lock().map_err(|_| "Nie można odświeżyć stanu.")?;
        if rt.open_idle.is_some_and(|(_, e, _, _)| e == expected_active_id) {
            rt.open_idle = None;
        }
        if rt.completed_idle.as_ref().is_some_and(|p| p.entry_id == expected_active_id) {
            rt.completed_idle = None;
        }
        rt.long_timer_sent_level = None;
        rt.long_timer_reminder = None;
        snapshot = rt.snapshot();
    }
    emit_state(&app, &snapshot);
    Ok(snapshot)
}

/// Exported for UI/tests when resolve/sleep decides a period.
pub fn clear_prompt_for_period(state: &SharedAttention, period_id: i64) -> Option<AttentionSnapshot> {
    let Ok(mut rt) = state.lock() else { return None };
    if rt.completed_idle.as_ref().is_some_and(|p| p.period_id == period_id) {
        rt.completed_idle = None;
        Some(rt.snapshot())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{initialise, optional_task_migration, RunningClock};
    use rusqlite::Connection;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tm-attention-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn setup_tracker(start_iso: &str, with_running: bool) -> (Tracker, i64, PathBuf) {
        let mut db = Connection::open_in_memory().unwrap();
        initialise(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt');").unwrap();
        let start_ms = DateTime::parse_from_rfc3339(start_iso).unwrap().timestamp_millis();
        if with_running {
            db.execute("INSERT INTO time_entries(id,project_id,started_at) VALUES(1,1,?1)", [start_iso]).unwrap();
        }
        let clock = if with_running {
            Some(RunningClock { since: Instant::now(), power: crate::PowerSample { total_ms: 1_000_000, awake_ms: 1_000_000 } })
        } else {
            None
        };
        (Tracker { db, running_since: clock, restored: false }, start_ms, temp_dir(if with_running { "run" } else { "idle" }))
    }

    // I01 & I02: threshold - 1 ms writes nothing; exact threshold (inclusive) opens pending idle row.
    #[test]
    fn i01_and_i02_threshold_boundary() {
        let (mut tracker, start, dir) = setup_tracker("2026-11-25T09:00:00Z", true);
        let mut rt = AttentionRuntime::new(dir.clone());
        let thr = 10 * 60_000;
        let t1 = start + thr - 1;
        step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: t1, now_tick_ms: 1_000_000 + (thr - 1) as u32, last_input_tick_ms: 1_000_000 }).unwrap();
        assert!(sleep_periods::list_for_entry(&tracker.db, 1).unwrap().is_empty());
        assert!(rt.open_idle.is_none());

        let t2 = start + thr;
        step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: t2, now_tick_ms: 1_000_000 + thr as u32, last_input_tick_ms: 1_000_000 }).unwrap();
        let periods = sleep_periods::list_for_entry(&tracker.db, 1).unwrap();
        assert_eq!(periods.len(), 1);
        assert_eq!((periods[0].source.as_str(), periods[0].started_ms, periods[0].ended_ms, periods[0].decision.as_str()), ("idle", start, None, "pending"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // I03, I04, I15c: 15 min idle after 30 min work -> closes on return, prompt opens, stop_at_idle_start cuts entry cleanly.
    #[test]
    fn i03_i04_and_i15c_return_prompt_and_stop_at_idle_start() {
        let (mut tracker, start, dir) = setup_tracker("2026-11-25T09:00:00Z", true);
        let mut rt = AttentionRuntime::new(dir.clone());
        let idle_begin = start + 30 * 60_000;
        let sample_over = idle_begin + 15 * 60_000;
        let dw_before = 5_000_000u32;
        step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: sample_over, now_tick_ms: dw_before + (15 * 60_000) as u32, last_input_tick_ms: dw_before }).unwrap();
        let open = rt.open_idle.expect("idle open");
        let events = step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: sample_over + 5_000, now_tick_ms: dw_before + (15 * 60_000 + 5_000) as u32, last_input_tick_ms: dw_before + (15 * 60_000 + 3_000) as u32 }).unwrap();
        assert_eq!(events, vec![OutgoingNotification::ReturnedFromIdle]);
        let prompt = rt.completed_idle.clone().expect("prompt ready");
        assert_eq!((prompt.started_ms, prompt.ended_ms), (idle_begin, sample_over + 3_000));

        // Stale active ID must refuse (I15c).
        assert!(stop_entry_at_idle_start(&mut tracker, 999, open.0, Utc::now()).is_err());
        stop_entry_at_idle_start(&mut tracker, 1, open.0, DateTime::from_timestamp_millis(sample_over + 10_000).unwrap()).unwrap();
        let dur: i64 = tracker.db.query_row("SELECT duration_seconds FROM time_entries WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(dur, 1_800, "entry cut cleanly to 30 min at idle start");
        assert!(crate::pending_sleep(&tracker.db).unwrap().is_empty(), "idle period after entry end hidden from pending list");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // I08, I09, I10: suspend interaction, O5a short sleep after open idle stays pending; dwTime unchanged across sleep.
    #[test]
    fn i08_i09_i10_suspend_and_short_sleep_o5a() {
        let (mut tracker, start, dir) = setup_tracker("2026-11-25T09:00:00Z", true);
        let mut rt = AttentionRuntime::new(dir.clone());
        let dw_before = 2_000_000u32;
        let idle_start = start + 10 * 60_000;
        let over_thr = idle_start + 10 * 60_000;
        step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: over_thr, now_tick_ms: dw_before + 600_000, last_input_tick_ms: dw_before }).unwrap();
        // Computer suspends at over_thr for 2 min (< 5 min short sleep threshold!).
        rt.on_suspend(over_thr, Some(InputSample { now_utc_ms: over_thr, now_tick_ms: dw_before + 600_000, last_input_tick_ms: dw_before }));
        let sleep_id = sleep_periods::record_suspend(&mut tracker.db, 1, over_thr).unwrap();
        let resume_ms = over_thr + 120_000;
        sleep_periods::record_resume(&mut tracker.db, 1, sleep_id, resume_ms).unwrap();
        rt.on_resume(resume_ms);
        let periods = sleep_periods::list_for_entry(&tracker.db, 1).unwrap();
        assert_eq!(periods.len(), 2);
        assert_eq!((periods[0].source.as_str(), periods[0].decision.as_str()), ("idle", "pending"));
        assert_eq!((periods[1].source.as_str(), periods[1].decision.as_str()), ("sleep", "pending"), "O5a must keep short sleep pending");

        // I10: wake without user input (dw_before unchanged): new idle period starts >= resume_ms, never inside sleep.
        step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: resume_ms + 30_000, now_tick_ms: dw_before + 630_000, last_input_tick_ms: dw_before }).unwrap();
        let periods_after = sleep_periods::list_for_entry(&tracker.db, 1).unwrap();
        assert_eq!(periods_after.len(), 3);
        assert!(periods_after[2].started_ms >= resume_ms);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // I12b, I13, I14: clamping start, u32 tick rollover, backward wall clock jump.
    #[test]
    fn i12b_i13_i14_clamp_wrap_and_clock_jump() {
        assert_eq!(elapsed_idle_ms(100, u32::MAX - 900), 1_001);
        assert_eq!(elapsed_idle_ms(1_000, 1_500), 0, "future dwTime gives 0 instead of 49-day wrap");

        let (mut tracker, start, dir) = setup_tracker("2026-11-25T09:00:00Z", true);
        let mut rt = AttentionRuntime::new(dir.clone());
        // I12b: dwTime predates entry start by 1 hour -> clamped to entry_start, remaining elapsed is 5 min < 10 min threshold -> no row.
        let five_min_in = start + 5 * 60_000;
        step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: five_min_in, now_tick_ms: 10_000_000, last_input_tick_ms: 10_000_000 - (65 * 60_000) }).unwrap();
        assert!(sleep_periods::list_for_entry(&tracker.db, 1).unwrap().is_empty());

        // I14: clock moves backward -> no idle period created on jump.
        step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: five_min_in - 60_000, now_tick_ms: 10_600_000, last_input_tick_ms: 9_000_000 }).unwrap();
        assert!(sleep_periods::list_for_entry(&tracker.db, 1).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // I15 & I15b: D3 Stop/Switch closes open idle period cleanly in one transaction.
    #[test]
    fn i15_and_i15b_switch_closes_open_idle_on_entry_a() {
        let (mut tracker, start, dir) = setup_tracker("2026-11-25T09:00:00Z", true);
        let mut rt = AttentionRuntime::new(dir.clone());
        let idle_at = start + 10 * 60_000;
        let stop_at = start + 25 * 60_000;
        step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: stop_at - 60_000, now_tick_ms: 2_000_000, last_input_tick_ms: 2_000_000 - (14 * 60_000) }).unwrap();
        assert!(rt.open_idle.is_some());
        let stop_iso = DateTime::from_timestamp_millis(stop_at).unwrap().to_rfc3339_opts(SecondsFormat::Millis, true);
        tracker.db.execute("INSERT INTO projects(id,client_id,name) VALUES(2,1,'Projekt B')", []).unwrap();
        optional_task_migration::transition(&mut tracker, Some(1), &stop_iso, optional_task_migration::TimerAction::Start { project_id: 2, task_id: None, description: "B" }).unwrap();
        let p_a = sleep_periods::list_for_entry(&tracker.db, 1).unwrap();
        let active_b: i64 = tracker.db.query_row("SELECT id FROM time_entries WHERE ended_at IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!((p_a.len(), p_a[0].ended_ms, p_a[0].decision.as_str()), (1, Some(stop_at), "pending"));
        assert!(sleep_periods::list_for_entry(&tracker.db, active_b).unwrap().is_empty());
        let _ = idle_at;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // I18, I19, I20, I21: reminders (present vs absent, work hours + Warsaw DST, long timer 1x and 2x).
    #[test]
    fn i18_to_i21_reminders_schedule_dst_and_long_timer() {
        let (mut tracker, _, dir) = setup_tracker("2026-11-25T09:00:00Z", false);
        let mut rt = AttentionRuntime::new(dir.clone());
        // Monday 2026-11-30 10:00 CET = 09:00Z
        let t0 = DateTime::parse_from_rfc3339("2026-11-30T09:00:00Z").unwrap().timestamp_millis();
        // Absent (idle 2 min >= 1 min) -> no reminder even after 20 min.
        for min in [0, 20] {
            let ev = step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: t0 + min * 60_000, now_tick_ms: 5_000_000 + (min * 60_000) as u32, last_input_tick_ms: 5_000_000 - 120_000 }).unwrap();
            assert!(ev.is_empty());
        }
        // Present for 15 min in work hours -> fires once, repeats after 30 min.
        let tick = 6_000_000u32;
        assert!(step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: t0, now_tick_ms: tick, last_input_tick_ms: tick - 5_000 }).unwrap().is_empty());
        let ev1 = step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: t0 + 15 * 60_000, now_tick_ms: tick + 900_000, last_input_tick_ms: tick + 890_000 }).unwrap();
        assert_eq!(ev1, vec![OutgoingNotification::NoTimerWorking]);
        // Repeat before 30 min -> silent.
        let ev_early = step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: t0 + 44 * 60_000, now_tick_ms: tick + 2_640_000, last_input_tick_ms: tick + 2_635_000 }).unwrap();
        assert!(ev_early.is_empty());
        // Repeat after 30 min -> fires again.
        let ev2 = step_with_sample(&mut tracker, &mut rt, InputSample { now_utc_ms: t0 + 45 * 60_000, now_tick_ms: tick + 2_700_000, last_input_tick_ms: tick + 2_695_000 }).unwrap();
        assert_eq!(ev2, vec![OutgoingNotification::NoTimerWorking]);

        // I20: Autumn DST Sunday 2026-10-25 (with Sunday allowed): 16:59 CET = 15:59Z (in hours), 17:00 CET = 16:00Z (out).
        let mut sun_settings = AttentionSettings::default();
        sun_settings.workdays = vec![7];
        assert_eq!(work_window_at(&sun_settings, "Europe/Warsaw", DateTime::parse_from_rfc3339("2026-10-25T15:59:00Z").unwrap().timestamp_millis(), None).1, true);
        assert_eq!(work_window_at(&sun_settings, "Europe/Warsaw", DateTime::parse_from_rfc3339("2026-10-25T16:00:00Z").unwrap().timestamp_millis(), None).1, false);

        // I21: long timer fires at 4h and 8h, silent at 12h.
        let run_start = t0;
        let run_iso = "2026-11-30T09:00:00Z";
        tracker.db.execute("INSERT INTO time_entries(id,project_id,started_at) VALUES(9,1,?1)", [run_iso]).unwrap();
        tracker.running_since = Some(RunningClock { since: Instant::now(), power: crate::PowerSample { total_ms: 1_000, awake_ms: 1_000 } });
        let mut rt2 = AttentionRuntime::new(dir.clone());
        let l1 = step_with_sample(&mut tracker, &mut rt2, InputSample { now_utc_ms: run_start + 4 * 3_600_000, now_tick_ms: 9_000_000, last_input_tick_ms: 9_000_000 }).unwrap();
        let l2 = step_with_sample(&mut tracker, &mut rt2, InputSample { now_utc_ms: run_start + 8 * 3_600_000, now_tick_ms: 9_000_000, last_input_tick_ms: 9_000_000 }).unwrap();
        let l3 = step_with_sample(&mut tracker, &mut rt2, InputSample { now_utc_ms: run_start + 12 * 3_600_000, now_tick_ms: 9_000_000, last_input_tick_ms: 9_000_000 }).unwrap();
        assert_eq!(l1, vec![OutgoingNotification::TimerRunningLong]);
        assert_eq!(l2, vec![OutgoingNotification::TimerRunningLong]);
        assert!(l3.is_empty());
        assert_eq!(rt2.long_timer_reminder.as_ref().map(|r| r.level), Some(2));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // I25: verify source files contain zero forbidden Win32 spy/hook APIs.
    #[test]
    fn i25_privacy_no_hooks_or_window_spying() {
        let src = include_str!("attention.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for banned in ["SetWindowsHookEx", "GetForegroundWindow", "GetWindowText", "RegisterRawInputDevices"] {
            assert!(!code.contains(banned), "forbidden Win32 import/reference: {banned}");
        }
    }
}
