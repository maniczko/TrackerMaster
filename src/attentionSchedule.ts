// Pure idle / reminder schedule & UI text helpers (TECH-12 / DEV-39). Zero I/O, zero logging.
import { Temporal } from '@js-temporal/polyfill';
import { formatDuration } from './reportCsv.ts';
import { validTimeZone } from './reportTime.ts';

export const IDLE_THRESHOLDS = [5, 10, 15, 30, 60] as const;
export const FIRST_REMINDER_MINUTES = [5, 10, 15, 30, 60] as const;
export const REPEAT_REMINDER_MINUTES = [15, 30, 60, 120] as const;
export const LONG_TIMER_HOURS = [2, 3, 4, 6, 8] as const;

export type AttentionSettings = {
  idleEnabled: boolean;
  idleThresholdMinutes: number;
  startReminderEnabled: boolean;
  workdays: number[];
  workStart: string;
  workEnd: string;
  firstReminderMinutes: number;
  repeatReminderMinutes: number;
  longTimerEnabled: boolean;
  longTimerHours: number;
  notificationsEnabled: boolean;
};

export const DEFAULT_ATTENTION_SETTINGS: AttentionSettings = {
  idleEnabled: true,
  idleThresholdMinutes: 10,
  startReminderEnabled: true,
  workdays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '17:00',
  firstReminderMinutes: 15,
  repeatReminderMinutes: 30,
  longTimerEnabled: true,
  longTimerHours: 4,
  notificationsEnabled: true,
};

export const WEEKDAY_LABELS: readonly [number, string][] = [
  [1, 'Pn'], [2, 'Wt'], [3, 'Śr'], [4, 'Cz'], [5, 'Pt'], [6, 'Sb'], [7, 'Nd'],
];

function parseClockMinutes(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function validateAttentionSettings(settings: AttentionSettings): string | null {
  if (!(IDLE_THRESHOLDS as readonly number[]).includes(settings.idleThresholdMinutes)) {
    return 'Wybierz dozwolony próg bezczynności (5, 10, 15, 30 lub 60 min).';
  }
  if (!settings.workdays.length || settings.workdays.some(d => !Number.isInteger(d) || d < 1 || d > 7)) {
    return 'Wybierz co najmniej jeden dzień pracy.';
  }
  const start = parseClockMinutes(settings.workStart);
  const end = parseClockMinutes(settings.workEnd);
  if (start === null || end === null || start >= end) {
    return 'Godzina końca pracy musi być późniejsza niż godzina rozpoczęcia.';
  }
  if (!(FIRST_REMINDER_MINUTES as readonly number[]).includes(settings.firstReminderMinutes)) {
    return 'Nieprawidłowe opóźnienie pierwszego przypomnienia.';
  }
  if (!(REPEAT_REMINDER_MINUTES as readonly number[]).includes(settings.repeatReminderMinutes)) {
    return 'Nieprawidłowy interwał powtarzania przypomnienia.';
  }
  if (!(LONG_TIMER_HOURS as readonly number[]).includes(settings.longTimerHours)) {
    return 'Wybierz dozwolony próg długiego pomiaru (2, 3, 4, 6 lub 8 h).';
  }
  return null;
}

export type WorkWindowStatus = {
  localDate: string;
  inWorkHours: boolean;
  startMs: number | null;
  endMs: number | null;
};

/**
 * Evaluate workdays & local HH:MM window in IANA `reportTimezone` (including 23h/25h DST days).
 * Non-existent wall times during spring-forward advance to the first valid instant (compatible disambiguation).
 */
export function workWindowStatus(settings: AttentionSettings, nowMs: number, zone: string): WorkWindowStatus | null {
  if (!validTimeZone(zone) || validateAttentionSettings(settings) !== null) return null;
  const nowZdt = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(zone);
  const localDate = nowZdt.toPlainDate().toString();
  if (!settings.workdays.includes(nowZdt.dayOfWeek)) {
    return { localDate, inWorkHours: false, startMs: null, endMs: null };
  }
  const date = nowZdt.toPlainDate();
  const [sh, sm] = settings.workStart.split(':').map(Number);
  const [eh, em] = settings.workEnd.split(':').map(Number);
  const resolveWall = (hour: number, minute: number) => {
    const zdt = date.toZonedDateTime({
      timeZone: zone,
      plainTime: new Temporal.PlainTime(hour, minute),
    });
    // Spring-forward DST gap (TECH-12 §2.1): advance to the first existing minute after the transition.
    if (zdt.hour !== hour || zdt.minute !== minute) {
      const transition = zdt.getTimeZoneTransition('previous');
      if (transition && transition.toPlainDate().equals(date)) return transition;
    }
    return zdt;
  };
  const startZdt = resolveWall(sh, sm);
  const endZdt = resolveWall(eh, em);
  const startMs = startZdt.epochMilliseconds;
  const endMs = endZdt.epochMilliseconds;
  return {
    localDate,
    inWorkHours: nowMs >= startMs && nowMs < endMs,
    startMs,
    endMs,
  };
}

export function formatIdleClock(ms: number, zone: string): string {
  try {
    const time = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
    return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
  } catch {
    return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  }
}

export function formatIdleDurationWords(seconds: number): string {
  const totalMinutes = Math.max(1, Math.round(Math.max(0, seconds) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

export function openIdleLabel(startedMs: number, nowMs: number, zone: string): string {
  const start = formatIdleClock(startedMs, zone);
  const minutes = Math.max(0, Math.floor((nowMs - startedMs) / 60_000));
  return `Bezczynność od ${start} — ${minutes} min czeka na decyzję`;
}

export function idlePromptText(startedMs: number, endedMs: number, zone: string): string {
  const span = `${formatIdleClock(startedMs, zone)}–${formatIdleClock(endedMs, zone)}`;
  const len = formatIdleDurationWords(Math.floor(Math.max(0, endedMs - startedMs) / 1000));
  return `Nie było Cię ${len} (${span}). Co zrobić z tym czasem?`;
}

export function longTimerReminderText(startedMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  return `Timer działa od ${formatIdleDurationWords(sec)} (${formatDuration(sec)}).`;
}
