// DEV-27 / DEV-24 / DEV-29: the calendar's shared, pure segment selector. No I/O.
//
// Sums never come from this file: every day and week total is the report's own calculation
// (makeReportView → reportByDay, TECH-09 / D12), so the calendar equals the report for the same filters
// to the second. This file only adds what a calendar needs on top: where each piece of an entry sits
// on the 24-hour axis of its day in the reporting zone, its kind (work / sleep to decide / to verify)
// and a side-by-side layout for pieces that overlap.
import { Temporal } from '@js-temporal/polyfill';
import { addDaySeconds, dateInZone, validTimeZone } from './reportTime.ts';
import { splitSleepTime } from './sleepTime.ts';
import type { SleepPeriod } from './sleepTime.ts';
import { makeReportView } from './reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from './reportView.ts';
import type { ReportCatalog, ReportScope } from './reportScope.ts';
import { totalsBaseData } from './reportDayModel.ts';
import { projectColour } from './miniTimerModel.ts';

type Id = number | string;
export type CalendarReportData = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };
export type CalendarBillable = 'all' | 'billable' | 'nonbillable';
export type CalendarFilter = { scope: ReportScope; billable: CalendarBillable };
/** The main window snapshot's running entry (refreshed every 2.5 s), used for the live block. */
export type CalendarClockEntry = {
  id: Id; project_id: Id; task_id: Id | null; started_at: string; description: string; billable: boolean;
  recovered?: boolean; uncertain?: boolean;
};

export const DAY_MINUTES = 24 * 60;
/** Smallest block height on the axis (minutes), so a 1-minute entry stays visible and clickable. */
export const MIN_BLOCK_MINUTES = 24;
/** Smallest block height on screen (WCAG 2.5.8 target); the view converts it to minutes for its scale. */
export const MIN_BLOCK_PX = 24;

// ---------- Dates and weeks (reporting zone) ----------

export const dayStartMs = (date: string, zone: string) => Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: zone }).epochMilliseconds;
const nextDate = (date: string, days = 1) => Temporal.PlainDate.from(date).add({ days }).toString();
/** Monday of the week (Mon–Sun) that contains the date. */
export function weekStartOf(date: string): string {
  const day = Temporal.PlainDate.from(date);
  return day.subtract({ days: day.dayOfWeek - 1 }).toString();
}
export const shiftWeek = (start: string, weeks: number) => nextDate(weekStartOf(start), 7 * weeks);
export const weekDates = (start: string) => Array.from({ length: 7 }, (_, index) => nextDate(weekStartOf(start), index));
export const validCalendarDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-05') return false;
  try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; }
};

/** Wall-clock minute (0–1440) of an instant within its local day; the next midnight is 1440. */
function wallMinute(ms: number, date: string, zone: string): number {
  if (ms >= dayStartMs(nextDate(date), zone)) return DAY_MINUTES;
  const time = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
  return time.hour * 60 + time.minute + time.second / 60 + time.millisecond / 60_000;
}

// ---------- Pieces of one entry ----------

export type PieceKind = 'work' | 'pending' | 'unverified';
export type CalendarPiece = {
  entryId: number; date: string; startMs: number; endMs: number; kind: PieceKind;
  /** Seconds of this piece, floored like the report (work pieces add up to the report's day amount). */
  seconds: number;
  startMinute: number; endMinute: number;
};
type Span = { startedMs: number; endedMs: number; kind: PieceKind; anchor: number };

/** Cuts spans at local midnights of the reporting zone (23 h and 25 h days included). */
function cutAtMidnights(entryId: number, spans: readonly Span[], zone: string): CalendarPiece[] {
  const pieces: CalendarPiece[] = [];
  for (const span of spans) {
    let cursor = span.startedMs;
    while (cursor < span.endedMs) {
      const date = dateInZone(cursor, zone);
      const end = Math.min(span.endedMs, dayStartMs(nextDate(date), zone));
      const seconds = Math.floor((end - span.anchor) / 1000) - Math.floor((cursor - span.anchor) / 1000);
      const startMinute = wallMinute(cursor, date, zone);
      // A fall-back hour can make the wall clock run backwards inside a piece; keep the block ordered.
      const endMinute = Math.max(startMinute, wallMinute(end, date, zone));
      pieces.push({ entryId, date, startMs: cursor, endMs: end, kind: span.kind, seconds, startMinute, endMinute });
      cursor = end;
    }
  }
  return pieces;
}

/**
 * Pieces of an entry per local day: work, sleep still to decide ("pending", not counted) and, with
 * `unverified`, a timer that needs verification (not counted). Excluded sleep is a gap; included sleep is
 * work (D4). Elapsed time is anchored like reportByDay, so work seconds per day equal the report.
 */
export function entryPieces(entry: { id: number; startedMs: number; endedMs: number; sleep_periods?: readonly SleepPeriod[] },
  zone: string, unverified = false): CalendarPiece[] {
  if (!(entry.endedMs > entry.startedMs)) return [];
  if (unverified) return cutAtMidnights(entry.id, [{ startedMs: entry.startedMs, endedMs: entry.endedMs, kind: 'unverified', anchor: entry.startedMs }], zone);
  if (!entry.sleep_periods) return cutAtMidnights(entry.id, [{ startedMs: entry.startedMs, endedMs: entry.endedMs, kind: 'work', anchor: entry.startedMs }], zone);
  const split = splitSleepTime(entry.id, entry.startedMs, entry.endedMs, entry.sleep_periods);
  const spans: Span[] = [];
  let work = 0, pending = 0;
  for (const part of split.segments) {
    const length = part.endedMs - part.startedMs;
    // Contiguous pieces of one kind (e.g. included sleep followed by work) form one block; the anchor is unchanged.
    const last = spans[spans.length - 1];
    if (last && last.endedMs === part.startedMs && last.kind === part.kind) {
      last.endedMs = part.endedMs;
      if (part.kind === 'work') work += length; else if (part.kind === 'pending') pending += length;
      continue;
    }
    if (part.kind === 'work') { spans.push({ startedMs: part.startedMs, endedMs: part.endedMs, kind: 'work', anchor: part.startedMs - work }); work += length; }
    else if (part.kind === 'pending') { spans.push({ startedMs: part.startedMs, endedMs: part.endedMs, kind: 'pending', anchor: part.startedMs - pending }); pending += length; }
  }
  return cutAtMidnights(entry.id, spans, zone);
}

// ---------- Side-by-side layout ----------

export type Laid<T> = T & { top: number; bottom: number; lane: number; lanes: number };
/**
 * Places a day's blocks on the axis. Overlapping blocks (also legacy overlaps the backend now rejects)
 * share the width side by side. A block is at least `minMinutes` tall, and that visual height counts for
 * the overlap check, so short blocks never cover each other.
 */
export function layoutDay<T extends { startMinute: number; endMinute: number; entryId: number }>(items: readonly T[], minMinutes = MIN_BLOCK_MINUTES): Laid<T>[] {
  // Pieces of one entry that follow each other (work, sleep to decide, work) stay stacked: the minimum
  // height of a piece stops where the next piece of the same entry starts.
  const nextStart = (item: T) => Math.min(...items.filter(other => other !== item && other.entryId === item.entryId && other.startMinute >= item.endMinute).map(other => other.startMinute), Infinity);
  const sorted = items.map(item => {
    const top = Math.min(Math.max(0, item.startMinute), DAY_MINUTES - minMinutes);
    const bottom = Math.min(DAY_MINUTES, Math.max(item.endMinute, Math.min(top + minMinutes, nextStart(item))));
    return { ...item, top, bottom, lane: 0, lanes: 1 };
  }).sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.entryId - b.entryId);
  const result: Laid<T>[] = [];
  let cluster: Laid<T>[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => { for (const item of cluster) item.lanes = laneEnds.length; result.push(...cluster); cluster = []; laneEnds = []; };
  for (const item of sorted) {
    if (cluster.length && item.top >= clusterEnd) flush();
    let lane = laneEnds.findIndex(end => end <= item.top);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = item.bottom;
    item.lane = lane;
    cluster.push(item);
    clusterEnd = Math.max(cluster.length === 1 ? item.bottom : clusterEnd, item.bottom);
  }
  flush();
  return result;
}

// ---------- The week ----------

export type CalendarBlock = Laid<CalendarPiece> & {
  key: string; running: boolean; title: string; path: string; colour: number;
  billable: boolean; entryStartMs: number; entryEndMs: number | null; entrySeconds: number | null;
};
export type CalendarDay = { date: string; seconds: number; blocks: CalendarBlock[]; isToday: boolean };
export type CalendarWeek = {
  from: string; through: string; zone: string; today: string; days: CalendarDay[]; weekSeconds: number;
  /** Current wall-clock minute when today is in this week, otherwise null. */
  nowMinute: number | null;
  excludedEntryIds: number[]; missingRelations: boolean; overlapEntryIds: number[];
  pendingPeriodCount: number; pendingSeconds: number; awaitingSeconds: number; unverifiedActive: boolean;
};

const inScope = (scope: ReportScope, catalog: ReportCatalog, projectId: Id, taskId: Id | null) => {
  const project = catalog.projects.find(item => String(item.id) === String(projectId));
  return (scope.clientId === null || (!!project && Number(project.client_id) === scope.clientId)) &&
    (scope.projectId === null || Number(projectId) === scope.projectId) &&
    (scope.taskId === null || (taskId !== null && Number(taskId) === scope.taskId));
};
const billableMatch = (billable: CalendarBillable, value: boolean) => billable === 'all' || (billable === 'billable') === value;

/**
 * The week view model. `now` drives the live block and the "now" line. Day totals are the report's day
 * totals for the same filters (client, project, task via the report scope; billable by filtering entries
 * before the report runs). A resolved running timer counts like in the report, and only the time after
 * the report's projection is added while the fresh snapshot still shows it resolved (as the timer totals do).
 * A timer that needs verification is drawn but never counted. Returns null for an invalid zone or week.
 */
export function calendarWeek(input: {
  data: CalendarReportData; catalog: ReportCatalog; filter: CalendarFilter; weekStart: string; now: number;
  snapshotActive: CalendarClockEntry | null; snapshotFresh: boolean; minMinutes?: number;
}): CalendarWeek | null {
  const { catalog, filter, now, snapshotActive, snapshotFresh } = input;
  const zone = input.data.time_zone;
  if (!validTimeZone(zone) || !validCalendarDate(input.weekStart)) return null;
  const dates = weekDates(input.weekStart);
  const from = dates[0], through = dates[6];
  const clock = snapshotActive ? { id: snapshotActive.id, recovered: snapshotActive.recovered, uncertain: snapshotActive.uncertain } : null;
  const base = totalsBaseData(input.data, clock);
  const data: CalendarReportData = {
    ...base,
    entries: base.entries.filter(entry => billableMatch(filter.billable, entry.billable)),
    active: base.active && billableMatch(filter.billable, base.active.billable) ? base.active : null,
  };
  const view = makeReportView(data, catalog, filter.scope, from, through);
  const totals = addDaySeconds(new Map(), view.liveDays);
  const sources = new Map<string, CompletedReportEntry | ActiveReportEntry>();
  for (const entry of data.entries) sources.set(String(entry.id), entry);
  if (data.active) sources.set(String(data.active.id), data.active);
  const firstMs = dayStartMs(from, zone), afterMs = dayStartMs(nextDate(through), zone);

  type Raw = CalendarPiece & { running: boolean; source: { project_id: Id; task_id: Id | null; description: string; billable: boolean }; entryStartMs: number; entryEndMs: number | null; entrySeconds: number | null };
  const raw: Raw[] = [];
  const counted = view.active && !view.active.unresolved ? view.active : null;
  for (const contribution of view.contributions) {
    const source = sources.get(String(contribution.id));
    if (!source || source.ended_at === null) continue;
    const startedMs = Date.parse(source.started_at);
    let endedMs = Date.parse(source.ended_at);
    const running = !!counted && counted.id === contribution.id;
    // Live: draw and count the running timer up to now, beyond the report's projection, only while the
    // fresh snapshot shows the same resolved timer (same rule as the totals next to the timer).
    const live = running && snapshotFresh && !!snapshotActive && String(snapshotActive.id) === String(source.id) &&
      !snapshotActive.recovered && !snapshotActive.uncertain && now > endedMs;
    if (live) {
      for (const piece of entryPieces({ id: source.id, startedMs: endedMs, endedMs: now }, zone)) {
        if (piece.date >= from && piece.date <= through) totals.set(piece.date, (totals.get(piece.date) ?? 0) + piece.seconds);
      }
    }
    const projectionEnd = endedMs;
    if (live) endedMs = now;
    const pieces = entryPieces({ id: source.id, startedMs, endedMs: projectionEnd, sleep_periods: source.sleep_periods }, zone);
    if (live) pieces.push(...entryPieces({ id: source.id, startedMs: projectionEnd, endedMs }, zone));
    // The live extension continues the last work piece of that day: one block, not two.
    const merged: CalendarPiece[] = [];
    for (const piece of pieces) {
      const last = merged[merged.length - 1];
      if (last && last.date === piece.date && last.kind === piece.kind && last.endMs === piece.startMs) {
        merged[merged.length - 1] = { ...last, endMs: piece.endMs, endMinute: piece.endMinute, seconds: last.seconds + piece.seconds };
      } else merged.push(piece);
    }
    for (const piece of merged) {
      if (piece.date < from || piece.date > through) continue;
      raw.push({ ...piece, running, source, entryStartMs: startedMs, entryEndMs: running ? null : endedMs, entrySeconds: running ? null : source.duration_seconds });
    }
  }
  // A timer that needs verification (recovered, uncertain or unresolved in the report): drawn, not counted.
  const unverifiedSource = snapshotActive && (snapshotActive.recovered || snapshotActive.uncertain) ? snapshotActive
    : input.data.active?.unresolved ? input.data.active : null;
  let unverifiedActive = false;
  if (unverifiedSource && inScope(filter.scope, catalog, unverifiedSource.project_id, unverifiedSource.task_id) &&
      billableMatch(filter.billable, unverifiedSource.billable)) {
    const startedMs = Date.parse(unverifiedSource.started_at);
    const endedMs = Math.max(startedMs, Math.min(now, afterMs));
    if (Number.isFinite(startedMs) && endedMs > firstMs) {
      unverifiedActive = true;
      for (const piece of entryPieces({ id: Number(unverifiedSource.id), startedMs: Math.max(startedMs, firstMs), endedMs }, zone, true)) {
        if (piece.date < from || piece.date > through) continue;
        raw.push({ ...piece, running: true, source: unverifiedSource, entryStartMs: startedMs, entryEndMs: null, entrySeconds: null });
      }
    }
  }

  const today = dateInZone(now, zone);
  const minMinutes = input.minMinutes ?? MIN_BLOCK_MINUTES;
  const days = dates.map(date => {
    const pieces = raw.filter(piece => piece.date === date);
    const blocks = layoutDay(pieces, minMinutes).map((piece, index): CalendarBlock => {
      const project = catalog.projects.find(item => String(item.id) === String(piece.source.project_id));
      const client = project && catalog.clients.find(item => String(item.id) === String(project.client_id));
      const task = piece.source.task_id === null ? null : catalog.tasks.find(item => String(item.id) === String(piece.source.task_id));
      const description = piece.source.description.replace(/\s+/g, ' ').trim();
      const { source: _source, ...rest } = piece;
      return {
        ...rest, key: `${piece.entryId}:${piece.date}:${piece.kind}:${index}`,
        title: description || task?.name || project?.name || 'Bez opisu',
        path: [client?.name ?? 'Nieznany klient', project?.name ?? 'Nieznany projekt', ...(task ? [task.name] : [])].join(' / '),
        colour: projectColour(piece.source.project_id), billable: piece.source.billable,
      };
    });
    return { date, seconds: totals.get(date) ?? 0, blocks, isToday: date === today };
  });
  const nowMinute = today >= from && today <= through ? wallMinute(now, today, zone) : null;
  return {
    from, through, zone, today, days, weekSeconds: days.reduce((sum, day) => sum + day.seconds, 0), nowMinute,
    excludedEntryIds: view.excludedEntryIds, missingRelations: view.missingRelations, overlapEntryIds: view.overlaps.entryIds,
    pendingPeriodCount: view.pendingPeriodCount, pendingSeconds: view.pendingSeconds, awaitingSeconds: view.awaitingSeconds, unverifiedActive,
  };
}

/** "10:15" in the reporting zone. */
export function clockText(ms: number, zone: string): string {
  const time = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}
/** Axis-friendly label of a piece: "23:50–24:00" on the first day of an entry that crosses midnight. */
export function pieceRange(piece: { startMinute: number; endMinute: number }): string {
  const label = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(Math.floor(minute % 60)).padStart(2, '0')}`;
  return `${label(piece.startMinute)}–${label(piece.endMinute)}`;
}
/** "16–22 listopada 2026", "30 listopada – 6 grudnia 2026", "29 grudnia 2026 – 4 stycznia 2027". */
export function weekLabel(from: string, through: string): string {
  const a = Temporal.PlainDate.from(from), b = Temporal.PlainDate.from(through);
  const month = (date: Temporal.PlainDate) => new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(Date.UTC(date.year, date.month - 1, date.day)).replace(/^\d+\s/, '');
  if (a.year !== b.year) return `${a.day} ${month(a)} ${a.year} – ${b.day} ${month(b)} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${month(a)} – ${b.day} ${month(b)} ${b.year}`;
  return `${a.day}–${b.day} ${month(b)} ${b.year}`;
}
