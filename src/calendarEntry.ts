// DEV-26 (calendar package B): pure rules of the calendar's add/edit form. No I/O.
//
// The calendar shows wall-clock time of the reporting zone, so the form works in that zone too. These checks
// only give an immediate, specific Polish message; the backend repeats every rule in the same transaction as
// the write (parse_manual_range, ensure_no_overlap, ensure_no_sleep_periods) and stays the source of truth.
import { Temporal } from '@js-temporal/polyfill';

/** A click on an empty slot starts on the quarter-hour at or before the pointer. */
export const SLOT_MINUTES = 15;
/** Default length of a new entry. */
export const DEFAULT_MINUTES = 30;
const DAY_MINUTES = 24 * 60;
const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export type WallProblem = 'missing' | 'invalid' | 'nonexistent' | 'ambiguous';
export type WallResult = { ms: number } | { problem: WallProblem };

/** Resolves a `datetime-local` value in the zone only when it names exactly one instant (DST gaps and repeats are refused). */
export function wallInstant(value: string, zone: string): WallResult {
  if (!value) return { problem: 'missing' };
  if (!WALL.test(value)) return { problem: 'invalid' };
  let wall: Temporal.PlainDateTime;
  try { wall = Temporal.PlainDateTime.from(value, { overflow: 'reject' }); } catch { return { problem: 'invalid' }; }
  const earlier = wall.toZonedDateTime(zone, { disambiguation: 'earlier' });
  const later = wall.toZonedDateTime(zone, { disambiguation: 'later' });
  if (!earlier.toPlainDateTime().equals(wall) || !later.toPlainDateTime().equals(wall)) return { problem: 'nonexistent' };
  if (earlier.epochMilliseconds !== later.epochMilliseconds) return { problem: 'ambiguous' };
  return { ms: earlier.epochMilliseconds };
}

/** `datetime-local` value (whole seconds) of an instant in the zone. */
export function wallValue(ms: number, zone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(Math.floor(ms / 1000) * 1000).toZonedDateTimeISO(zone)
    .toPlainDateTime().toString({ smallestUnit: 'second' });
}

/** Start of a new entry from a click at a wall-clock minute (0–1440) of a calendar day, rounded down to 15 minutes. */
export function slotStart(date: string, minute: number): string {
  const rounded = Math.min(DAY_MINUTES - SLOT_MINUTES, Math.max(0, Math.floor(minute / SLOT_MINUTES) * SLOT_MINUTES));
  return Temporal.PlainDate.from(date).toPlainDateTime({ hour: Math.floor(rounded / 60), minute: rounded % 60 }).toString({ smallestUnit: 'second' });
}

/**
 * Default end: 30 minutes of real time after the start (so 01:45 on a spring-forward night ends at 03:15).
 * When the start itself is not one instant, the wall clock is advanced and the form reports the start.
 */
export function defaultEnd(start: string, zone: string): string {
  const resolved = wallInstant(start, zone);
  if ('ms' in resolved) return wallValue(resolved.ms + DEFAULT_MINUTES * 60_000, zone);
  return Temporal.PlainDateTime.from(start).add({ minutes: DEFAULT_MINUTES }).toString({ smallestUnit: 'second' });
}

/** New entry from the keyboard ("Dodaj wpis"): the last full half hour of today, or 09:00 on the selected day / Monday. */
export function keyboardRange(weekStart: string, today: string | null, nowMs: number, zone: string, targetDate?: string): { start: string; end: string } {
  if (targetDate) {
    if (today && today === targetDate) {
      const startMs = Math.floor((nowMs - DEFAULT_MINUTES * 60_000) / (SLOT_MINUTES * 60_000)) * SLOT_MINUTES * 60_000;
      return { start: wallValue(startMs, zone), end: wallValue(startMs + DEFAULT_MINUTES * 60_000, zone) };
    }
    const start = slotStart(targetDate, 9 * 60);
    return { start, end: defaultEnd(start, zone) };
  }
  const weekEnd = Temporal.PlainDate.from(weekStart).add({ days: 7 }).toString();
  if (today && today >= weekStart && today < weekEnd) {
    const startMs = Math.floor((nowMs - DEFAULT_MINUTES * 60_000) / (SLOT_MINUTES * 60_000)) * SLOT_MINUTES * 60_000;
    return { start: wallValue(startMs, zone), end: wallValue(startMs + DEFAULT_MINUTES * 60_000, zone) };
  }
  const start = slotStart(weekStart, 9 * 60);
  return { start, end: defaultEnd(start, zone) };
}

export type FormField = 'start' | 'end' | 'project' | 'description';
export type FormProblem = { field: FormField; message: string };
/** Another entry the new range must not cover (`endMs` null: a running timer, open-ended like in the backend). */
export type OtherEntry = { id: number; startMs: number; endMs: number | null; label: string };
export type FormInput = {
  start: string; end: string; description: string; zone: string; nowMs: number;
  /** The edited entry (excluded from the overlap check); null for a new entry. */
  entryId: number | null;
  /** A new entry needs a project; an edited one keeps its own. */
  needsProject: boolean; projectId: number | null;
  others: readonly OtherEntry[];
};

const shortDate = (value: string) => { const [y, m, d] = value.slice(0, 10).split('-'); return `${Number(d)}.${m}.${y}`; };
function wallMessage(label: string, value: string, problem: WallProblem): string {
  const at = `${value.slice(11, 16)} w dniu ${shortDate(value)}`;
  if (problem === 'missing') return `Podaj datę i godzinę: ${label.toLowerCase()}.`;
  if (problem === 'invalid') return `${label}: sprawdź datę i godzinę.`;
  if (problem === 'nonexistent') return `${label}: godzina ${at} nie istnieje (zmiana czasu na letni). Wybierz inną godzinę.`;
  return `${label}: godzina ${at} występuje dwa razy (zmiana czasu na zimowy), więc nie wiadomo, o którą chodzi. Wybierz inną godzinę.`;
}

/** Same rule as ensure_no_overlap: touching ends are fine; a zero-length entry never overlaps. */
export function overlapping(startMs: number, endMs: number, others: readonly OtherEntry[], entryId: number | null): OtherEntry | null {
  return others.find(other => other.id !== entryId && other.endMs !== other.startMs
    && other.startMs < endMs && (other.endMs === null || other.endMs > startMs)) ?? null;
}

/** The first problem of the form, in reading order, or null when the backend may be asked to save it. */
export function formProblem(input: FormInput): FormProblem | null {
  const start = wallInstant(input.start, input.zone);
  if (!('ms' in start)) return { field: 'start', message: wallMessage('Rozpoczęcie', input.start, start.problem) };
  const end = wallInstant(input.end, input.zone);
  if (!('ms' in end)) return { field: 'end', message: wallMessage('Zakończenie', input.end, end.problem) };
  if (end.ms <= start.ms) return { field: 'end', message: 'Koniec musi być późniejszy od początku.' };
  if (end.ms > input.nowMs) return { field: 'end', message: 'Czas zakończenia nie może być w przyszłości.' };
  const other = overlapping(start.ms, end.ms, input.others, input.entryId);
  if (other) return { field: 'start', message: `Ten czas nakłada się na istniejący pomiar (${other.label}). Popraw godziny przed zapisaniem.` };
  if (input.needsProject && input.projectId === null) return { field: 'project', message: 'Wybierz klienta i projekt.' };
  if ([...input.description].length > 2000) return { field: 'description', message: 'Opis może mieć najwyżej 2000 znaków.' };
  return null;
}

/** Wall-clock minute under the pointer in a day column of `heightPx` (24 h); null outside the column. */
export function minuteAt(offsetPx: number, heightPx: number): number | null {
  if (!(heightPx > 0) || offsetPx < 0 || offsetPx >= heightPx) return null;
  return (offsetPx / heightPx) * DAY_MINUTES;
}
