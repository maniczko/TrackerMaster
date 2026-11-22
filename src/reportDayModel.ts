// Day and week figures next to the timer, and History grouped by day. Both reuse the report's own
// calculation (makeReportView / reportGlance: presets, reporting zone, sleep, pending, active projection),
// so every number shown here equals the report for all clients. Pure, no I/O.
import { Temporal } from '@js-temporal/polyfill';
import { reportGlance } from './reportGlanceModel.ts';
import { reportPresetRange } from './reportPresets.ts';
import { addDaySeconds, dateInZone, validTimeZone } from './reportTime.ts';
import { makeReportView } from './reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from './reportView.ts';
import { allReportClients } from './reportScope.ts';
import type { ReportCatalog } from './reportScope.ts';

type ReportData = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };

/** "2 h 15 min", "45 min", "0 min" (whole minutes, rounded down like the report's seconds). */
export function shortDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

export type TimerTotals = { todaySeconds: number; weekSeconds: number; text: string; needsReview: boolean };

/** "Dziś … · Tydzień …" from the report card values (all clients, active timer only when resolved). */
export function timerTotals(data: ReportData, catalog: ReportCatalog, now: number): TimerTotals | null {
  const glance = reportGlance(data, catalog, now);
  if (!glance) return null;
  return { todaySeconds: glance.todaySeconds, weekSeconds: glance.weekSeconds, needsReview: glance.needsReview,
    text: `Dziś ${shortDuration(glance.todaySeconds)} · Tydzień ${shortDuration(glance.weekSeconds)}` };
}

type Id = number | string;

/** What the clock knows about the running timer (the main window snapshot, refreshed every 2.5 s). */
export type ClockActive = { id: Id; recovered?: boolean; uncertain?: boolean } | null;

/**
 * Report data for the totals base. A timer that the clock already shows as "do weryfikacji" or with
 * uncertain time after sleep is never counted, even if the last report read (up to 60 s old) still
 * had a resolved projection for it.
 */
export function totalsBaseData(data: ReportData, clock: ClockActive): ReportData {
  const awaiting = !!data.active && !!clock && String(clock.id) === String(data.active.id) && (!!clock.recovered || !!clock.uncertain);
  return awaiting ? { ...data, active: null } : data;
}

const overlapSeconds = (from: number, to: number, start: number, end: number) => Math.max(0, Math.min(to, end) - Math.max(from, start)) / 1000;

/**
 * "Dziś … · Tydzień …" that runs with the clock. The base is the report (totalsBaseData + timerTotals at
 * `now`), which already counts the active timer up to the end of its projection. Only the time after
 * that end is added, and only while the fresh snapshot shows the same timer as running and resolved,
 * so the active timer is counted exactly once and never through a sleep the report has not checked.
 * The added time is split by day in the reporting zone (midnight and week boundaries).
 */
export function liveTimerTotals(base: TimerTotals, data: ReportData, now: number, clock: ClockActive, clockFresh: boolean): TimerTotals {
  const active = data.active;
  const zone = data.time_zone;
  let today = base.todaySeconds;
  let week = base.weekSeconds;
  if (active && !active.unresolved && active.ended_at && clock && clockFresh && String(clock.id) === String(active.id) &&
      !clock.recovered && !clock.uncertain && validTimeZone(zone)) {
    const from = Date.parse(active.ended_at);
    if (Number.isFinite(from) && now > from) {
      const day = reportPresetRange('today', now, zone);
      const span = reportPresetRange('week', now, zone);
      const next = (date: string) => dayStartMs(Temporal.PlainDate.from(date).add({ days: 1 }).toString(), zone);
      today += overlapSeconds(from, now, dayStartMs(day.from, zone), next(day.through));
      week += overlapSeconds(from, now, dayStartMs(span.from, zone), next(span.through));
    }
  }
  today = Math.floor(today); week = Math.floor(week);
  return { ...base, todaySeconds: today, weekSeconds: week, text: `Dziś ${shortDuration(today)} · Tydzień ${shortDuration(week)}` };
}
export type HistoryEntry = { id: Id; started_at: string; ended_at: string | null };
/** Part of an entry inside one day: the whole entry, or a piece of an entry that crosses midnight. */
export type HistoryPart = 'whole' | 'first' | 'middle' | 'last';
export type HistoryRow<E extends HistoryEntry> = {
  entry: E; date: string; part: HistoryPart; start: string; end: string;
  /** Report seconds for this day (sleep and pending as in the report); null when the report excludes the entry. */
  seconds: number | null;
};
export type HistoryDay<E extends HistoryEntry> = { date: string; label: string; seconds: number; rows: HistoryRow<E>[] };

const clockIn = (ms: number, zone: string) => {
  const time = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
};
const dayStartMs = (date: string, zone: string) => Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: zone }).epochMilliseconds;
const dayLabel = (date: string, today: string) => {
  if (date === today) return 'Dziś';
  if (date === Temporal.PlainDate.from(today).subtract({ days: 1 }).toString()) return 'Wczoraj';
  const day = Temporal.PlainDate.from(date);
  const text = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
    ...(day.year === Temporal.PlainDate.from(today).year ? {} : { year: 'numeric' }) }).format(Date.UTC(day.year, day.month - 1, day.day));
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * History grouped by day in the reporting zone. An entry that crosses midnight is shown in every day it
 * touches, as in the report's segmentation (TECH-09): "23:30–24:00" on the first day and "00:00–00:45" on the
 * next, each with that day's report seconds. The day header is the report's day total for all clients
 * (it includes a resolved running timer, like "Czas z aktywnym pomiarem"). Returns null when the zone is invalid.
 */
export function historyDays<E extends HistoryEntry>(entries: readonly E[], data: ReportData, catalog: ReportCatalog, now: number): HistoryDay<E>[] | null {
  const zone = data.time_zone;
  if (!validTimeZone(zone)) return null;
  const spans = entries.flatMap(entry => {
    const start = Date.parse(entry.started_at);
    const end = entry.ended_at === null ? NaN : Date.parse(entry.ended_at);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [{ entry, start, end }] : [];
  });
  if (!spans.length) return [];
  const first = spans.reduce((min, span) => Math.min(min, span.start), Infinity);
  const last = spans.reduce((max, span) => Math.max(max, span.end > span.start ? span.end - 1 : span.start), -Infinity);
  const view = makeReportView(data, catalog, allReportClients, dateInZone(first, zone), dateInZone(last, zone));
  const dayTotals = new Map(view.liveDays.map(day => [day.date, day.seconds]));
  const contributions = new Map(view.contributions.map(item => [String(item.id), item]));
  const days = new Map<string, HistoryRow<E>[]>();
  for (const { entry, start, end } of spans) {
    const contribution = contributions.get(String(entry.id));
    // All pieces of one local date are summed with the report's own function (several pieces per date are possible).
    const entryDays = contribution ? addDaySeconds(new Map(), contribution.days) : null;
    const lastDate = dateInZone(end > start ? end - 1 : start, zone);
    const dates: string[] = [];
    for (let date = dateInZone(start, zone); date <= lastDate; date = Temporal.PlainDate.from(date).add({ days: 1 }).toString()) dates.push(date);
    dates.forEach((date, index) => {
      const next = dayStartMs(Temporal.PlainDate.from(date).add({ days: 1 }).toString(), zone);
      const pieceStart = Math.max(start, dayStartMs(date, zone));
      const pieceEnd = Math.min(end, next);
      const part: HistoryPart = dates.length === 1 ? 'whole' : index === 0 ? 'first' : index === dates.length - 1 ? 'last' : 'middle';
      const seconds = entryDays ? entryDays.get(date) ?? 0 : null;
      const row = { entry, date, part, start: clockIn(pieceStart, zone), end: pieceEnd === next && part !== 'whole' ? '24:00' : clockIn(pieceEnd, zone), seconds };
      days.set(date, [...(days.get(date) ?? []), row]);
    });
  }
  const today = dateInZone(now, zone);
  return [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, rows]) => ({
    date, label: dayLabel(date, today), seconds: dayTotals.get(date) ?? 0,
    rows: rows.sort((a, b) => Date.parse(b.entry.started_at) - Date.parse(a.entry.started_at)),
  }));
}
