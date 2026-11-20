//! Single-flight guard for tray Quit handling. Keep it independent from SQLite
//! and the native message box so repeated clicks cannot start parallel dialogs.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Default)]
pub(super) struct QuitDialog {
    pending: Arc<AtomicBool>,
}

pub(super) struct QuitPermit(Arc<AtomicBool>);

impl QuitDialog {
    pub(super) fn try_begin(&self) -> Option<QuitPermit> {
        self.pending
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| QuitPermit(Arc::clone(&self.pending)))
    }
}

// The permit is owned by the dialog worker. It resets the gate on Cancel,
// errors, and early returns, and also if the worker unwinds.
impl Drop for QuitPermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn duplicate_requests_are_rejected_until_the_dialog_finishes() {
        let gate = Arc::new(QuitDialog::default());
        let open = gate.try_begin().expect("first Quit should open a dialog");
        assert!(gate.try_begin().is_none(), "second Quit must be ignored");

        let attempts: Vec<_> = (0..12)
            .map(|_| {
                let gate = Arc::clone(&gate);
                thread::spawn(move || gate.try_begin().is_none())
            })
            .collect();
        for attempt in attempts {
            assert!(attempt.join().expect("worker must finish"));
        }

        drop(open); // Cancel / failure releases the gate.
        assert!(gate.try_begin().is_some(), "Quit should work again after Cancel");
    }

    #[test]
    fn independent_guard_state_and_early_return_release() {
        fn cancel(gate: &QuitDialog) {
            let _permit = gate.try_begin().expect("dialog can be shown");
            // Simulate the dialog returning Cancel without stopping the timer.
        }

        let first = QuitDialog::default();
        let second = QuitDialog::default();
        let held = first.try_begin().unwrap();
        assert!(first.try_begin().is_none());
        assert!(second.try_begin().is_some(), "separate instances must not conflict");
        drop(held);
        cancel(&first);
        assert!(first.try_begin().is_some(), "a subsequent Quit is allowed");
    }
}
