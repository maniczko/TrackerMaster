//! Windows suspend/resume notifications. The registered context remains valid
//! for the lifetime of the process; Windows releases the handle on exit.
#[cfg(windows)]
use std::sync::{mpsc::{self, SyncSender}, OnceLock};
#[cfg(windows)]
use crate::{Shared, Tracker};

#[cfg(windows)]
type QueuedPowerEvent = (u32, i64, crate::PowerSample);

#[cfg(windows)]
static TRACKER: OnceLock<Shared> = OnceLock::new();
#[cfg(windows)]
static SENDER: OnceLock<SyncSender<QueuedPowerEvent>> = OnceLock::new();
#[cfg(windows)]
static REGISTRATION: OnceLock<usize> = OnceLock::new();

#[cfg(windows)]
#[repr(C)]
struct SubscribeParameters {
    callback: Option<unsafe extern "system" fn(*const std::ffi::c_void, u32, *const std::ffi::c_void) -> u32>,
    context: *const std::ffi::c_void,
}

#[cfg(windows)]
#[link(name = "PowrProf")]
extern "system" {
    fn PowerRegisterSuspendResumeNotification(flags: u32, recipient: *const SubscribeParameters, handle: *mut *mut std::ffi::c_void) -> u32;
}

#[cfg(windows)]
fn dispatch_event(tracker: &mut Tracker, event: u32, now_ms: i64, power: crate::PowerSample) {
    match event {
        4 => { let _ = handle_suspend(tracker, now_ms, power); }, // PBT_APMSUSPEND
        18 => { let _ = handle_resume(tracker, now_ms, power); }, // PBT_APMRESUMEAUTOMATIC
        _ => (),
    }
}

#[cfg(windows)]
unsafe extern "system" fn callback(_: *const std::ffi::c_void, event: u32, _: *const std::ffi::c_void) -> u32 {
    // Never unwind or block on Shared inside the OS callback: sample clocks immediately
    // and hand off SQLite work to the worker thread so brief reads/backups do not drop sleep events.
    let _ = std::panic::catch_unwind(|| {
        if !matches!(event, 4 | 18) { return; }
        let Some(sender) = SENDER.get() else { return; };
        let Ok(power) = crate::power_sample() else { return; };
        let now = chrono::Utc::now().timestamp_millis();
        let _ = sender.try_send((event, now, power));
    });
    0
}

#[cfg(windows)]
pub fn register(shared: Shared) -> Result<(), &'static str> {
    TRACKER.set(shared).map_err(|_| "Rejestracja monitora uśpienia już istnieje.")?;
    let (sender, receiver) = mpsc::sync_channel::<QueuedPowerEvent>(64);
    SENDER.set(sender).map_err(|_| "Rejestracja monitora uśpienia już istnieje.")?;
    let _ = std::thread::Builder::new()
        .name("tm-power-events".into())
        .spawn(move || {
            while let Ok((event, now, power)) = receiver.recv() {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let Some(shared) = TRACKER.get() else { return; };
                    let Ok(mut tracker) = shared.lock() else { return; };
                    dispatch_event(&mut tracker, event, now, power);
                }));
            }
        });
    let params = SubscribeParameters { callback: Some(callback), context: std::ptr::null() };
    let mut handle = std::ptr::null_mut();
    // DEVICE_NOTIFY_CALLBACK is 2. No caller-owned context is passed to Windows.
    let status = unsafe { PowerRegisterSuspendResumeNotification(2, &params, &mut handle) };
    if status != 0 || handle.is_null() { return Err("Nie można uruchomić monitorowania uśpienia."); }
    REGISTRATION.set(handle as usize).map_err(|_| "Rejestracja monitora uśpienia już istnieje.")?;
    Ok(())
}

#[cfg(windows)]
fn active(tracker: &Tracker, now_ms: i64, sample: crate::PowerSample) -> Result<Option<(i64, Vec<crate::sleep_periods::SleepPeriod>, u64)>, String> {
    use rusqlite::OptionalExtension;
    let Some(clock) = tracker.running_since.as_ref() else { return Ok(None); };
    let row: Option<(i64,String)> = tracker.db.query_row("SELECT id,started_at FROM time_entries WHERE ended_at IS NULL", [], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(crate::db_err)?;
    let Some((id,start)) = row else { return Ok(None); };
    let start = chrono::DateTime::parse_from_rfc3339(&start).map_err(|_| "Niepoprawny czas.")?.timestamp_millis();
    let wall = now_ms.checked_sub(start).and_then(|x| u64::try_from(x).ok()).ok_or("Niepoprawny czas.")?;
    let total = sample.total_ms.checked_sub(clock.power.total_ms).ok_or("Niepoprawny zegar.")?;
    let awake = sample.awake_ms.checked_sub(clock.power.awake_ms).ok_or("Niepoprawny zegar.")?;
    if wall.abs_diff(total) > 2_000 || awake > total.saturating_add(2_000) { return Err("Wykryto zmianę zegara.".into()); }
    let sleep_ms = total.saturating_sub(awake);
    let periods = crate::sleep_periods::list_for_entry(&tracker.db,id).map_err(crate::db_err)?;
    Ok(Some((id,periods,sleep_ms)))
}

// Only sleep periods are compared with the power counters; an idle period is time awake
// (TECH-12 §1.7, B1). An open sleep period means a missed resume and fails.
#[cfg(windows)]
fn known_sleep(periods: &[crate::sleep_periods::SleepPeriod]) -> Option<u64> {
    periods.iter().filter(|period| period.is_sleep()).try_fold(0u64, |sum, period| {
        let duration = u64::try_from(period.ended_ms?.checked_sub(period.started_ms)?).ok()?;
        sum.checked_add(duration)
    })
}

#[cfg(windows)]
fn handle_suspend(tracker: &mut Tracker, now_ms: i64, power: crate::PowerSample) -> Result<(), String> {
    let Some((id,periods,actual)) = active(tracker,now_ms,power)? else { return Ok(()); };
    let known = known_sleep(&periods).ok_or("Nierozstrzygnięty koniec uśpienia.")?;
    if known.abs_diff(actual) > 4_000 { return Err("Nie można ustalić czasu uśpienia.".into()); }
    // record_suspend first ends an open idle period at the suspend time, in the same transaction.
    crate::sleep_periods::record_suspend(&mut tracker.db,id,now_ms).map_err(crate::db_err)?;
    Ok(())
}

#[cfg(windows)]
fn handle_resume(tracker: &mut Tracker, now_ms: i64, power: crate::PowerSample) -> Result<(), String> {
    let Some((id,periods,actual)) = active(tracker,now_ms,power)? else { return Ok(()); };
    // The open sleep period, never an open idle period; earlier sleep only (TECH-12 §1.7, B1).
    let Some(open) = periods.iter().find(|p| p.ended_ms.is_none() && p.is_sleep()) else { return Ok(()); };
    let previous = periods.iter().filter(|p| p.id != open.id && p.is_sleep()).try_fold(0u64, |sum,p| {
        sum.checked_add(u64::try_from(p.ended_ms?.checked_sub(p.started_ms)?).ok()?)
    }).ok_or("Niepoprawne okresy uśpienia.")?;
    let current = u64::try_from(now_ms.checked_sub(open.started_ms).ok_or("Niepoprawny czas.")?).map_err(|_| "Niepoprawny czas.")?;
    let expected = previous.checked_add(current).ok_or("Niepoprawny czas.")?;
    if actual.abs_diff(expected) > 4_000 { return Err("Nie można ustalić czasu wybudzenia.".into()); }
    crate::sleep_periods::record_resume(&mut tracker.db,id,open.id,now_ms).map_err(crate::db_err)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::{PowerSample, RunningClock, Tracker};
    use chrono::DateTime;
    use rusqlite::Connection;
    use std::time::Instant;

    fn fixture() -> (Tracker,i64) {
        let mut db=Connection::open_in_memory().unwrap();
        crate::initialise(&mut db).unwrap();
        db.execute_batch("INSERT INTO clients(id,name) VALUES(1,'Klient'); INSERT INTO projects(id,client_id,name) VALUES(1,1,'Projekt'); INSERT INTO time_entries(id,project_id,started_at) VALUES(1,1,'2026-01-01T10:00:00Z');").unwrap();
        let start=DateTime::parse_from_rfc3339("2026-01-01T10:00:00Z").unwrap().timestamp_millis();
        let clock=RunningClock { since:Instant::now(), power:PowerSample { total_ms:1_000_000,awake_ms:1_000_000 } };
        (Tracker { db,running_since:Some(clock),restored:false },start)
    }
    #[test]
    fn notifications_record_suspend_and_resume_without_duplicate_periods() {
        let (mut tracker,start)=fixture();
        let before=PowerSample { total_ms:4_600_000,awake_ms:4_600_000 };
        handle_suspend(&mut tracker,start+3_600_000,before).unwrap();
        assert!(handle_suspend(&mut tracker,start+3_600_000,before).is_err());
        let after=PowerSample { total_ms:11_800_000,awake_ms:4_600_000 };
        handle_resume(&mut tracker,start+10_800_000,after).unwrap();
        handle_resume(&mut tracker,start+10_800_000,after).unwrap();
        let periods=crate::sleep_periods::list_for_entry(&tracker.db,1).unwrap();
        assert_eq!(periods.len(),1);
        assert_eq!((periods[0].started_ms,periods[0].ended_ms,periods[0].decision.as_str()),(start+3_600_000,Some(start+10_800_000),"pending"));
        let second_before=PowerSample { total_ms:12_400_000,awake_ms:5_200_000 };
        handle_suspend(&mut tracker,start+11_400_000,second_before).unwrap();
        let second_after=PowerSample { total_ms:13_600_000,awake_ms:5_200_000 };
        handle_resume(&mut tracker,start+12_600_000,second_after).unwrap();
        let periods=crate::sleep_periods::list_for_entry(&tracker.db,1).unwrap();
        assert_eq!(periods.len(),2);
        assert_eq!((periods[1].started_ms,periods[1].ended_ms),(start+11_400_000,Some(start+12_600_000)));
    }
    #[test]
    fn clock_change_does_not_invent_a_resume_time() {
        let (mut tracker,start)=fixture();
        handle_suspend(&mut tracker,start+3_600_000,PowerSample { total_ms:4_600_000,awake_ms:4_600_000 }).unwrap();
        assert!(handle_resume(&mut tracker,start+10_810_000,PowerSample { total_ms:11_800_000,awake_ms:4_600_000 }).is_err());
        let periods=crate::sleep_periods::list_for_entry(&tracker.db,1).unwrap();
        assert_eq!(periods[0].ended_ms,None);
    }

    #[test]
    fn short_observed_sleep_is_counted_without_a_question_and_five_minutes_asks() {
        let (mut tracker,start)=fixture();
        // 2 min sleep at 11:00 (power counters agree with the wall clock).
        handle_suspend(&mut tracker,start+3_600_000,PowerSample { total_ms:4_600_000,awake_ms:4_600_000 }).unwrap();
        handle_resume(&mut tracker,start+3_720_000,PowerSample { total_ms:4_720_000,awake_ms:4_600_000 }).unwrap();
        // Exactly 5 min at 11:06:40: the boundary asks.
        handle_suspend(&mut tracker,start+4_000_000,PowerSample { total_ms:5_000_000,awake_ms:4_880_000 }).unwrap();
        handle_resume(&mut tracker,start+4_300_000,PowerSample { total_ms:5_300_000,awake_ms:4_880_000 }).unwrap();
        let periods=crate::sleep_periods::list_for_entry(&tracker.db,1).unwrap();
        assert_eq!(periods.iter().map(|p| (p.ended_ms.unwrap()-p.started_ms,p.decision.as_str())).collect::<Vec<_>>(),
            [(120_000,"auto_included"),(crate::sleep_periods::SHORT_SLEEP_AUTO_INCLUDE_MS,"pending")]);
        // A repeated resume event changes nothing.
        handle_resume(&mut tracker,start+4_300_000,PowerSample { total_ms:5_300_000,awake_ms:4_880_000 }).unwrap();
        assert_eq!(crate::sleep_periods::list_for_entry(&tracker.db,1).unwrap(),periods);
    }

    // I07 (TECH-12 §1.5, §1.7 B1): away since 10:48 (an open idle period, written here directly;
    // the idle engine is DEV-39 PR 2), then the computer sleeps 11:00–12:00. With power counters
    // consistent with that hour the sleep is recorded and finished next to the idle period, the
    // two touch at the suspend time, and the projection is verified, not uncertain.
    #[test]
    fn sleep_after_idle_is_recorded_next_to_it_and_the_projection_stays_verified() {
        let (mut tracker,start)=fixture();
        tracker.db.execute("INSERT INTO sleep_periods(entry_id,source,started_ms) VALUES(1,'idle',?1)",[start+2_880_000]).unwrap();
        handle_suspend(&mut tracker,start+3_600_000,PowerSample { total_ms:4_600_000,awake_ms:4_600_000 }).unwrap();
        handle_resume(&mut tracker,start+7_200_000,PowerSample { total_ms:8_200_000,awake_ms:4_600_000 }).unwrap();
        let periods=crate::sleep_periods::list_for_entry(&tracker.db,1).unwrap();
        assert_eq!(periods.iter().map(|p| (p.source.as_str(),p.started_ms,p.ended_ms,p.decision.as_str())).collect::<Vec<_>>(),
            [("idle",start+2_880_000,Some(start+3_600_000),"pending"),("sleep",start+3_600_000,Some(start+7_200_000),"pending")]);
        // 12:10, awake since the resume: 2 h 10 min minus the pending 12 min away and 1 h of sleep.
        let current=DateTime::parse_from_rfc3339("2026-01-01T12:10:00Z").unwrap().with_timezone(&chrono::Utc);
        let projection=crate::active_projection(&tracker.db,tracker.running_since.as_ref(),1,"2026-01-01T10:00:00Z",current,&Ok(PowerSample { total_ms:8_800_000,awake_ms:5_200_000 })).expect("verified projection");
        assert_eq!((projection.seconds,projection.excluded_sleep_ms),(7_800-720-3_600,4_320_000));
        crate::sleep_periods::validate(&tracker.db).unwrap();
    }

    // I07b: a finished idle period before the first sleep and a second idle period after the wake.
    // handle_resume finds the open sleep, never the idle period, and earlier time counts sleep only.
    #[test]
    fn resume_finds_the_open_sleep_and_counts_only_earlier_sleep_next_to_idle_periods() {
        let (mut tracker,start)=fixture();
        // Away 10:30–10:45 (the user came back), then sleep 11:00–11:30.
        tracker.db.execute("INSERT INTO sleep_periods(entry_id,source,started_ms,ended_ms) VALUES(1,'idle',?1,?2)",[start+1_800_000,start+2_700_000]).unwrap();
        handle_suspend(&mut tracker,start+3_600_000,PowerSample { total_ms:4_600_000,awake_ms:4_600_000 }).unwrap();
        handle_resume(&mut tracker,start+5_400_000,PowerSample { total_ms:6_400_000,awake_ms:4_600_000 }).unwrap();
        // Away again from 11:40; a stray resume event while only idle is open changes nothing.
        tracker.db.execute("INSERT INTO sleep_periods(entry_id,source,started_ms) VALUES(1,'idle',?1)",[start+6_000_000]).unwrap();
        handle_resume(&mut tracker,start+6_600_000,PowerSample { total_ms:7_600_000,awake_ms:5_800_000 }).unwrap();
        assert_eq!(crate::sleep_periods::list_for_entry(&tracker.db,1).unwrap()[2].ended_ms,None);
        // Second sleep 12:00–12:20: suspend ends the idle period, resume counts the first sleep only.
        handle_suspend(&mut tracker,start+7_200_000,PowerSample { total_ms:8_200_000,awake_ms:6_400_000 }).unwrap();
        handle_resume(&mut tracker,start+8_400_000,PowerSample { total_ms:9_400_000,awake_ms:6_400_000 }).unwrap();
        let periods=crate::sleep_periods::list_for_entry(&tracker.db,1).unwrap();
        assert_eq!(periods.iter().map(|p| (p.source.as_str(),p.started_ms,p.ended_ms,p.decision.as_str())).collect::<Vec<_>>(), [
            ("idle",start+1_800_000,Some(start+2_700_000),"pending"),
            ("sleep",start+3_600_000,Some(start+5_400_000),"pending"),
            ("idle",start+6_000_000,Some(start+7_200_000),"pending"),
            ("sleep",start+7_200_000,Some(start+8_400_000),"pending")]);
        crate::sleep_periods::validate(&tracker.db).unwrap();
    }
}
