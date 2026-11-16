import { Temporal } from '@js-temporal/polyfill';

export type ReportEntry = { id: number; started_at: string; ended_at: string; duration_seconds: number };
export type ReportDay = { date: string; seconds: number };
export type ReportResult = { days: ReportDay[]; totalSeconds: number; averageSeconds: number | null; excludedEntryIds: number[] };
export type OverlapWarning = { entryIds: number[]; truncated: boolean };

export function validTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone !== timeZone.trim() || timeZone.length > 128 || !/^[A-Za-z0-9_+\-/]+$/.test(timeZone) || (timeZone !== 'UTC' && !timeZone.includes('/'))) return false;
  try { Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone); return true; } catch { return false; }
}

export function dateInZone(ms: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; }
}

// Split at local midnight and at offset transitions. The latter matters when
// clocks move backward across midnight, or an entire local date is skipped.
function pieces(start: number, end: number, zone: string): ReportDay[] {
  const result: ReportDay[] = [];
  let cursor = start;
  while (cursor < end) {
    const zoned = Temporal.Instant.fromEpochMilliseconds(cursor).toZonedDateTimeISO(zone);
    const day = zoned.toPlainDate().toString();
    const nextDate = zoned.toPlainDate().add({ days: 1 });
    const nextMidnight = nextDate.toPlainDateTime();
    const candidates = [end];
    for (const disambiguation of ['earlier', 'later'] as const) {
      const candidate = nextMidnight.toZonedDateTime(zone, { disambiguation });
      if (candidate.toPlainDate().equals(nextDate) && candidate.epochMilliseconds > cursor) candidates.push(candidate.epochMilliseconds);
    }
    const transition = zoned.getTimeZoneTransition('next');
    if (transition && transition.epochMilliseconds > cursor) candidates.push(transition.epochMilliseconds);
    const boundary = Math.min(...candidates);
    const seconds = Math.floor((boundary - start) / 1000) - Math.floor((cursor - start) / 1000);
    result.push({ date: day, seconds });
    cursor = boundary;
  }
  return result;
}

/** Allocate stored durations without silently redistributing ambiguous time. */
export function reportByDay(entries: ReportEntry[], from: string, through: string, timeZone: string): ReportResult {
  if (!validDate(from) || !validDate(through) || from > through || from < '1970-01-01') throw new Error('Nieprawidłowy zakres dat raportu.');
  if (!validTimeZone(timeZone)) throw new Error('Nieprawidłowa strefa czasowa.');
  const totals = new Map<string, number>();
  const excludedEntryIds: number[] = [];
  const ids = new Set<number>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error('Powtórzony wpis w danych raportu.');
    ids.add(entry.id);
    const start = Date.parse(entry.started_at), end = Date.parse(entry.ended_at);
    const hasOffsets = /(?:Z|[+-]\d\d:\d\d)$/i.test(entry.started_at) && /(?:Z|[+-]\d\d:\d\d)$/i.test(entry.ended_at);
    if (!hasOffsets || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start ||
        end - start > 3660 * 86400_000 || !Number.isSafeInteger(entry.duration_seconds) || entry.duration_seconds < 0) {
      excludedEntryIds.push(entry.id); continue;
    }
    const segments = pieces(start, end, timeZone);
    const inRange = (date: string) => date >= from && date <= through;
    if (segments.length && !segments.some(segment => inRange(segment.date))) continue;
    const difference = Math.abs(Math.floor((end - start) / 1000) - entry.duration_seconds);
    if (difference !== 0) {
      const dates = new Set(segments.map(segment => segment.date));
      if (difference <= 2 && dates.size === 1) {
        const day = segments[0].date;
        if (inRange(day) && entry.duration_seconds > 0) totals.set(day, (totals.get(day) ?? 0) + entry.duration_seconds);
      } else excludedEntryIds.push(entry.id);
      continue;
    }
    for (const segment of segments) {
      if (inRange(segment.date) && segment.seconds > 0) totals.set(segment.date, (totals.get(segment.date) ?? 0) + segment.seconds);
    }
  }
  const days = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds }));
  const totalSeconds = days.reduce((sum, day) => sum + day.seconds, 0);
  return { days, totalSeconds, averageSeconds: days.length ? totalSeconds / days.length : null, excludedEntryIds };
}

export const reportByWarsawDay = (entries: ReportEntry[], from: string, through: string) => reportByDay(entries, from, through, 'Europe/Warsaw');

// Existing legacy data may contain overlaps even though new ones are rejected.
// Do not silently change historical totals: surface affected IDs for correction.
export function reportOverlaps(entries: ReportEntry[], from: string, through: string, zone: string): OverlapWarning {
  if (!validDate(from) || !validDate(through) || from > through || from < '1970-01-01' || !validTimeZone(zone)) throw new Error('Nieprawidłowy zakres lub strefa.');
  const intervals = entries.map(entry => ({ id: entry.id, start: Date.parse(entry.started_at), end: Date.parse(entry.ended_at), validOffsets: /(?:Z|[+-]\d\d:\d\d)$/i.test(entry.started_at) && /(?:Z|[+-]\d\d:\d\d)$/i.test(entry.ended_at) }))
    .filter(entry => entry.validOffsets && Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.start >= 0 && entry.end > entry.start && entry.end - entry.start <= 3660 * 86400_000)
    .filter(entry => pieces(entry.start, entry.end, zone).some(part => part.date >= from && part.date <= through))
    .sort((a, b) => a.start - b.start || a.id - b.id);
  const ids = new Set<number>();
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length && intervals[j].start < intervals[i].end; j++) {
      const start = Math.max(intervals[i].start, intervals[j].start);
      const end = Math.min(intervals[i].end, intervals[j].end);
      if (pieces(start, end, zone).some(part => part.date >= from && part.date <= through)) {
        ids.add(intervals[i].id); ids.add(intervals[j].id);
        if (ids.size >= 50) return { entryIds: [...ids], truncated: true };
      }
    }
  }
  return { entryIds: [...ids], truncated: false };
}
