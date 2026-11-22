// Presentation helpers for the History list (computer's local time, like the previous full dates).
const pad = (value: number) => String(value).padStart(2, '0');
const valid = (value: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const day = (date: Date, now: Date) => `${pad(date.getDate())}.${pad(date.getMonth() + 1)}${date.getFullYear() === now.getFullYear() ? '' : `.${date.getFullYear()}`}`;

/** Short row time: "21.11, 10:15" and the end as "11:45" on the same local day (year only when not the current one). */
export function entryTimeRange(startedAt: string, endedAt: string | null, nowMs: number): { start: string; end: string } {
  const now = new Date(nowMs);
  const start = valid(startedAt);
  const end = valid(endedAt);
  const full = (date: Date) => `${day(date, now)}, ${clock(date)}`;
  return {
    start: start ? full(start) : startedAt,
    end: !endedAt ? '—' : !end ? endedAt : start && sameDay(start, end) ? clock(end) : full(end),
  };
}

export type MenuKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';
/** Next enabled menu item for a key (wraps around); -1 when no item is enabled. */
export function menuStep(enabled: readonly boolean[], current: number, key: MenuKey): number {
  const count = enabled.length;
  if (!enabled.some(Boolean)) return -1;
  if (key === 'Home') return enabled.indexOf(true);
  if (key === 'End') return enabled.lastIndexOf(true);
  const step = key === 'ArrowDown' ? 1 : -1;
  let index = current < 0 || current >= count ? (step > 0 ? -1 : count) : current;
  for (let tries = 0; tries < count; tries++) {
    index = (index + step + count) % count;
    if (enabled[index]) return index;
  }
  return -1;
}
