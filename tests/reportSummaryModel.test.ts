import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartScale, chartUnit, entryRelations, formatPercent, summaryChart, summaryGroups, summaryGroupsByProject, summaryKpis } from '../src/reportSummaryModel.ts';
import type { SummaryGroup } from '../src/reportSummaryModel.ts';
import { makeReportView } from '../src/reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from '../src/reportView.ts';
import { reportPresetRange } from '../src/reportPresets.ts';
import { allReportClients } from '../src/reportScope.ts';
import type { ReportScope } from '../src/reportScope.ts';
import { historyDays } from '../src/reportDayModel.ts';
import { clientLabels } from '../src/clientLabels.ts';
import { projectColour } from '../src/miniTimerModel.ts';

// Synthetic data only; reporting zone Europe/Warsaw. Fixture follows DEV-30 AC1: client A = 2 h, client B = 3 h.
const zone = 'Europe/Warsaw';
const H = 3600;
const catalog = {
  clients: [{ id: 1, name: 'Klient A' }, { id: 2, name: 'Klient B' }, { id: 3, name: 'Klient A' }],
  projects: [{ id: 10, client_id: 1, name: 'Strona' }, { id: 11, client_id: 1, name: 'Wsparcie' }, { id: 20, client_id: 2, name: 'Kampania' },
    { id: 30, client_id: 3, name: 'Strona' }],
  tasks: [{ id: 100, project_id: 10, name: 'Makiety' }, { id: 101, project_id: 10, name: 'Wdrożenie' }],
};
const labels = clientLabels(catalog.clients);
const entry = (id: number, project: number, start: string, end: string, extra: Partial<CompletedReportEntry> = {}): CompletedReportEntry => ({
  id, task_id: null, project_id: project, started_at: start, ended_at: end,
  duration_seconds: (Date.parse(end) - Date.parse(start)) / 1000, billable: false, description: `Wpis ${id}`, ...extra,
});
const data = (entries: CompletedReportEntry[], active: ActiveReportEntry | null = null) => ({ entries, active, time_zone: zone });
const view = (d: ReturnType<typeof data>, from: string, through: string, scope: ReportScope = allReportClients) =>
  makeReportView(d, catalog, scope, from, through);
const relations = (d: ReturnType<typeof data>) => entryRelations([...d.entries, ...(d.active ? [d.active] : [])]);
const sum = (groups: readonly SummaryGroup[]) => groups.reduce((total, group) => total + group.seconds, 0);

// Mon 16.11.2026 and Wed 18.11.2026 (Tue empty): A = 2 h (1.5 h billable), B = 3 h.
const fixture = [
  entry(1, 10, '2026-11-16T08:00:00Z', '2026-11-16T09:30:00Z', { task_id: 100, billable: true }),
  entry(2, 11, '2026-11-16T10:00:00Z', '2026-11-16T10:30:00Z'),
  entry(3, 20, '2026-11-18T08:00:00Z', '2026-11-18T11:00:00Z', { billable: true }),
];

test('KPI: total, billable, billable % and average over days with work (D12 variant B)', () => {
  const d = data(fixture);
  const v = view(d, '2026-11-16', '2026-11-18');
  const kpi = summaryKpis(v);
  assert.equal(kpi.totalSeconds, 5 * H);
  assert.equal(kpi.totalSeconds, v.finalizedSeconds, 'equals the report finalized sum');
  assert.equal(kpi.billableSeconds, 4.5 * H);
  assert.equal(kpi.billablePercent, 90);
  assert.equal(kpi.workDays, 2, 'Tuesday without work is not counted');
  assert.equal(kpi.averageSeconds, 2.5 * H);
  // Client A only (DEV-30 AC1): 2 h, nothing from B.
  const a = summaryKpis(view(d, '2026-11-16', '2026-11-18', { clientId: 1, projectId: null, taskId: null }));
  assert.deepEqual([a.totalSeconds, a.billableSeconds, a.workDays], [2 * H, 1.5 * H, 1]);
  assert.equal(formatPercent(a.billablePercent), '75%');
});

test('KPI: an empty period shows 0 time and "Brak danych", never NaN (DEV-30 AC3)', () => {
  const kpi = summaryKpis(view(data(fixture), '2026-11-17', '2026-11-17'));
  assert.deepEqual([kpi.totalSeconds, kpi.billableSeconds, kpi.billablePercent, kpi.averageSeconds, kpi.workDays], [0, 0, null, null, 0]);
  assert.equal(formatPercent(kpi.billablePercent), 'Brak danych');
  assert.equal(formatPercent(100 / 3), '33,3%');
});

test('KPI: the running projection and pending sleep never enter the final KPIs (D12-A)', () => {
  const pending = entry(4, 20, '2026-11-18T12:00:00Z', '2026-11-18T13:00:00Z', { duration_seconds: 2700, billable: true,
    sleep_periods: [{ id: 1, entryId: 4, startedMs: Date.parse('2026-11-18T12:30:00Z'), endedMs: Date.parse('2026-11-18T12:45:00Z'), decision: 'pending' }] });
  const active: ActiveReportEntry = { id: 9, task_id: null, project_id: 10, started_at: '2026-11-18T14:00:00Z', ended_at: '2026-11-18T14:45:00Z',
    duration_seconds: 2700, billable: true, description: '', unresolved: false };
  const d = data([...fixture, pending], active);
  const v = view(d, '2026-11-16', '2026-11-18');
  const kpi = summaryKpis(v);
  assert.equal(kpi.totalSeconds, 5 * H);
  assert.equal(kpi.billableSeconds, 4.5 * H);
  assert.equal(kpi.averageSeconds, 2.5 * H);
  assert.equal(kpi.activeSeconds, 2700, 'the running projection is reported separately');
  assert.equal(kpi.awaitingSeconds, 2700, 'work of the entry awaiting a sleep decision is separate');
  assert.equal(kpi.liveSeconds, 5 * H + 2700 + 2700);
  const groups = summaryGroups(v, relations(d), catalog, labels);
  assert.equal(sum(groups), 5 * H);
  const chart = summaryChart(v, relations(d), catalog, labels, '2026-11-16', '2026-11-18');
  assert.equal(chart.buckets.reduce((total, bucket) => total + bucket.seconds, 0), 5 * H);
  // An unresolved timer is never projected at all.
  const unresolved = view(data(fixture, { ...active, ended_at: null, duration_seconds: null, unresolved: true }), '2026-11-16', '2026-11-18');
  assert.equal(summaryKpis(unresolved).activeSeconds, 0);
});

test('groups: client → project → task sums are exact on every level (DEV-31 AC1)', () => {
  const d = data([...fixture, entry(5, 10, '2026-11-16T12:00:00Z', '2026-11-16T12:20:00Z', { task_id: 101 }),
    entry(6, 30, '2026-11-16T13:00:00Z', '2026-11-16T13:10:00Z')]);
  const v = view(d, '2026-11-16', '2026-11-18');
  const groups = summaryGroups(v, relations(d), catalog, labels);
  assert.equal(sum(groups), summaryKpis(v).totalSeconds);
  for (const client of groups) {
    assert.equal(sum(client.children), client.seconds, `${client.name}: projects add up`);
    for (const project of client.children) assert.equal(sum(project.children), project.seconds, `${project.name}: tasks add up`);
  }
  assert.deepEqual(groups.map(group => [group.name, group.seconds]), [['Klient B', 3 * H], ['ID 1 · Klient A', 2 * H + 1200], ['ID 3 · Klient A', 600]],
    'identical client names stay separate by ID, largest first');
  const a = groups[1];
  assert.deepEqual(a.children.map(group => [group.name, group.seconds]), [['Strona', 1.5 * H + 1200], ['Wsparcie', 1800]]);
  assert.deepEqual(a.children[0].children.map(group => [group.name, group.seconds]), [['Makiety', 1.5 * H], ['Wdrożenie', 1200]]);
  assert.deepEqual(a.children[1].children.map(group => group.name), ['Bez zadania']);
  assert.notEqual(groups[2].children[0].key, a.children[0].key, 'same project name of another client is a separate group');
});

test('groups: an entry without a known relation is shown as "Bez przypisania", not dropped', () => {
  const d = data(fixture);
  const v = view(d, '2026-11-16', '2026-11-18');
  const broken = new Map(relations(d));
  broken.delete(3);
  const groups = summaryGroups(v, broken, catalog, labels);
  assert.equal(sum(groups), 5 * H);
  assert.ok(groups.some(group => group.name === 'Bez przypisania' && group.seconds === 3 * H));
  assert.deepEqual(summaryGroups(view(data([]), '2026-11-16', '2026-11-18'), new Map(), catalog, labels), [], 'no data, no groups');
});

test('chart unit: up to 31 days by day, up to 53 weeks by week, otherwise by month', () => {
  assert.equal(chartUnit('2026-11-01', '2026-11-30'), 'day');
  assert.equal(chartUnit('2026-01-01', '2026-01-31'), 'day');
  assert.equal(chartUnit('2026-01-01', '2026-02-01'), 'week');
  assert.equal(chartUnit('2025-12-01', '2026-12-06'), 'week');
  assert.equal(chartUnit('2025-12-01', '2027-01-31'), 'month');
});

test('chart: one bucket per day with project segments in legend order and stable colours', () => {
  const d = data(fixture);
  const v = view(d, '2026-11-16', '2026-11-22');
  const chart = summaryChart(v, relations(d), catalog, labels, '2026-11-16', '2026-11-22');
  assert.equal(chart.unit, 'day');
  assert.deepEqual(chart.buckets.map(bucket => [bucket.from, bucket.seconds]),
    [['2026-11-16', 2 * H], ['2026-11-17', 0], ['2026-11-18', 3 * H], ['2026-11-19', 0], ['2026-11-20', 0], ['2026-11-21', 0], ['2026-11-22', 0]]);
  assert.equal(chart.maxSeconds, 3 * H);
  assert.deepEqual(chart.legend.map(item => [item.name, item.client, item.seconds]),
    [['Kampania', 'Klient B', 3 * H], ['Strona', 'ID 1 · Klient A', 1.5 * H], ['Wsparcie', 'ID 1 · Klient A', 1800]]);
  assert.deepEqual(chart.buckets[0].segments.map(segment => [segment.projectId, segment.seconds]), [['10', 1.5 * H], ['11', 1800]]);
  assert.equal(chart.buckets[0].segments[0].colour, projectColour(10));
  assert.equal(chart.buckets[0].longLabel, 'poniedziałek, 16 listopada 2026');
  // Each bucket equals the History day total (same reportByDay segmentation).
  const history = new Map(historyDays(d.entries, d, catalog, Date.parse('2026-11-22T12:00:00Z'))!.map(day => [day.date, day.seconds]));
  for (const bucket of chart.buckets) if (bucket.seconds) assert.equal(bucket.seconds, history.get(bucket.from), `History ${bucket.from}`);
});

test('chart: weeks start on Monday and are clipped to the period; months follow the calendar', () => {
  const d = data(fixture);
  const weeks = summaryChart(view(d, '2026-11-01', '2026-12-10'), relations(d), catalog, labels, '2026-11-01', '2026-12-10');
  assert.equal(weeks.unit, 'week');
  assert.deepEqual(weeks.buckets.map(bucket => [bucket.from, bucket.through]).slice(0, 3),
    [['2026-11-01', '2026-11-01'], ['2026-11-02', '2026-11-08'], ['2026-11-09', '2026-11-15']]);
  assert.deepEqual(weeks.buckets.at(-1)!.through, '2026-12-10');
  assert.equal(weeks.buckets.find(bucket => bucket.from === '2026-11-16')!.seconds, 5 * H);
  const months = summaryChart(view(d, '2025-12-01', '2027-01-31'), relations(d), catalog, labels, '2025-12-01', '2027-01-31');
  assert.equal(months.unit, 'month');
  assert.equal(months.buckets.length, 14);
  assert.equal(months.buckets.find(bucket => bucket.from === '2026-11-01')!.seconds, 5 * H);
  assert.equal(months.buckets.reduce((total, bucket) => total + bucket.seconds, 0), 5 * H);
});

test('midnight and DST: buckets split like the report, the 25-hour day counts real time', () => {
  // Sat 24.10 23:30 → Sun 25.10 01:30 Warsaw is 2 h; DST ends on 25.10 (25-hour day) — all real seconds.
  const night = entry(7, 10, '2026-10-24T21:30:00Z', '2026-10-24T23:30:00Z');
  const longDay = entry(8, 20, '2026-10-24T22:30:00Z', '2026-10-25T22:30:00Z');
  for (const d of [data([night]), data([longDay])]) {
    const v = view(d, '2026-10-24', '2026-10-25');
    const chart = summaryChart(v, relations(d), catalog, labels, '2026-10-24', '2026-10-25');
    assert.equal(chart.buckets.reduce((total, bucket) => total + bucket.seconds, 0), summaryKpis(v).totalSeconds);
    const reportDays = new Map(v.liveDays.map(day => [day.date, day.seconds]));
    assert.deepEqual(chart.buckets.map(bucket => bucket.seconds), chart.buckets.map(bucket => reportDays.get(bucket.from) ?? 0), 'each day equals the report day');
  }
  const nightChart = summaryChart(view(data([night]), '2026-10-24', '2026-10-25'), relations(data([night])), catalog, labels, '2026-10-24', '2026-10-25');
  assert.deepEqual(nightChart.buckets.map(bucket => bucket.seconds), [1800, 5400]);
  const dst = view(data([longDay]), '2026-10-25', '2026-10-25');
  assert.equal(summaryKpis(dst).totalSeconds, 24 * H, '25.10 00:30 CEST → 23:30 CET looks like 23 h on the clock but is 24 real hours (25-hour day)');
});

test('chart scale uses readable steps and never divides by zero', () => {
  assert.deepEqual(chartScale(0), { max: 900, step: 900 });
  assert.deepEqual(chartScale(50 * 60), { max: 3600, step: 900 });
  assert.deepEqual(chartScale(3 * H), { max: 3 * H, step: 3600 });
  assert.deepEqual(chartScale(7.5 * H), { max: 8 * H, step: 7200 });
  assert.ok(chartScale(400 * H).max >= 400 * H);
});

test('presets feed the summary: "Ten tydzień" equals the sum of its day buckets', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const range = reportPresetRange('week', now, zone);
  const d = data(fixture);
  const v = view(d, range.from, range.through);
  const chart = summaryChart(v, relations(d), catalog, labels, range.from, range.through);
  assert.equal(chart.buckets.length, 7);
  assert.equal(chart.buckets.reduce((total, bucket) => total + bucket.seconds, 0), summaryKpis(v).totalSeconds);
});

test('project-task grouping sums match the report total and keep unassigned entries visible', () => {
  const d = data([
    ...fixture,
    entry(9, 999, '2026-11-18T12:00:00Z', '2026-11-18T12:30:00Z', { taskId: null }),
  ]);
  const v = view(d, '2026-11-16', '2026-11-22');
  const byProject = summaryGroupsByProject(v, relations(d), catalog, labels);
  assert.equal(byProject.reduce((sum, item) => sum + item.seconds, 0), summaryKpis(v).totalSeconds);
  for (const project of byProject) {
    assert.equal(project.level, 'project');
    assert.equal(project.children.reduce((sum, task) => sum + task.seconds, 0), project.seconds);
  }
});
