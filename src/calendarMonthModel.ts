// DEV-25 / PTT-46: the month view model. Pure, no I/O.
//
// Nothing is counted here. Every cell is a day of `calendarWeek` (DEV-24), so the month uses the same
// segment selector, D12 day split, DST handling, pending-sleep rule and live timer as the week, and the
// day totals are the report's own day totals (makeReportView → reportByDay) for the same filters. The
// month total is the sum of the month's own days; days of the neighbouring months shown in the grid
// are never added to it. The month view is an aggregate: no hourly blocks (UI spec, section C).
import { Temporal } from '@js-temporal/polyfill';
import { calendarData, calendarWeek, pieceRange, validCalendarDate, weekStartOf } from './calendarModel.ts';
import type { CalendarBlock, CalendarClockEntry, CalendarFilter, CalendarReportData, PieceKind } from './calendarModel.ts';
import { makeReportView } from './reportView.ts';
import type { ReportCatalog } from './reportScope.ts';
import { dateInZone, validTimeZone } from './reportTime.ts';

/** At most this many entries are named in a cell; the rest is "+N". */
export const MONTH_CELL_ENTRIES = 3;

// ---------- Months and the Mon–Sun grid ----------

export const validCalendarMonth = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) && validCalendarDate(`${value}-01`) &&
  Temporal.PlainYearMonth.from(value).toString() === value;
export const monthOf = (date: string) => date.slice(0, 7);
export const shiftMonth = (month: string, months: number) => Temporal.PlainYearMonth.from(month).add({ months }).toString();
export const monthFirst = (month: string) => `${month}-01`;
export const monthLast = (month: string) => Temporal.PlainYearMonth.from(month).toPlainDate({ day: 1 }).add({ months: 1 }).subtract({ days: 1 }).toString();

/** Weeks (Monday first) that cover the month: 4, 5 or 6 rows of 7 dates. */
export function monthGrid(month: string): string[][] {
  const first = Temporal.PlainDate.from(weekStartOf(monthFirst(month)));
  const last = monthLast(month);
  const weeks: string[][] = [];
  for (let start = first; start.toString() <= last; start = start.add({ days: 7 })) {
    weeks.push(Array.from({ length: 7 }, (_, index) => start.add({ days: index }).toString()));
  }
  return weeks;
}

/** "listopad 2026". */
export function monthLabel(month: string): string {
  const [year, value] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(year, value - 1, 1));
}

// ---------- Cells ----------

/** One entry named in a cell; pieces of one entry on that day (e.g. around sleep) are one item. */
export type MonthCellEntry = {
  entryId: number; title: string; path: string; colour: number; billable: boolean; running: boolean;
  /** 'work' when any piece of the day is work; otherwise the kind of its pieces (not counted). */
  kind: PieceKind;
  /** Work seconds of this entry on this day, as in the report (pending and unverified count 0). */
  seconds: number;
  /** "09:00–10:30" on the day's 24-hour axis; "23:50–24:00" for the first day of a midnight crossing. */
  range: string;
  startMinute: number;
};
export type MonthCell = {
  date: string; inMonth: boolean; isToday: boolean; seconds: number;
  entries: MonthCellEntry[]; shown: MonthCellEntry[]; more: number;
};
export type CalendarMonth = {
  month: string; from: string; through: string; zone: string; today: string;
  weeks: MonthCell[][]; monthSeconds: number;
  excludedEntryIds: number[]; missingRelations: boolean; overlapEntryIds: number[];
  pendingPeriodCount: number; pendingSeconds: number; unverifiedActive: boolean;
};

function cellEntries(blocks: readonly CalendarBlock[]): MonthCellEntry[] {
  const byEntry = new Map<number, CalendarBlock[]>();
  for (const block of blocks) byEntry.set(block.entryId, [...(byEntry.get(block.entryId) ?? []), block]);
  return [...byEntry.values()].map(pieces => {
    const ordered = [...pieces].sort((a, b) => a.startMinute - b.startMinute);
    const first = ordered[0], last = ordered[ordered.length - 1];
    const work = ordered.filter(piece => piece.kind === 'work');
    return {
      entryId: first.entryId, title: first.title, path: first.path, colour: first.colour, billable: first.billable,
      running: ordered.some(piece => piece.running), kind: work.length ? 'work' : first.kind,
      seconds: work.reduce((sum, piece) => sum + piece.seconds, 0),
      range: pieceRange({ startMinute: first.startMinute, endMinute: last.endMinute }), startMinute: first.startMinute,
    };
  }).sort((a, b) => a.startMinute - b.startMinute || a.entryId - b.entryId);
}

/**
 * The month view model for `month` (YYYY-MM). Inputs are the week's: the all-clients report data, the
 * catalogue, filters, `now` (live timer) and the snapshot's running entry. Returns null for an invalid
 * zone or month.
 */
export function calendarMonth(input: {
  data: CalendarReportData; catalog: ReportCatalog; filter: CalendarFilter; month: string; now: number;
  snapshotActive: CalendarClockEntry | null; snapshotFresh: boolean;
}): CalendarMonth | null {
  const { data, catalog, filter, month, now, snapshotActive, snapshotFresh } = input;
  if (!validTimeZone(data.time_zone) || !validCalendarMonth(month)) return null;
  const from = monthFirst(month), through = monthLast(month);
  const weeks: MonthCell[][] = [];
  let today = '';
  let unverifiedActive = false;
  for (const dates of monthGrid(month)) {
    const week = calendarWeek({ data, catalog, filter, weekStart: dates[0], now, snapshotActive, snapshotFresh });
    if (!week) return null;
    today = week.today;
    // A timer to verify is drawn in the grid; it matters for the month when one of its days is in the month.
    if (week.unverifiedActive && week.days.some(day => day.date >= from && day.date <= through && day.blocks.some(block => block.kind === 'unverified'))) unverifiedActive = true;
    weeks.push(week.days.map(day => {
      const entries = cellEntries(day.blocks);
      return {
        date: day.date, inMonth: day.date >= from && day.date <= through, isToday: day.isToday, seconds: day.seconds,
        entries, shown: entries.slice(0, MONTH_CELL_ENTRIES), more: Math.max(0, entries.length - MONTH_CELL_ENTRIES),
      };
    }));
  }
  const monthSeconds = weeks.flat().filter(cell => cell.inMonth).reduce((sum, cell) => sum + cell.seconds, 0);
  // Warnings for the month as a whole, from one report over the month (a period across a week boundary
  // is one period, not two). Same data as the cells: calendarData is what calendarWeek counts.
  const view = makeReportView(calendarData(data, filter, snapshotActive), catalog, filter.scope, from, through);
  return {
    month, from, through, zone: data.time_zone, today, weeks, monthSeconds,
    excludedEntryIds: view.excludedEntryIds, missingRelations: view.missingRelations, overlapEntryIds: view.overlaps.entryIds,
    pendingPeriodCount: view.pendingPeriodCount, pendingSeconds: view.pendingSeconds, unverifiedActive,
  };
}

// ---------- Live clock without recounting the month every second ----------

type MonthInput = Parameters<typeof calendarMonth>[0];

/**
 * Whether the running timer is counted live (DEV-29): only then do totals change with the clock. Same
 * conditions as calendarWeek's live extension; when false, `calendarMonth` does not depend on `now`
 * beyond the current date.
 */
export function monthIsLive(input: Pick<MonthInput, 'data' | 'snapshotActive' | 'snapshotFresh'>): boolean {
  const { data, snapshotActive, snapshotFresh } = input;
  return !!snapshotFresh && !!snapshotActive && !snapshotActive.recovered && !snapshotActive.uncertain &&
    !!data.active && !data.active.unresolved && data.active.ended_at !== null && String(data.active.id) === String(snapshotActive.id);
}

/**
 * The month for the current second from a `base` month computed once without the live clock
 * (`calendarMonth` with `snapshotFresh: false`, memoised by data, filters, month, today's date and the
 * running entry's state). Only the grid weeks the clock can change are counted again with
 * calendarWeek: with a live timer, every week from the report's read (its projection end) to today,
 * which differ right after Monday 00:00; with a timer to verify (drawn up to now, never counted), the
 * week of today. Other cells and the month warnings are reused, so the result equals `calendarMonth`
 * with the same input. Without a running timer the base is returned as is.
 */
export function liveMonth(base: CalendarMonth | null, input: MonthInput): CalendarMonth | null {
  if (!base) return null;
  const { data, catalog, filter, now, snapshotActive, snapshotFresh } = input;
  const live = monthIsLive(input);
  const unverified = !!snapshotActive?.recovered || !!snapshotActive?.uncertain || !!data.active?.unresolved;
  if (!live && !unverified) return base;
  const today = dateInZone(now, base.zone);
  const readEnd = live ? Date.parse(data.active!.ended_at!) : NaN;
  const first = Number.isFinite(readEnd) ? [dateInZone(readEnd, base.zone), today].sort()[0] : today;
  const touched = new Set<string>();
  for (let week = Temporal.PlainDate.from(weekStartOf(first)); week.toString() <= weekStartOf(today); week = week.add({ days: 7 })) touched.add(week.toString());
  let changed = false;
  const weeks = base.weeks.map(cells => {
    if (!touched.has(cells[0].date)) return cells;
    const week = calendarWeek({ data, catalog, filter, weekStart: cells[0].date, now, snapshotActive, snapshotFresh });
    if (!week) return cells;
    changed = true;
    return week.days.map((day, index) => {
      const entries = cellEntries(day.blocks);
      return { ...cells[index], isToday: day.isToday, seconds: day.seconds, entries,
        shown: entries.slice(0, MONTH_CELL_ENTRIES), more: Math.max(0, entries.length - MONTH_CELL_ENTRIES) };
    });
  });
  if (!changed) return base;
  const monthSeconds = weeks.flat().filter(cell => cell.inMonth).reduce((sum, cell) => sum + cell.seconds, 0);
  return { ...base, weeks, monthSeconds };
}

/** Moves the keyboard focus in the grid: ±1 day (left/right), ±7 days (up/down), week start/end (Home/End). */
export function moveDay(date: string, key: string): string | null {
  const day = Temporal.PlainDate.from(date);
  const next = key === 'ArrowLeft' ? day.subtract({ days: 1 }) : key === 'ArrowRight' ? day.add({ days: 1 })
    : key === 'ArrowUp' ? day.subtract({ days: 7 }) : key === 'ArrowDown' ? day.add({ days: 7 })
    : key === 'Home' ? day.subtract({ days: day.dayOfWeek - 1 }) : key === 'End' ? day.add({ days: 7 - day.dayOfWeek })
    : null;
  return next && validCalendarDate(next.toString()) ? next.toString() : null;
}

/** "HH:MM" of a day total (the grid); the exact seconds stay in the cell's label and the day details. */
export function hoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
