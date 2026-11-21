/** Resolve a local form value only when it identifies exactly one instant. */
export function parseLocalDate(value: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts) return null;
  const date = new Date(value);
  const expected = parts.slice(1).map(part => Number(part || 0));
  const components = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  if (Number.isNaN(date.getTime()) || components(date).some((part, index) => part !== expected[index])) return null;
  // During a backward clock change the same local time can identify two instants.
  for (let minutes = -180; minutes <= 180; minutes++) {
    if (minutes === 0) continue;
    const other = new Date(date.getTime() + minutes * 60_000);
    if (components(other).every((part, index) => part === expected[index])) return null;
  }
  return date;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** Wall-clock value for `<input type="datetime-local" step="1">` in the computer's time zone, rounded down to a second. */
export function toLocalInputValue(ms: number): string {
  const date = new Date(Math.floor(ms / 1000) * 1000);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * UI hint limits for a local date-time field: `min` = the start (rounded up to a whole second, so the first allowed
 * value is not before it) and `max` = now. The backend stays the source of truth. After a backward clock change the
 * start's wall clock can be later than now's; then `min` is omitted so a valid instant is never blocked.
 */
export function localInputRange(startMs: number | null, nowMs: number): { min?: string; max: string } {
  const max = toLocalInputValue(nowMs);
  if (startMs === null || !Number.isFinite(startMs)) return { max };
  const min = toLocalInputValue(Math.ceil(startMs / 1000) * 1000);
  return min <= max ? { min, max } : { max };
}

export type LocalRangeProblem = 'invalid' | 'before' | 'after';
/** Checks a local field value against a start instant and now; `null` for an empty or acceptable value. */
export function localRangeProblem(value: string, startMs: number | null, nowMs: number): LocalRangeProblem | null {
  if (!value) return null;
  const date = parseLocalDate(value);
  if (!date) return 'invalid';
  if (startMs !== null && date.getTime() < startMs) return 'before';
  if (date.getTime() > nowMs) return 'after';
  return null;
}
