import { Temporal } from '@js-temporal/polyfill';
import { splitSleepTime } from './sleepTime.ts';
import type { SleepPeriod } from './sleepTime.ts';

export type ReportEntry = { id: number; started_at: string; ended_at: string; duration_seconds: number; sleep_periods?: readonly SleepPeriod[] };
export type ReportDay = { date: string; seconds: number };
export type EntryContribution = { id: number; days: ReportDay[]; seconds: number; pendingSeconds: number; hasPendingSleep: boolean };
export type ReportResult = { days: ReportDay[]; totalSeconds: number; averageSeconds: number | null; excludedEntryIds: number[]; pendingSeconds: number; pendingPeriodCount: number; contributions: EntryContribution[] };
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

// Include a full day on both sides to cover IANA offsets before applying exact local-date boundaries.
const utcDayMs = 86_400_000;

function utcEnvelope(from: string, through: string) {
  return { lower: Date.parse(from) - utcDayMs, upper: Date.parse(through) + 2 * utcDayMs };
}

function parseReportTimestamp(value: string): number {
  if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  // The application normally stores millisecond UTC strings. The round trip also rejects normalized invalid dates.
  if (value.length === 24 && value.endsWith('Z') && new Date(parsed).toISOString() === value) return parsed;
  try { return Temporal.Instant.from(value).epochMilliseconds; } catch { return NaN; }
}

// Cache timezone boundaries per UTC day so the input order does not affect reuse.
// Splitting at the edge of each cache bucket preserves seconds because all pieces share the anchor.
function calendarPieces(zone: string) {
  type Slice = { until: number; date: string };
  const cache = new Map<number, Slice[]>();

  function readBucket(day: number): Slice[] {
    const stored = cache.get(day);
    if (stored) return stored;
    const slices: Slice[] = [];
    const stop = day + utcDayMs;
    for (let at = day; at < stop;) {
      const zoned = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone);
      const date = zoned.toPlainDate();
      const nextDate = date.add({ days: 1 });
      const nextMidnight = nextDate.toPlainDateTime();
      const transition = zoned.getTimeZoneTransition('next');
      let until = transition && transition.epochMilliseconds > at ? Math.min(stop, transition.epochMilliseconds) : stop;
      for (const disambiguation of ['earlier', 'later'] as const) {
        const candidate = nextMidnight.toZonedDateTime(zone, { disambiguation });
        if (candidate.toPlainDate().equals(nextDate) && candidate.epochMilliseconds > at) {
          until = Math.min(until, candidate.epochMilliseconds);
        }
      }
      slices.push({ until, date: date.toString() });
      at = until;
    }
    cache.set(day, slices);
    return slices;
  }

  return (start: number, end: number, anchor = start): ReportDay[] => {
    const result: ReportDay[] = [];
    let cursor = start;
    while (cursor < end) {
      for (const slice of readBucket(Math.floor(cursor / utcDayMs) * utcDayMs)) {
        if (slice.until <= cursor) continue;
        const boundary = Math.min(end, slice.until);
        const seconds = Math.floor((boundary - anchor) / 1000) - Math.floor((cursor - anchor) / 1000);
        result.push({ date: slice.date, seconds });
        cursor = boundary;
        if (cursor === end) break;
      }
    }
    return result;
  };
}

/** Allocate stored durations without silently redistributing ambiguous time. */
/**
 * Adds day pieces to per-date totals. One local date can have several pieces (for example split at UTC
 * midnight or around sleep), so every piece of that date is summed. The report day totals and any
 * per-entry day amount (History) use this same function.
 */
export function addDaySeconds(totals: Map<string, number>, days: readonly ReportDay[]): Map<string, number> {
  for (const day of days) {
    if (day.seconds > 0) totals.set(day.date, (totals.get(day.date) ?? 0) + day.seconds);
  }
  return totals;
}

export function reportByDay(entries: ReportEntry[], from: string, through: string, timeZone: string): ReportResult {
  if (!validDate(from) || !validDate(through) || from > through || from < '1970-01-01') throw new Error('Nieprawidłowy zakres dat raportu.');
  if (!validTimeZone(timeZone)) throw new Error('Nieprawidłowa strefa czasowa.');
  const totals = new Map<string, number>();
  const excludedEntryIds: number[] = [];
  const contributions: EntryContribution[] = [];
  let pendingSeconds = 0;
  let pendingPeriodCount = 0;
  const ids = new Set<number>();
  const { lower, upper } = utcEnvelope(from, through);
  const inRange = (date: string) => date >= from && date <= through;
  const pieces = calendarPieces(timeZone);

  function addEntry(id: number, days: ReportDay[], pending: number, hasPendingSleep: boolean) {
    const seconds = days.reduce((sum, day) => sum + day.seconds, 0);
    addDaySeconds(totals, days);
    pendingSeconds += pending;
    contributions.push({ id, days, seconds, pendingSeconds: pending, hasPendingSleep });
  }

  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error('Powtórzony wpis w danych raportu.');
    ids.add(entry.id);
    const start = parseReportTimestamp(entry.started_at), end = parseReportTimestamp(entry.ended_at);
    if (!Number.isSafeInteger(entry.id) || entry.id <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start ||
        end - start > 3660 * 86400_000 || !Number.isSafeInteger(entry.duration_seconds) || entry.duration_seconds < 0) {
      excludedEntryIds.push(entry.id); continue;
    }
    if (entry.sleep_periods !== undefined) {
      try {
        if (!Array.isArray(entry.sleep_periods)) throw new Error('Nieprawidłowe okresy.');
        const split = splitSleepTime(entry.id, start, end, entry.sleep_periods);
        // The native source must supply work duration, excluding pending and rejected sleep.
        if (entry.duration_seconds !== Math.floor(split.workMs / 1000)) throw new Error('Niespójny czas pracy.');
        if (end < lower || start >= upper) continue;
        let workElapsed = 0, pendingElapsed = 0, entryPendingSeconds = 0, entryPendingPeriods = 0;
        const entryTotals = new Map<string, number>();
        for (const part of split.segments) {
          if (part.kind === 'excluded') continue;
          const elapsed = part.kind === 'work' ? workElapsed : pendingElapsed;
          if (part.endedMs >= lower && part.startedMs < upper) {
            let intersectsRange = false;
            for (const day of pieces(part.startedMs, part.endedMs, part.startedMs - elapsed)) {
              if (!inRange(day.date)) continue;
              intersectsRange = true;
              if (day.seconds <= 0) continue;
              if (part.kind === 'work') entryTotals.set(day.date, (entryTotals.get(day.date) ?? 0) + day.seconds);
              else entryPendingSeconds += day.seconds;
            }
            if (part.kind === 'pending' && intersectsRange) entryPendingPeriods++;
          }
          if (part.kind === 'work') workElapsed += part.endedMs - part.startedMs;
          else pendingElapsed += part.endedMs - part.startedMs;
        }
        pendingPeriodCount += entryPendingPeriods;
        if (entryTotals.size || entryPendingPeriods || (start === end && inRange(dateInZone(start, timeZone)))) {
          addEntry(entry.id, Array.from(entryTotals, ([date, seconds]) => ({ date, seconds })),
            entryPendingSeconds, entry.sleep_periods.some(period => period.decision === 'pending'));
        }
      } catch { excludedEntryIds.push(entry.id); }
      continue;
    }
    if (end < lower || start >= upper) continue;
    if (start === end) {
      if (entry.duration_seconds !== 0) excludedEntryIds.push(entry.id);
      else if (inRange(dateInZone(start, timeZone))) addEntry(entry.id, [], 0, false);
      continue;
    }
    const segments = pieces(start, end);
    if (segments.length && !segments.some(segment => inRange(segment.date))) continue;
    const difference = Math.abs(Math.floor((end - start) / 1000) - entry.duration_seconds);
    if (difference !== 0) {
      const dates = new Set(segments.map(segment => segment.date));
      if (difference <= 2 && dates.size === 1) {
        const day = segments[0].date;
        if (inRange(day) && entry.duration_seconds > 0) addEntry(entry.id, [{ date: day, seconds: entry.duration_seconds }], 0, false);
      } else excludedEntryIds.push(entry.id);
      continue;
    }
    const included = segments.filter(segment => inRange(segment.date) && segment.seconds > 0);
    if (included.length) addEntry(entry.id, included, 0, false);
  }
  const days = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds }));
  const totalSeconds = days.reduce((sum, day) => sum + day.seconds, 0);
  return { days, totalSeconds, averageSeconds: days.length ? totalSeconds / days.length : null, excludedEntryIds, pendingSeconds, pendingPeriodCount, contributions };
}

export const reportByWarsawDay = (entries: ReportEntry[], from: string, through: string) => reportByDay(entries, from, through, 'Europe/Warsaw');

// Existing legacy data may contain overlaps even though new ones are rejected.
// Do not silently change historical totals: surface affected IDs for correction.
export function reportOverlaps(entries: ReportEntry[], from: string, through: string, zone: string): OverlapWarning {
  if (!validDate(from) || !validDate(through) || from > through || from < '1970-01-01' || !validTimeZone(zone)) throw new Error('Nieprawidłowy zakres lub strefa.');
  const { lower, upper } = utcEnvelope(from, through);
  const pieces = calendarPieces(zone);
  const inRange = (part: ReportDay) => part.date >= from && part.date <= through;
  const intervals = entries.map(entry => ({ id: entry.id, start: parseReportTimestamp(entry.started_at), end: parseReportTimestamp(entry.ended_at) }))
    .filter(entry => Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.start >= 0 && entry.end > entry.start && entry.end - entry.start <= 3660 * 86400_000)
    .filter(entry => entry.end > lower && entry.start < upper)
    .sort((a, b) => a.start - b.start || a.id - b.id)
    .filter(entry => pieces(entry.start, entry.end).some(inRange));
  const ids = new Set<number>();
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length && intervals[j].start < intervals[i].end; j++) {
      const start = Math.max(intervals[i].start, intervals[j].start);
      const end = Math.min(intervals[i].end, intervals[j].end);
      if (pieces(start, end).some(inRange)) {
        ids.add(intervals[i].id); ids.add(intervals[j].id);
        if (ids.size >= 50) return { entryIds: [...ids], truncated: true };
      }
    }
  }
  return { entryIds: [...ids], truncated: false };
}
