// Reports Summary (DEV-30/DEV-31): KPI tiles, the time chart and the client → project → task
// breakdown. Everything is derived from makeReportView (reportByDay segmentation, sleep, pending,
// active projection), so no second calculation can disagree with Detailed, CSV or History.
// Final KPIs count only finalized time (D12/TECH-10): the running projection and entries awaiting
// a sleep decision are shown separately and never enter totals, billable %, the average or groups.
import { Temporal } from '@js-temporal/polyfill';
import { projectColour } from './miniTimerModel.ts';
import type { makeReportView } from './reportView.ts';
import type { ReportCatalog } from './reportScope.ts';

type View = ReturnType<typeof makeReportView>;
type SummaryInput = Pick<View, 'rows' | 'contributions' | 'activeSeconds' | 'awaitingSeconds' | 'liveSeconds'>;
type Id = number | string;
/** Project and task of each report entry, from the same report data (ExportEntry carries only names). */
export type EntryRelations = ReadonlyMap<number, { projectId: Id; taskId: Id | null }>;
export function entryRelations(entries: readonly { id: number; project_id: Id; task_id: Id | null }[]): EntryRelations {
  return new Map(entries.map(entry => [entry.id, { projectId: entry.project_id, taskId: entry.task_id }]));
}
const UNASSIGNED = 'Bez przypisania';

export type SummaryKpis = {
  /** Finalized seconds in the period ("Łączny czas"). */
  totalSeconds: number;
  billableSeconds: number;
  /** billable / total × 100 on seconds; null when there is no finalized time ("Brak danych"). */
  billablePercent: number | null;
  /** D12 variant B: total / local days with finalized time > 0; null when there is none. */
  averageSeconds: number | null;
  workDays: number;
  /** Shown apart from the final KPIs (D12-A): the running projection and work awaiting a sleep decision. */
  activeSeconds: number;
  awaitingSeconds: number;
  liveSeconds: number;
};

function finalizedDays(view: SummaryInput) {
  const finalized = new Set(view.rows.filter(row => row.status === 'finalized').map(row => row.source.id));
  const byEntry = new Map(view.contributions.filter(item => finalized.has(item.id)).map(item => [item.id, item.days]));
  return { finalized, byEntry };
}

export function summaryKpis(view: SummaryInput): SummaryKpis {
  let totalSeconds = 0;
  let billableSeconds = 0;
  for (const row of view.rows) {
    if (row.status !== 'finalized') continue;
    totalSeconds += row.contribution;
    if (row.source.billable) billableSeconds += row.contribution;
  }
  const perDay = new Map<string, number>();
  for (const days of finalizedDays(view).byEntry.values()) {
    for (const day of days) if (day.seconds > 0) perDay.set(day.date, (perDay.get(day.date) ?? 0) + day.seconds);
  }
  const workDays = perDay.size;
  return {
    totalSeconds, billableSeconds,
    billablePercent: totalSeconds > 0 ? 100 * billableSeconds / totalSeconds : null,
    averageSeconds: workDays ? totalSeconds / workDays : null,
    workDays,
    activeSeconds: view.activeSeconds, awaitingSeconds: view.awaitingSeconds, liveSeconds: view.liveSeconds,
  };
}

/** "37,5%" — rounded only for display, after aggregation on seconds. */
export function formatPercent(value: number | null): string {
  return value === null ? 'Brak danych' : `${new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 }).format(value)}%`;
}

export type ChartUnit = 'day' | 'week' | 'month';
export type ChartSegment = { projectId: string; colour: number; seconds: number };
export type ChartBucket = { key: string; from: string; through: string; label: string; longLabel: string; seconds: number; segments: ChartSegment[] };
export type ChartLegendItem = { projectId: string; colour: number; name: string; client: string; seconds: number };
export type SummaryChart = { unit: ChartUnit; buckets: ChartBucket[]; legend: ChartLegendItem[]; maxSeconds: number };

/** Up to 31 days by day, up to 53 weeks by ISO week (Monday), longer periods by calendar month. */
export function chartUnit(from: string, through: string): ChartUnit {
  const days = Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(through)).days + 1;
  return days <= 31 ? 'day' : days <= 371 ? 'week' : 'month';
}

const dayFormat = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
const longDayFormat = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('pl-PL', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const longMonthFormat = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
// Plain calendar dates are formatted as UTC midnights so the label never shifts with a zone.
const asDate = (date: Temporal.PlainDate) => new Date(Date.UTC(date.year, date.month - 1, date.day));

function bucketStart(date: Temporal.PlainDate, unit: ChartUnit) {
  if (unit === 'week') return date.subtract({ days: date.dayOfWeek - 1 });
  if (unit === 'month') return date.with({ day: 1 });
  return date;
}

function bucketEnd(start: Temporal.PlainDate, unit: ChartUnit) {
  if (unit === 'week') return start.add({ days: 6 });
  if (unit === 'month') return start.add({ months: 1 }).subtract({ days: 1 });
  return start;
}

/** Empty buckets for every day/week/month of the period, clipped to [from, through]. */
function emptyBuckets(from: string, through: string, unit: ChartUnit): ChartBucket[] {
  const first = Temporal.PlainDate.from(from), last = Temporal.PlainDate.from(through);
  const buckets: ChartBucket[] = [];
  for (let start = bucketStart(first, unit); Temporal.PlainDate.compare(start, last) <= 0; start = bucketEnd(start, unit).add({ days: 1 })) {
    const lower = Temporal.PlainDate.compare(start, first) < 0 ? first : start;
    const end = bucketEnd(start, unit);
    const upper = Temporal.PlainDate.compare(end, last) > 0 ? last : end;
    const label = unit === 'month' ? monthFormat.format(asDate(start)) : dayFormat.format(asDate(lower));
    const longLabel = unit === 'day' ? longDayFormat.format(asDate(lower))
      : unit === 'month' ? longMonthFormat.format(asDate(start))
        : `${dayFormat.format(asDate(lower))}–${dayFormat.format(asDate(upper))}`;
    buckets.push({ key: lower.toString(), from: lower.toString(), through: upper.toString(), label, longLabel, seconds: 0, segments: [] });
  }
  return buckets;
}

/**
 * Finalized seconds per day/week/month, split by project. Each project keeps a stable decorative
 * colour slot (miniTimerModel.projectColour); its name is always given in the legend and tooltip.
 */
export function summaryChart(view: SummaryInput, relations: EntryRelations, catalog: ReportCatalog, clientLabelById: ReadonlyMap<string, string>, from: string, through: string): SummaryChart {
  const unit = chartUnit(from, through);
  const buckets = emptyBuckets(from, through, unit);
  const index = new Map<string, ChartBucket>();
  for (const bucket of buckets) {
    for (let day = Temporal.PlainDate.from(bucket.from); Temporal.PlainDate.compare(day, Temporal.PlainDate.from(bucket.through)) <= 0; day = day.add({ days: 1 })) {
      index.set(day.toString(), bucket);
    }
  }
  const { byEntry } = finalizedDays(view);
  const totals = new Map<string, number>();
  for (const row of view.rows) {
    if (row.status !== 'finalized') continue;
    const projectId = String(relations.get(row.source.id)?.projectId ?? 'unknown');
    for (const day of byEntry.get(row.source.id) ?? []) {
      const bucket = index.get(day.date);
      if (!bucket || day.seconds <= 0) continue;
      bucket.seconds += day.seconds;
      const segment = bucket.segments.find(item => item.projectId === projectId);
      if (segment) segment.seconds += day.seconds;
      else bucket.segments.push({ projectId, colour: projectColour(projectId), seconds: day.seconds });
      totals.set(projectId, (totals.get(projectId) ?? 0) + day.seconds);
    }
  }
  const projects = new Map(catalog.projects.map(project => [String(project.id), project]));
  const legend: ChartLegendItem[] = [...totals].map(([projectId, seconds]) => {
    const project = projects.get(projectId);
    return { projectId, colour: projectColour(projectId), seconds, name: project?.name ?? UNASSIGNED,
      client: project ? clientLabelById.get(String(project.client_id)) ?? UNASSIGNED : UNASSIGNED };
  }).sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name, 'pl') || a.projectId.localeCompare(b.projectId));
  const order = new Map(legend.map((item, position) => [item.projectId, position]));
  for (const bucket of buckets) bucket.segments.sort((a, b) => order.get(a.projectId)! - order.get(b.projectId)!);
  return { unit, buckets, legend, maxSeconds: Math.max(0, ...buckets.map(bucket => bucket.seconds)) };
}

/** Axis maximum and tick step in seconds: whole hours (or 15/30 min for short totals). */
export function chartScale(maxSeconds: number): { max: number; step: number } {
  const steps = [900, 1800, 3600, 7200, 3 * 3600, 4 * 3600, 6 * 3600, 12 * 3600, 24 * 3600, 48 * 3600, 120 * 3600, 240 * 3600, 480 * 3600];
  const step = steps.find(value => value * 4 >= maxSeconds) ?? Math.ceil(maxSeconds / 4 / 3600) * 3600;
  return { max: Math.max(step, Math.ceil(maxSeconds / step) * step), step };
}

export type SummaryGroup = { key: string; level: 'client' | 'project' | 'task'; name: string; seconds: number; children: SummaryGroup[] };

/**
 * Client → project → task, with sums on every level. Groups are keyed by ID, so identical names stay
 * separate (labels come from clientLabels). Entries without a task get an explicit "Bez zadania" group.
 * makeReportView already drops entries with a broken relation and flags the report as incomplete;
 * anything still without a relation here is shown under an explicit "Bez przypisania" group, never dropped.
 */
export function summaryGroups(view: SummaryInput, relations: EntryRelations, catalog: ReportCatalog, clientLabelById: ReadonlyMap<string, string>): SummaryGroup[] {
  const projects = new Map(catalog.projects.map(project => [String(project.id), project]));
  const tasks = new Map(catalog.tasks.map(task => [String(task.id), task]));
  const clients = new Map<string, SummaryGroup>();
  const child = (parent: SummaryGroup, key: string, level: SummaryGroup['level'], name: string) => {
    let group = parent.children.find(item => item.key === key);
    if (!group) { group = { key, level, name, seconds: 0, children: [] }; parent.children.push(group); }
    return group;
  };
  for (const row of view.rows) {
    if (row.status !== 'finalized' || row.contribution <= 0) continue;
    const relation = relations.get(row.source.id);
    const projectId = relation ? String(relation.projectId) : 'unknown';
    const project = projects.get(projectId);
    const clientId = project ? String(project.client_id) : 'unknown';
    let client = clients.get(clientId);
    if (!client) {
      client = { key: `client:${clientId}`, level: 'client', name: project ? clientLabelById.get(clientId) ?? row.source.client : UNASSIGNED, seconds: 0, children: [] };
      clients.set(clientId, client);
    }
    const projectGroup = child(client, `project:${projectId}`, 'project', project?.name ?? UNASSIGNED);
    const taskId = relation?.taskId ?? null;
    const taskGroup = child(projectGroup, taskId === null ? `task:none:${projectId}` : `task:${taskId}`, 'task',
      taskId === null ? 'Bez zadania' : tasks.get(String(taskId))?.name ?? UNASSIGNED);
    for (const group of [client, projectGroup, taskGroup]) group.seconds += row.contribution;
  }
  const sort = (groups: SummaryGroup[]): SummaryGroup[] => groups
    .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name, 'pl') || a.key.localeCompare(b.key))
    .map(group => ({ ...group, children: sort(group.children) }));
  return sort([...clients.values()]);
}
