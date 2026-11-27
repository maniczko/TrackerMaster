// Shared attention state (idle prompts + work reminders) for main window and widget (TECH-12 / DEV-39).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_ATTENTION_SETTINGS, workWindowStatus } from './attentionSchedule';
import type { AttentionSettings } from './attentionSchedule';

export type OpenIdleState = { periodId: number; entryId: number; startedMs: number };
export type CompletedIdlePrompt = { periodId: number; entryId: number; startedMs: number; endedMs: number };
export type NoTimerReminder = { remindedAtMs: number; localDate: string };
export type LongTimerReminder = { entryId: number; startedMs: number; level: number };

export type AttentionStateSnapshot = {
  openIdle: OpenIdleState | null;
  completedIdle: CompletedIdlePrompt | null;
  noTimerReminder: NoTimerReminder | null;
  longTimerReminder: LongTimerReminder | null;
  mutedToday: string | null;
  settingsWarning: string | null;
};

const EMPTY_ATTENTION: AttentionStateSnapshot = {
  openIdle: null,
  completedIdle: null,
  noTimerReminder: null,
  longTimerReminder: null,
  mutedToday: null,
  settingsWarning: null,
};

export function useAttention(
  loaded: boolean,
  reportZone: string,
  now: number,
  onMutated: () => Promise<void>,
) {
  const [state, setState] = useState<AttentionStateSnapshot>(EMPTY_ATTENTION);
  const [settings, setSettings] = useState<AttentionSettings>(DEFAULT_ATTENTION_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshState = useCallback(async () => {
    try {
      const next = await invoke<AttentionStateSnapshot>('get_attention_state');
      setState(next);
    } catch {
      // Transient backend poll errors must not blank out current reminders.
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void refreshState();
    void invoke<{ settings: AttentionSettings; warning: string | null }>('get_attention_settings')
      .then(res => { if (!disposed && res?.settings) setSettings(res.settings); })
      .catch(() => {});
    void listen<AttentionStateSnapshot>('attention-updated', event => {
      if (!disposed) setState(event.payload);
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    const poll = window.setInterval(() => { void refreshState(); }, 15_000);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(poll);
    };
  }, [loaded, refreshState]);

  const scheduleMinute = Math.floor(now / 60_000);
  useEffect(() => {
    if (!loaded) return;
    const status = workWindowStatus(settings, now, reportZone);
    if (!status) return;
    void invoke('sync_attention_work_window', {
      window: {
        timeZone: reportZone,
        localDate: status.localDate,
        inWorkHours: status.inWorkHours,
      },
    }).catch(() => {});
  }, [loaded, settings, reportZone, scheduleMinute]);

  async function decideIdle(include: boolean) {
    const prompt = state.completedIdle;
    if (!prompt || busy) return;
    setBusy(true);
    setError('');
    try {
      await invoke('resolve_sleep_period', { entryId: prompt.entryId, periodId: prompt.periodId, include });
      await invoke('dismiss_idle_prompt', { periodId: prompt.periodId });
      await refreshState();
      await onMutated();
    } catch {
      setError('Nie udało się zapisać decyzji dotyczącej bezczynności. Sprawdź listę okresów.');
    } finally {
      setBusy(false);
    }
  }

  async function stopAtIdleStart() {
    const target = state.completedIdle ?? state.openIdle;
    if (!target || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<AttentionStateSnapshot>('stop_timer_at_idle_start', {
        expectedActiveId: target.entryId,
        periodId: target.periodId,
      });
      setState(next);
      await onMutated();
    } catch {
      setError('Nie udało się zatrzymać pomiaru na początku bezczynności.');
    } finally {
      setBusy(false);
    }
  }

  async function postponeIdle() {
    const prompt = state.completedIdle;
    if (!prompt || busy) return;
    setBusy(true);
    setError('');
    try {
      await invoke('dismiss_idle_prompt', { periodId: prompt.periodId });
      await refreshState();
    } finally {
      setBusy(false);
    }
  }

  async function muteToday() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const status = workWindowStatus(settings, Date.now(), reportZone);
      const next = await invoke<AttentionStateSnapshot>('mute_start_reminder_today', {
        localDate: status?.localDate ?? null,
      });
      setState(next);
    } finally {
      setBusy(false);
    }
  }

  async function stopLongTimer() {
    const reminder = state.longTimerReminder;
    if (!reminder || busy) return;
    setBusy(true);
    setError('');
    try {
      await invoke('stop_timer', { expectedActiveId: reminder.entryId });
      await refreshState();
      await onMutated();
    } catch {
      setError('Nie udało się zatrzymać pomiaru (pomiar mógł się już zmienić).');
    } finally {
      setBusy(false);
    }
  }

  async function muteLongTimer() {
    const reminder = state.longTimerReminder;
    if (!reminder || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<AttentionStateSnapshot>('mute_long_timer', { entryId: reminder.entryId });
      setState(next);
    } finally {
      setBusy(false);
    }
  }

  return {
    state,
    settings,
    setSettings,
    busy,
    error,
    refreshState,
    decideIdle,
    stopAtIdleStart,
    postponeIdle,
    muteToday,
    stopLongTimer,
    muteLongTimer,
  };
}

export type AttentionController = ReturnType<typeof useAttention>;
