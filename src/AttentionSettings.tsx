// Idle detection & work reminders configuration card in Settings (TECH-12 §§1.2, 2.4, O1-O4, O7).
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import {
  DEFAULT_ATTENTION_SETTINGS,
  FIRST_REMINDER_MINUTES,
  IDLE_THRESHOLDS,
  LONG_TIMER_HOURS,
  REPEAT_REMINDER_MINUTES,
  validateAttentionSettings,
  WEEKDAY_LABELS,
} from './attentionSchedule';
import type { AttentionSettings } from './attentionSchedule';

type SettingsRead = { settings: AttentionSettings; warning: string | null };

export default function AttentionSettingsPanel({
  onChange,
}: { onChange?: (settings: AttentionSettings) => void } = {}) {
  const [form, setForm] = useState<AttentionSettings>(DEFAULT_ATTENTION_SETTINGS);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void invoke<SettingsRead>('get_attention_settings')
      .then(result => {
        if (!active) return;
        setForm(result.settings);
        setWarning(result.warning ?? '');
        onChange?.(result.settings);
        setReady(true);
      })
      .catch(() => {
        if (active) setError('Nie udało się odczytać ustawień bezczynności i przypomnień.');
      });
    return () => { active = false; };
  }, []);

  function toggleWeekday(day: number) {
    setForm(current => {
      const exists = current.workdays.includes(day);
      const nextDays = exists
        ? current.workdays.filter(d => d !== day)
        : [...current.workdays, day].sort((a, b) => a - b);
      return { ...current, workdays: nextDays };
    });
  }

  async function save() {
    const problem = validateAttentionSettings(form);
    if (problem) {
      setError(problem);
      setNotice('');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await invoke<SettingsRead>('save_attention_settings', { settings: form });
      setForm(saved.settings);
      setWarning(saved.warning ?? '');
      onChange?.(saved.settings);
      setNotice('Zapisano ustawienia bezczynności i przypomnień.');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card attention-settings" aria-label="Bezczynność i przypomnienia">
      <div className="section-top">
        <div>
          <p className="section-kicker">PILNOWANIE CZASU</p>
          <h2>Bezczynność i przypomnienia</h2>
        </div>
      </div>
      <p className="muted">
        Wykrywa brak aktywności wyłącznie po czasie ostatniego wejścia w systemie Windows (bez zapisu treści ani nazw okien).
      </p>
      {warning && <p className="alert warning" role="status">{warning}</p>}
      <div className="attention-group">
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.idleEnabled}
            disabled={!ready || busy}
            onChange={e => setForm({ ...form, idleEnabled: e.target.checked })}
          />
          <span>Wykrywaj bezczynność przy działającym timerze</span>
        </label>
        <label>
          Próg bezczynności
          <select
            id="attention-idle-threshold"
            value={form.idleThresholdMinutes}
            disabled={!ready || busy || !form.idleEnabled}
            onChange={e => setForm({ ...form, idleThresholdMinutes: Number(e.target.value) })}
          >
            {IDLE_THRESHOLDS.map(min => (
              <option key={min} value={min}>{min} min</option>
            ))}
          </select>
        </label>
      </div>

      <div className="attention-group">
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.startReminderEnabled}
            disabled={!ready || busy}
            onChange={e => setForm({ ...form, startReminderEnabled: e.target.checked })}
          />
          <span>Przypominaj „Nic nie mierzysz” w godzinach pracy</span>
        </label>
        <div className="attention-workdays" role="group" aria-label="Dni pracy">
          {WEEKDAY_LABELS.map(([day, label]) => (
            <label key={day} className="attention-day-chip">
              <input
                type="checkbox"
                checked={form.workdays.includes(day)}
                disabled={!ready || busy || !form.startReminderEnabled}
                onChange={() => toggleWeekday(day)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="attention-row">
          <label>
            Praca od
            <input
              type="time"
              value={form.workStart}
              disabled={!ready || busy || !form.startReminderEnabled}
              onChange={e => setForm({ ...form, workStart: e.target.value })}
            />
          </label>
          <label>
            Praca do
            <input
              type="time"
              value={form.workEnd}
              disabled={!ready || busy || !form.startReminderEnabled}
              onChange={e => setForm({ ...form, workEnd: e.target.value })}
            />
          </label>
        </div>
        <div className="attention-row">
          <label>
            Pierwsze przypomnienie po
            <select
              value={form.firstReminderMinutes}
              disabled={!ready || busy || !form.startReminderEnabled}
              onChange={e => setForm({ ...form, firstReminderMinutes: Number(e.target.value) })}
            >
              {FIRST_REMINDER_MINUTES.map(min => (
                <option key={min} value={min}>{min} min obecności</option>
              ))}
            </select>
          </label>
          <label>
            Powtarzaj co
            <select
              value={form.repeatReminderMinutes}
              disabled={!ready || busy || !form.startReminderEnabled}
              onChange={e => setForm({ ...form, repeatReminderMinutes: Number(e.target.value) })}
            >
              {REPEAT_REMINDER_MINUTES.map(min => (
                <option key={min} value={min}>{min} min</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="attention-group">
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.longTimerEnabled}
            disabled={!ready || busy}
            onChange={e => setForm({ ...form, longTimerEnabled: e.target.checked })}
          />
          <span>Przypominaj „Timer działa za długo”</span>
        </label>
        <label>
          Próg długiego pomiaru
          <select
            value={form.longTimerHours}
            disabled={!ready || busy || !form.longTimerEnabled}
            onChange={e => setForm({ ...form, longTimerHours: Number(e.target.value) })}
          >
            {LONG_TIMER_HOURS.map(hours => (
              <option key={hours} value={hours}>{hours} h (kolejne po {hours * 2} h)</option>
            ))}
          </select>
        </label>
      </div>

      <div className="attention-group">
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.notificationsEnabled}
            disabled={!ready || busy}
            onChange={e => setForm({ ...form, notificationsEnabled: e.target.checked })}
          />
          <span>Powiadomienia systemu Windows (dodatek do banera w aplikacji)</span>
        </label>
      </div>

      <div className="actions">
        <button type="button" className="secondary" disabled={!ready || busy} onClick={() => void save()}>
          Zapisz ustawienia przypomnień
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <div className="alert error" role="alert">{error}</div>}
    </section>
  );
}
