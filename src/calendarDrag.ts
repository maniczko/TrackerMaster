// DEV-38: moving and resizing calendar blocks (mouse and keyboard). Pure rules, no I/O.
//
// A drop only proposes new wall-clock values for the edit form's fields (start, end); the save goes through
// the same transactional correction as the DEV-26 form (save_entry_draft → apply_entry_draft), and the
// form's rules (formProblem) decide whether it may be sent. Only what the user changed changes:
// - move: the grabbed piece lands on the 15-minute grid and the entry keeps its exact length;
// - start/end handle: only that end moves to the grid; the other one is sent as it is shown (whole
//   seconds) and the backend keeps its stored instant (#58), so no second is lost or shifted silently.
import { Temporal } from '@js-temporal/polyfill';
import { formProblem, SLOT_MINUTES, wallInstant, wallValue } from './calendarEntry.ts';
import type { FormProblem, OtherEntry, WallProblem } from './calendarEntry.ts';

const DAY_MINUTES = 24 * 60;
/** Pointer travel (CSS px) before a press becomes a drag; less is a plain click (opens the form). */
export const DRAG_THRESHOLD_PX = 6;
/** Keyboard step of Alt+arrows. */
export const KEY_STEP_MINUTES = SLOT_MINUTES;

export type DragKind = 'move' | 'start' | 'end';
/** The dragged entry (finished, exact stored instants) and the piece of it that was grabbed (one day). */
export type DragEntry = { id: number; startMs: number; endMs: number };
export type DragPiece = { date: string; startMs: number; endMs: number };
export type DragFields = { start: string; end: string };
export type DragProposal =
  | { ok: true; fields: DragFields; startMs: number; endMs: number; changed: boolean }
  | { ok: false; problem: FormProblem };

/** The nearest quarter-hour of a wall-clock minute, kept within the day (0–1440). */
export function snapMinute(minute: number): number {
  return Math.min(DAY_MINUTES, Math.max(0, Math.round(minute / SLOT_MINUTES) * SLOT_MINUTES));
}

/** `datetime-local` value of a wall-clock minute (0–1440) of a day; 1440 is 00:00 of the next day. */
export function wallAt(date: string, minute: number): string {
  const whole = Math.round(minute);
  return Temporal.PlainDate.from(date).toPlainDateTime().add({ minutes: whole }).toString({ smallestUnit: 'second' });
}

const shortDate = (value: string) => { const [y, m, d] = value.slice(0, 10).split('-'); return `${Number(d)}.${m}.${y}`; };
function gridProblem(label: string, value: string, problem: WallProblem): FormProblem {
  const at = `${value.slice(11, 16)} w dniu ${shortDate(value)}`;
  const field = label === 'Rozpoczęcie' ? 'start' : 'end';
  if (problem === 'nonexistent') return { field, message: `${label}: godzina ${at} nie istnieje (zmiana czasu na letni). Upuść wpis w innym miejscu.` };
  if (problem === 'ambiguous') return { field, message: `${label}: godzina ${at} występuje dwa razy (zmiana czasu na zimowy), więc nie wiadomo, o którą chodzi. Upuść wpis w innym miejscu albo popraw go w formularzu.` };
  return { field, message: `${label}: nie można ustalić tej godziny. Upuść wpis w innym miejscu.` };
}

/**
 * New field values for a drop. `target.minute` is the wall-clock minute where the grabbed piece's top
 * (move), the start edge or the end edge lands on `target.date`; it is snapped to the grid here.
 */
export function dropFields(kind: DragKind, entry: DragEntry, piece: DragPiece, target: { date: string; minute: number }, zone: string):
  { fields: DragFields; startMs: number; endMs: number } | { problem: FormProblem } {
  const minute = snapMinute(target.minute);
  const wall = wallAt(target.date, minute);
  const at = wallInstant(wall, zone);
  if (!('ms' in at)) return { problem: gridProblem(kind === 'end' ? 'Zakończenie' : 'Rozpoczęcie', wall, at.problem) };
  if (kind === 'start') return { fields: { start: wall, end: wallValue(entry.endMs, zone) }, startMs: at.ms, endMs: entry.endMs };
  if (kind === 'end') return { fields: { start: wallValue(entry.startMs, zone), end: wall }, startMs: entry.startMs, endMs: at.ms };
  // Move: the grabbed piece's start goes to the grid; the whole entry shifts by the same real time.
  // Whole seconds are sent, so the start is a whole second and the length stays exact (see keyFields).
  const startMs = Math.floor((entry.startMs + at.ms - piece.startMs) / 1000) * 1000;
  const endMs = startMs + (entry.endMs - entry.startMs);
  return { fields: { start: wallValue(startMs, zone), end: wallValue(endMs, zone) }, startMs, endMs };
}

/** New field values for Alt+arrows: move by ±15 minutes or ±1 day (wall clock), or the end by ±15 minutes. */
export function keyFields(action: 'earlier' | 'later' | 'previousDay' | 'nextDay' | 'shorter' | 'longer', entry: DragEntry, zone: string):
  { fields: DragFields; startMs: number; endMs: number } | { problem: FormProblem } {
  const shift = (ms: number, change: { minutes?: number; days?: number }) => Temporal.PlainDateTime.from(wallValue(ms, zone)).add(change).toString({ smallestUnit: 'second' });
  if (action === 'shorter' || action === 'longer') {
    const wall = shift(entry.endMs, { minutes: action === 'longer' ? KEY_STEP_MINUTES : -KEY_STEP_MINUTES });
    const at = wallInstant(wall, zone);
    if (!('ms' in at)) return { problem: gridProblem('Zakończenie', wall, at.problem) };
    return { fields: { start: wallValue(entry.startMs, zone), end: wall }, startMs: entry.startMs, endMs: at.ms };
  }
  const change = action === 'earlier' ? { minutes: -KEY_STEP_MINUTES } : action === 'later' ? { minutes: KEY_STEP_MINUTES }
    : action === 'previousDay' ? { days: -1 } : { days: 1 };
  const wall = shift(entry.startMs, change);
  const at = wallInstant(wall, zone);
  if (!('ms' in at)) return { problem: gridProblem('Rozpoczęcie', wall, at.problem) };
  // The start keeps its shown seconds (whole seconds are sent); the length stays exact in real time, also
  // over a DST change, so the saved whole-second length equals today's (a start's milliseconds could add one).
  const startMs = at.ms;
  const endMs = startMs + (entry.endMs - entry.startMs);
  return { fields: { start: wallValue(startMs, zone), end: wallValue(endMs, zone) }, startMs, endMs };
}

/**
 * Checks proposed values with the edit form's rules (end after start, not in the future, no overlap, no
 * nonexistent or repeated hour). `changed` is false when the values are the ones shown now: nothing is saved.
 */
export function checkProposal(proposed: { fields: DragFields; startMs: number; endMs: number } | { problem: FormProblem },
  entry: DragEntry, zone: string, nowMs: number, others: readonly OtherEntry[]): DragProposal {
  if ('problem' in proposed) return { ok: false, problem: proposed.problem };
  const { fields } = proposed;
  const changed = fields.start !== wallValue(entry.startMs, zone) || fields.end !== wallValue(entry.endMs, zone);
  if (!changed) return { ok: true, fields, startMs: entry.startMs, endMs: entry.endMs, changed: false };
  const problem = formProblem({ start: fields.start, end: fields.end, description: '', zone, nowMs, entryId: entry.id, needsProject: false, projectId: null, others });
  if (problem) return { ok: false, problem };
  return { ok: true, fields, startMs: proposed.startMs, endMs: proposed.endMs, changed: true };
}

/** Wall-clock minute of the pointer in a day column (clamped to the day), for drags that leave the column. */
export function pointerMinute(offsetPx: number, heightPx: number): number {
  if (!(heightPx > 0)) return 0;
  return Math.min(DAY_MINUTES, Math.max(0, (offsetPx / heightPx) * DAY_MINUTES));
}

/** Whole seconds of the entry after the change, as the report counts them (for the announcement). */
export const proposalSeconds = (startMs: number, endMs: number) => Math.floor(endMs / 1000) - Math.floor(startMs / 1000);
