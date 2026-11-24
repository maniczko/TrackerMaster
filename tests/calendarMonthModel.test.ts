import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarWeek } from '../src/calendarModel.ts';
import type { CalendarClockEntry, CalendarFilter, CalendarReportData } from '../src/calendarModel.ts';
import { calendarMonth, hoursMinutes, liveMonth, monthGrid, monthIsLive, monthLabel, moveDay, shiftMonth, validCalendarMonth, MONTH_CELL_ENTRIES } from '../src/calendarMonthModel.ts';
import { reportByDay } from '../src/reportTime.ts';
import { makeReportView } from '../src/reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from '../src/reportView.ts';
import { allReportClients } from '../src/reportScope.ts';

// DEV-25 / PTT-46. Synthetic data only. Reporting zone Europe/Warsaw unless stated.
const zone = 'Europe/Warsaw';
const catalog = {
  clients: [{ id: 1, name: 'Klient A' }, { id: 2, name: 'Klient B' }],
  projects: [{ id: 10, client_id: 1, name: 'Projekt A' }, { id: 20, client_id: 2, name: 'Projekt B' }],
  tasks: [{ id: 100, project_id: 10, name: 'Zadanie A' }],
};
const all: CalendarFilter = { scope: allReportClients, billable: 'all' };
const entry = (id: number, start: string, end: string, extra: Partial<CompletedReportEntry> = {}): CompletedReportEntry => ({
  id, task_id: null, project_id: 10, started_at: start, ended_at: end,
  duration_seconds: Math.floor((Date.parse(end) - Date.parse(start)) / 1000), billable: true, description: `Wpis ${id}`, ...extra,
});
const month = (data: CalendarReportData, value: string, now = 0, extra: Partial<Parameters<typeof calendarMonth>[0]> = {}) =>
  calendarMonth({ data, catalog, filter: all, month: value, now, snapshotActive: null, snapshotFresh: false, ...extra })!;
const cells = (view: NonNullable<ReturnType<typeof calendarMonth>>) => view.weeks.flat();
const cell = (view: NonNullable<ReturnType<typeof calendarMonth>>, date: string) => cells(view).find(item => item.date === date)!;

test('the Mon–Sun grid has 4, 5 or 6 rows, February included', () => {
  const rows = (value: string) => monthGrid(value).length;
  assert.equal(rows('2027-02'), 4); // 1.02.2027 is a Monday, 28 days
  assert.equal(rows('2026-02'), 5); // starts on a Sunday, 28 days
  assert.equal(rows('2028-02'), 5); // leap year, 29 days
  assert.equal(rows('2026-12'), 5);
  assert.equal(rows('2026-11'), 6); // starts on a Sunday, 30 days
  assert.equal(rows('2026-08'), 6); // starts on a Saturday, 31 days
  for (const value of ['2026-02', '2026-11', '2027-02', '2028-02']) {
    const grid = monthGrid(value);
    assert.ok(grid.every(week => week.length === 7));
    // Every row starts on a Monday and the dates are continuous.
    const dates = grid.flat();
    for (let index = 1; index < dates.length; index++) assert.equal(Date.parse(dates[index]) - Date.parse(dates[index - 1]), 86_400_000);
    assert.equal(new Date(`${dates[0]}T12:00:00Z`).getUTCDay(), 1);
    assert.ok(dates.includes(`${value}-01`));
  }
  assert.deepEqual(monthGrid('2026-11')[0], ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(monthGrid('2028-02').flat().filter(date => date.startsWith('2028-02')).length, 29);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(monthLabel('2026-11'), 'listopad 2026');
  assert.ok(validCalendarMonth('2026-11') && !validCalendarMonth('2026-13') && !validCalendarMonth('2026-1') && !validCalendarMonth(null));
});

test('23:50–00:10 across a month end: 600 s in each month, no double count', () => {
  // 23:50 CET on 30.11 = 22:50 UTC.
  const data = { entries: [entry(1, '2026-11-30T22:50:00Z', '2026-11-30T23:10:00Z')], active: null, time_zone: zone };
  const november = month(data, '2026-11');
  const december = month(data, '2026-12');
  assert.equal(cell(november, '2026-11-30').seconds, 600);
  // The grid shows 1.12 as a neighbouring day with its own 600 s, but the November total keeps only 30.11.
  assert.equal(cell(november, '2026-12-01').inMonth, false);
  assert.equal(cell(november, '2026-12-01').seconds, 600);
  assert.equal(november.monthSeconds, 600);
  assert.equal(december.monthSeconds, 600);
  assert.equal(november.monthSeconds + december.monthSeconds, reportByDay(data.entries, '2026-11-01', '2026-12-31', zone).totalSeconds);
  assert.deepEqual(cell(november, '2026-11-30').entries.map(item => item.range), ['23:50–24:00']);
  assert.deepEqual(cell(december, '2026-12-01').entries.map(item => item.range), ['00:00–00:10']);
});

test('DST months: 23 h on 29.03.2026 and 25 h on 25.10.2026, equal to the report', () => {
  const spring = entry(1, '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z');
  const autumn = entry(2, '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z');
  const data = { entries: [spring, autumn], active: null, time_zone: zone };
  const march = month(data, '2026-03'), october = month(data, '2026-10');
  assert.equal(cell(march, '2026-03-29').seconds, 23 * 3600);
  assert.equal(cell(october, '2026-10-25').seconds, 25 * 3600);
  assert.equal(march.monthSeconds, reportByDay(data.entries, '2026-03-01', '2026-03-31', zone).totalSeconds);
  assert.equal(october.monthSeconds, reportByDay(data.entries, '2026-10-01', '2026-10-31', zone).totalSeconds);
});

test('cell and month totals equal the report with the same filters, to the second', () => {
  const entries = [
    entry(1, '2026-11-02T07:00:00Z', '2026-11-02T09:30:00Z'),
    entry(2, '2026-11-10T22:30:00Z', '2026-11-11T01:15:00Z', { project_id: 20, billable: false }),
    entry(3, '2026-11-20T10:00:00Z', '2026-11-20T10:00:37Z', { task_id: 100 }),
    entry(4, '2026-10-31T21:00:00Z', '2026-11-01T03:00:00Z'), // from the previous month
    entry(5, '2026-11-30T21:00:00.250Z', '2026-12-01T02:00:00.750Z'), // into the next month, with milliseconds
    entry(6, '2026-11-25T08:00:00Z', '2026-11-25T11:00:00Z', {
      duration_seconds: 7200, sleep_periods: [{ id: 1, entryId: 6, startedMs: Date.parse('2026-11-25T09:00:00Z'), endedMs: Date.parse('2026-11-25T10:00:00Z'), decision: 'pending' }],
    }),
  ];
  const data = { entries, active: null, time_zone: zone };
  const filters: CalendarFilter[] = [
    all,
    { scope: { ...allReportClients, clientId: 2 }, billable: 'all' },
    { scope: { clientId: 1, projectId: 10, taskId: 100 }, billable: 'all' },
    { scope: allReportClients, billable: 'billable' },
    { scope: allReportClients, billable: 'nonbillable' },
  ];
  for (const filter of filters) {
    const view = calendarMonth({ data, catalog, filter, month: '2026-11', now: Date.parse('2026-12-05T12:00:00Z'), snapshotActive: null, snapshotFresh: false })!;
    const filtered = { ...data, entries: data.entries.filter(item => filter.billable === 'all' || (filter.billable === 'billable') === item.billable) };
    const report = makeReportView(filtered, catalog, filter.scope, '2026-11-01', '2026-11-30');
    assert.equal(view.monthSeconds, report.liveSeconds, JSON.stringify(filter));
    for (const item of cells(view).filter(candidate => candidate.inMonth)) {
      assert.equal(item.seconds, report.liveDays.find(day => day.date === item.date)?.seconds ?? 0, `${JSON.stringify(filter)} ${item.date}`);
    }
  }
  // Pending sleep is never counted: 3 h wall time, 2 h work.
  const view = month(data, '2026-11');
  assert.equal(cell(view, '2026-11-25').seconds, 7200);
  assert.equal(view.pendingPeriodCount, 1);
  assert.equal(view.pendingSeconds, 3600);
  // An entry split around sleep is one item in its cell, with its work seconds only.
  assert.deepEqual(cell(view, '2026-11-25').entries.map(item => [item.entryId, item.seconds, item.range, item.kind]), [[6, 7200, '09:00–12:00', 'work']]);
  // Neighbouring days are drawn but not added to the month.
  assert.equal(cells(view).filter(item => !item.inMonth).reduce((sum, item) => sum + item.seconds, 0) > 0, true);
  assert.equal(view.monthSeconds, reportByDay(entries.filter(item => item.id !== 6), '2026-11-01', '2026-11-30', zone).totalSeconds + 7200);
});

test('each cell equals the week view of the same day', () => {
  const entries = [entry(1, '2026-11-16T07:00:00Z', '2026-11-16T09:30:00Z'), entry(2, '2026-11-22T21:00:00Z', '2026-11-23T03:00:00Z')];
  const data = { entries, active: null, time_zone: zone };
  const view = month(data, '2026-11', Date.parse('2026-11-25T12:00:00Z'));
  for (const week of view.weeks) {
    const same = calendarWeek({ data, catalog, filter: all, weekStart: week[0].date, now: Date.parse('2026-11-25T12:00:00Z'), snapshotActive: null, snapshotFresh: false })!;
    assert.deepEqual(week.map(item => item.seconds), same.days.map(day => day.seconds));
  }
});

test('the running timer is live in today’s cell; a timer to verify is shown and never counted', () => {
  const start = '2026-11-19T08:00:00Z';
  const read = Date.parse('2026-11-19T09:00:00Z');
  const now = read + 30 * 60_000;
  const active: ActiveReportEntry = { id: 9, task_id: null, project_id: 20, started_at: start, ended_at: new Date(read).toISOString(),
    duration_seconds: 3600, billable: false, description: 'Na żywo', unresolved: false };
  const data = { entries: [entry(1, '2026-11-19T06:00:00Z', '2026-11-19T07:00:00Z')], active, time_zone: zone };
  const snapshot: CalendarClockEntry = { id: 9, project_id: 20, task_id: null, started_at: start, description: 'Na żywo', billable: false };
  const atRead = month(data, '2026-11', read, { snapshotActive: snapshot, snapshotFresh: true });
  assert.equal(atRead.monthSeconds, makeReportView(data, catalog, allReportClients, '2026-11-01', '2026-11-30').liveSeconds);
  const live = month(data, '2026-11', now, { snapshotActive: snapshot, snapshotFresh: true });
  const today = cell(live, '2026-11-19');
  assert.ok(today.isToday);
  assert.equal(today.seconds, 3600 + 3600 + 1800);
  assert.equal(live.monthSeconds, 9000);
  assert.deepEqual(today.entries.map(item => [item.entryId, item.running]), [[1, false], [9, true]]);
  // A stale snapshot adds nothing beyond the report's projection.
  assert.equal(cell(month(data, '2026-11', now, { snapshotActive: snapshot, snapshotFresh: false }), '2026-11-19').seconds, 7200);
  // Recovered: drawn, flagged, not counted.
  const verify = month(data, '2026-11', now, { snapshotActive: { ...snapshot, recovered: true }, snapshotFresh: true });
  assert.equal(cell(verify, '2026-11-19').seconds, 3600);
  assert.ok(verify.unverifiedActive);
  assert.deepEqual(cell(verify, '2026-11-19').entries.map(item => [item.entryId, item.kind, item.seconds]), [[1, 'work', 3600], [9, 'unverified', 0]]);
});

test('at most three entries per cell and "+N" for the rest', () => {
  const entries = Array.from({ length: 5 }, (_, index) => entry(index + 1, `2026-11-18T0${index + 1}:00:00Z`, `2026-11-18T0${index + 1}:20:00Z`));
  const view = month({ entries, active: null, time_zone: zone }, '2026-11');
  const day = cell(view, '2026-11-18');
  assert.equal(MONTH_CELL_ENTRIES, 3);
  assert.deepEqual(day.shown.map(item => item.entryId), [1, 2, 3]);
  assert.equal(day.more, 2);
  assert.equal(day.entries.length, 5);
  assert.equal(day.seconds, 5 * 1200);
  assert.equal(cell(view, '2026-11-19').more, 0);
});

test('keyboard moves by day and week; HH:MM labels; invalid input', () => {
  assert.equal(moveDay('2026-11-30', 'ArrowRight'), '2026-12-01');
  assert.equal(moveDay('2026-11-01', 'ArrowLeft'), '2026-10-31');
  assert.equal(moveDay('2026-11-25', 'ArrowUp'), '2026-11-18');
  assert.equal(moveDay('2026-11-25', 'ArrowDown'), '2026-12-02');
  assert.equal(moveDay('2026-11-25', 'Home'), '2026-11-23');
  assert.equal(moveDay('2026-11-25', 'End'), '2026-11-29');
  assert.equal(moveDay('2026-11-25', 'Enter'), null);
  assert.equal(hoursMinutes(0), '00:00');
  assert.equal(hoursMinutes(3599), '00:59');
  assert.equal(hoursMinutes(25 * 3600 + 61), '25:01');
  const data = { entries: [], active: null, time_zone: zone };
  assert.equal(calendarMonth({ data, catalog, filter: all, month: '2026-13', now: 0, snapshotActive: null, snapshotFresh: false }), null);
  assert.equal(calendarMonth({ data: { ...data, time_zone: 'Mars/Base' }, catalog, filter: all, month: '2026-11', now: 0, snapshotActive: null, snapshotFresh: false }), null);
  const empty = month(data, '2026-11');
  assert.equal(empty.monthSeconds, 0);
  assert.ok(cells(empty).every(item => item.entries.length === 0 && item.more === 0));
});

test('E2E fixture month (tests/windows-application.mjs, calendar-month): figures are the report’s own', () => {
  const short = [0, 15, 30, 45, 60].map((minutes, index) => {
    const at = Date.parse('2025-10-15T07:00:00Z') + minutes * 60_000;
    return entry(10 + index, new Date(at).toISOString(), new Date(at + 600_000).toISOString());
  });
  const entries = [
    entry(1, '2025-09-30T21:50:00Z', '2025-09-30T22:10:00Z'),
    entry(2, '2025-10-01T08:00:00Z', '2025-10-01T09:30:00Z'),
    ...short,
    entry(3, '2025-10-25T23:00:00Z', '2025-10-26T01:00:00Z'),
    entry(4, '2025-10-31T22:50:00Z', '2025-10-31T23:10:00Z'),
  ];
  const data = { entries, active: null, time_zone: zone };
  const view = month(data, '2025-10');
  assert.equal(view.weeks.length, 5);
  assert.equal(view.monthSeconds, 16_800); // 04:40:00
  assert.equal(view.monthSeconds, reportByDay(entries, '2025-10-01', '2025-10-31', zone).totalSeconds);
  const expected: Record<string, string> = { '2025-09-30': '00:10', '2025-10-01': '01:40', '2025-10-15': '00:50', '2025-10-26': '02:00', '2025-10-31': '00:10', '2025-11-01': '00:10' };
  for (const [date, total] of Object.entries(expected)) assert.equal(hoursMinutes(cell(view, date).seconds), total, date);
  assert.equal(cell(view, '2025-10-01').seconds, 6000);
  assert.deepEqual([cell(view, '2025-09-30').inMonth, cell(view, '2025-11-01').inMonth], [false, false]);
  assert.deepEqual([cell(view, '2025-10-15').shown.length, cell(view, '2025-10-15').more], [3, 2]);
  // "Pokaż tydzień" for 15.10: the week view of 13–19.10.2025 has the same 00:50:00.
  assert.equal(calendarWeek({ data, catalog, filter: all, weekStart: '2025-10-13', now: 0, snapshotActive: null, snapshotFresh: false })!.weekSeconds, 3000);
});

// PR #65 review: the view counts the whole month only when data, filters, month or date change, and every
// second only the weeks the clock can change (liveMonth). The result must equal the full calculation.
const base = (data: CalendarReportData, value: string, now: number, snapshotActive: CalendarClockEntry | null) =>
  calendarMonth({ data, catalog, filter: all, month: value, now, snapshotActive, snapshotFresh: false });
const full = (data: CalendarReportData, value: string, now: number, snapshotActive: CalendarClockEntry | null, snapshotFresh = true) =>
  calendarMonth({ data, catalog, filter: all, month: value, now, snapshotActive, snapshotFresh });
const tick = (memo: ReturnType<typeof calendarMonth>, data: CalendarReportData, value: string, now: number, snapshotActive: CalendarClockEntry | null, snapshotFresh = true) =>
  liveMonth(memo, { data, catalog, filter: all, month: value, now, snapshotActive, snapshotFresh });

test('live ticks on a memoised month equal the full calculation, also across Monday 00:00', () => {
  const runningFrom = (start: string, read: string) => {
    const active: ActiveReportEntry = { id: 9, task_id: null, project_id: 20, started_at: start, ended_at: read,
      duration_seconds: Math.floor((Date.parse(read) - Date.parse(start)) / 1000), billable: false, description: 'Na żywo', unresolved: false };
    const data = { entries: [entry(1, '2026-11-02T06:00:00Z', '2026-11-02T07:00:00Z'), entry(2, '2026-11-29T20:00:00Z', '2026-11-29T21:00:00Z')], active, time_zone: zone };
    const snapshot: CalendarClockEntry = { id: 9, project_id: 20, task_id: null, started_at: start, description: 'Na żywo', billable: false };
    return { data, snapshot };
  };
  // Mid-week: read at 09:00, ticks up to 30 minutes later.
  const mid = runningFrom('2026-11-19T08:00:00Z', '2026-11-19T09:00:00.000Z');
  const memo = base(mid.data, '2026-11', Date.parse('2026-11-19T09:00:00Z'), mid.snapshot);
  for (const minutes of [0, 1, 7, 30]) {
    const now = Date.parse('2026-11-19T09:00:00Z') + minutes * 60_000 + 437;
    assert.deepEqual(tick(memo, mid.data, '2026-11', now, mid.snapshot), full(mid.data, '2026-11', now, mid.snapshot), `+${minutes} min`);
  }
  assert.ok(monthIsLive({ data: mid.data, snapshotActive: mid.snapshot, snapshotFresh: true }));
  // Sunday 29.11 23:59:30 local read, Monday 30.11 00:00:40 now: two weeks change, the month total too.
  const edge = runningFrom('2026-11-29T22:30:00Z', '2026-11-29T22:59:30.000Z');
  const now = Date.parse('2026-11-29T23:00:40Z');
  const memoEdge = base(edge.data, '2026-11', now, edge.snapshot);
  const live = tick(memoEdge, edge.data, '2026-11', now, edge.snapshot)!;
  assert.deepEqual(live, full(edge.data, '2026-11', now, edge.snapshot));
  assert.equal(live.weeks.flat().find(cell => cell.date === '2026-11-29')!.seconds, 3600 + 1800);
  assert.equal(live.weeks.flat().find(cell => cell.date === '2026-11-30')!.seconds, 40);
  // A stale snapshot or no timer: the memoised month is returned as is (no work per second).
  assert.equal(tick(memo, mid.data, '2026-11', Date.parse('2026-11-19T09:10:00Z'), mid.snapshot, false), memo);
  const idle = { entries: mid.data.entries, active: null, time_zone: zone };
  const idleMemo = base(idle, '2026-11', 0, null);
  assert.equal(tick(idleMemo, idle, '2026-11', Date.parse('2026-11-19T09:10:00Z'), null), idleMemo);
  // A timer to verify is drawn up to now in today's cell (range grows) and never counted.
  const verify = { ...mid.snapshot, recovered: true };
  const verifyMemo = base(mid.data, '2026-11', Date.parse('2026-11-19T09:00:00Z'), verify);
  const later = Date.parse('2026-11-19T10:30:00Z');
  assert.deepEqual(tick(verifyMemo, mid.data, '2026-11', later, verify), full(mid.data, '2026-11', later, verify));
  assert.equal(tick(verifyMemo, mid.data, '2026-11', later, verify)!.monthSeconds, verifyMemo!.monthSeconds);
});

test('performance: 5000 entries, the per-second tick counts only the live weeks', () => {
  // Synthetic history: about 7 entries per working day over two years, plus a running timer today.
  const entries: CompletedReportEntry[] = [];
  let id = 1;
  for (let day = Date.parse('2024-12-02T00:00:00Z'); entries.length < 5000; day += 86_400_000) {
    if ([0, 6].includes(new Date(day).getUTCDay())) continue;
    for (let slot = 0; slot < 7 && entries.length < 5000; slot++) {
      const start = day + (7 + slot) * 3_600_000;
      entries.push(entry(id++, new Date(start).toISOString(), new Date(start + 45 * 60_000).toISOString(), { project_id: slot % 2 ? 20 : 10, billable: slot % 3 !== 0 }));
    }
  }
  const last = Date.parse(entries[entries.length - 1].ended_at);
  const start = new Date(last + 3_600_000).toISOString();
  const read = last + 2 * 3_600_000;
  const active: ActiveReportEntry = { id: 99_999, task_id: null, project_id: 10, started_at: start, ended_at: new Date(read).toISOString(),
    duration_seconds: 3600, billable: true, description: 'Na żywo', unresolved: false };
  const data = { entries, active, time_zone: zone };
  const snapshot: CalendarClockEntry = { id: 99_999, project_id: 10, task_id: null, started_at: start, description: 'Na żywo', billable: true };
  const value = new Date(read).toISOString().slice(0, 7);
  const best = (run: () => unknown) => { let min = Infinity; for (let i = 0; i < 3; i++) { const t = performance.now(); run(); min = Math.min(min, performance.now() - t); } return min; };
  let memo = base(data, value, read, snapshot);
  const fullMs = best(() => { memo = base(data, value, read, snapshot); });
  const tickMs = best(() => tick(memo, data, value, read + 5_000, snapshot));
  console.log(`PERF calendar-month 5000 entries: full ${fullMs.toFixed(1)} ms, live tick ${tickMs.toFixed(1)} ms`);
  assert.deepEqual(tick(memo, data, value, read + 5_000, snapshot), full(data, value, read + 5_000, snapshot));
  // The tick counts 1 of 4–6 weeks; with timer noise it must still be well below a full count.
  assert.ok(tickMs < fullMs * 0.6, `live tick ${tickMs.toFixed(1)} ms is not cheaper than the full month ${fullMs.toFixed(1)} ms`);
});
