import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarWeek, entryPieces, layoutDay, pieceRange, shiftWeek, weekDates, weekLabel, weekStartOf, MIN_BLOCK_MINUTES } from '../src/calendarModel.ts';
import type { CalendarClockEntry, CalendarFilter, CalendarReportData } from '../src/calendarModel.ts';
import { reportByDay } from '../src/reportTime.ts';
import { makeReportView } from '../src/reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from '../src/reportView.ts';
import { allReportClients } from '../src/reportScope.ts';

// Synthetic data only (DEV-27 / DEV-24 / DEV-29). Reporting zone Europe/Warsaw unless stated.
const zone = 'Europe/Warsaw';
const catalog = {
  clients: [{ id: 1, name: 'Klient A' }, { id: 2, name: 'Klient B' }],
  projects: [{ id: 10, client_id: 1, name: 'Projekt A' }, { id: 20, client_id: 2, name: 'Projekt B' }],
  tasks: [{ id: 100, project_id: 10, name: 'Zadanie A' }],
};
const all: CalendarFilter = { scope: allReportClients, billable: 'all' };
const entry = (id: number, start: string, end: string, extra: Partial<CompletedReportEntry> = {}): CompletedReportEntry => ({
  id, task_id: null, project_id: 10, started_at: start, ended_at: end,
  duration_seconds: (Date.parse(end) - Date.parse(start)) / 1000, billable: true, description: `Wpis ${id}`, ...extra,
});
const week = (data: CalendarReportData, weekStart: string, now: number, extra: Partial<Parameters<typeof calendarWeek>[0]> = {}) =>
  calendarWeek({ data, catalog, filter: all, weekStart, now, snapshotActive: null, snapshotFresh: false, ...extra })!;
const report = (data: CalendarReportData, from: string, through: string, filter = all) =>
  makeReportView(data, catalog, filter.scope, from, through);

test('weeks are Monday–Sunday and move by seven days', () => {
  assert.equal(weekStartOf('2026-11-22'), '2026-11-16'); // Sunday
  assert.equal(weekStartOf('2026-11-16'), '2026-11-16');
  assert.deepEqual(weekDates('2026-11-19'), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
  assert.equal(shiftWeek('2026-11-16', -1), '2026-11-09');
  assert.equal(shiftWeek('2026-12-28', 1), '2027-01-04');
  assert.equal(weekLabel('2026-11-16', '2026-11-22'), '16–22 listopada 2026');
  assert.equal(weekLabel('2026-11-30', '2026-12-06'), '30 listopada – 6 grudnia 2026');
  assert.equal(weekLabel('2026-12-28', '2027-01-03'), '28 grudnia 2026 – 3 stycznia 2027');
});

test('23:50–00:10 is 600 s on each day, also across a month end; blocks match the report', () => {
  // 23:50 CET = 22:50 UTC.
  const data = { entries: [entry(1, '2026-11-30T22:50:00Z', '2026-11-30T23:10:00Z')], active: null, time_zone: zone };
  const pieces = entryPieces({ id: 1, startedMs: Date.parse('2026-11-30T22:50:00Z'), endedMs: Date.parse('2026-11-30T23:10:00Z') }, zone);
  assert.deepEqual(pieces.map(piece => [piece.date, piece.seconds, pieceRange(piece)]), [['2026-11-30', 600, '23:50–24:00'], ['2026-12-01', 600, '00:00–00:10']]);
  const view = week(data, '2026-11-30', Date.parse('2026-12-02T12:00:00Z'));
  assert.deepEqual(view.days.slice(0, 2).map(day => day.seconds), [600, 600]);
  assert.equal(view.weekSeconds, 1200);
  assert.equal(view.days[0].blocks.length, 1);
  assert.equal(view.days[1].blocks.length, 1);
  // Week boundary: the Monday half belongs to the next week, the Sunday half to this one.
  const sunday = { entries: [entry(2, '2026-11-29T22:50:00Z', '2026-11-29T23:10:00Z')], active: null, time_zone: zone };
  assert.equal(week(sunday, '2026-11-23', 0).weekSeconds, 600);
  assert.equal(week(sunday, '2026-11-30', 0).weekSeconds, 600);
  assert.equal(reportByDay(sunday.entries, '2026-11-23', '2026-11-29', zone).totalSeconds, 600);
});

test('DST days in Europe/Warsaw: 23 h on 29.03.2026 and 25 h on 25.10.2026', () => {
  // Whole-day entries: 00:00–24:00 local is 23 h and 25 h of real time.
  const spring = entry(1, '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z');
  const autumn = entry(2, '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z');
  const data = { entries: [spring, autumn], active: null, time_zone: zone };
  const march = week(data, '2026-03-23', 0);
  assert.equal(march.days[6].seconds, 23 * 3600);
  assert.deepEqual([march.days[6].blocks[0].startMinute, march.days[6].blocks[0].endMinute], [0, 1440]);
  const october = week(data, '2026-10-19', 0);
  assert.equal(october.days[6].seconds, 25 * 3600);
  for (const view of [march, october]) {
    assert.equal(view.weekSeconds, report(data, view.from, view.through).liveSeconds);
  }
  // 01:30–03:30 on the wall clock across the spring change is one real hour.
  const jump = entryPieces({ id: 3, startedMs: Date.parse('2026-03-29T00:30:00Z'), endedMs: Date.parse('2026-03-29T01:30:00Z') }, zone);
  assert.deepEqual(jump.map(piece => [piece.seconds, pieceRange(piece)]), [[3600, '01:30–03:30']]);
  // In the repeated autumn hour the axis never runs backwards.
  const repeat = entryPieces({ id: 4, startedMs: Date.parse('2026-10-25T00:30:00Z'), endedMs: Date.parse('2026-10-25T01:15:00Z') }, zone);
  assert.equal(repeat[0].seconds, 2700);
  assert.ok(repeat[0].endMinute >= repeat[0].startMinute);
});

test('day and week totals equal reportByDay for the same entries and filters', () => {
  const entries = [
    entry(1, '2026-11-16T07:00:00Z', '2026-11-16T09:30:00Z'),
    entry(2, '2026-11-17T22:30:00Z', '2026-11-18T01:15:00Z', { project_id: 20, billable: false }),
    entry(3, '2026-11-20T10:00:00Z', '2026-11-20T10:00:37Z', { task_id: 100 }),
    entry(4, '2026-11-22T21:00:00Z', '2026-11-23T03:00:00Z'), // into the next week
    entry(5, '2026-11-12T10:00:00Z', '2026-11-12T11:00:00Z'), // previous week
  ];
  const data = { entries, active: null, time_zone: zone };
  const plain = reportByDay(entries, '2026-11-16', '2026-11-22', zone);
  const view = week(data, '2026-11-16', Date.parse('2026-11-25T12:00:00Z'));
  assert.equal(view.weekSeconds, plain.totalSeconds);
  for (const day of view.days) assert.equal(day.seconds, plain.days.find(item => item.date === day.date)?.seconds ?? 0, day.date);
  // Work blocks add up to each day's total.
  for (const day of view.days) assert.equal(day.blocks.filter(block => block.kind === 'work').reduce((sum, block) => sum + block.seconds, 0), day.seconds, day.date);
  // Filters: client B only, and billable only, equal the report for the same filtered entries.
  const clientB: CalendarFilter = { scope: { clientId: 2, projectId: null, taskId: null }, billable: 'all' };
  assert.equal(calendarWeek({ data, catalog, filter: clientB, weekStart: '2026-11-16', now: 0, snapshotActive: null, snapshotFresh: false })!.weekSeconds,
    report(data, '2026-11-16', '2026-11-22', clientB).liveSeconds);
  const billable = calendarWeek({ data, catalog, filter: { scope: allReportClients, billable: 'billable' }, weekStart: '2026-11-16', now: 0, snapshotActive: null, snapshotFresh: false })!;
  assert.equal(billable.weekSeconds, reportByDay(entries.filter(item => item.billable), '2026-11-16', '2026-11-22', zone).totalSeconds);
  assert.ok(billable.days.every(day => day.blocks.every(block => block.billable)));
});

test('pending sleep is drawn but not counted; excluded sleep is a gap; included sleep is work', () => {
  const at = (time: string) => Date.parse(`2026-11-18T${time}:00Z`);
  const sleepy = entry(1, '2026-11-18T08:00:00Z', '2026-11-18T12:00:00Z', {
    duration_seconds: 4 * 3600 - 3600 - 1800, // the native source reports work without pending and excluded sleep
    sleep_periods: [
      { id: 1, entryId: 1, startedMs: at('09:00'), endedMs: at('10:00'), decision: 'pending' },
      { id: 2, entryId: 1, startedMs: at('10:30'), endedMs: at('11:00'), decision: 'excluded' },
      { id: 3, entryId: 1, startedMs: at('11:00'), endedMs: at('11:30'), decision: 'included' },
    ],
  });
  const data = { entries: [sleepy], active: null, time_zone: zone };
  const view = week(data, '2026-11-16', 0);
  const day = view.days[2];
  assert.equal(day.seconds, 9000);
  assert.equal(day.seconds, report(data, view.from, view.through).liveSeconds);
  assert.deepEqual(day.blocks.map(block => [block.kind, pieceRange(block)]), [
    ['work', '09:00–10:00'], ['pending', '10:00–11:00'], ['work', '11:00–11:30'], ['work', '12:00–13:00']]);
  assert.equal(day.blocks.filter(block => block.kind === 'work').reduce((sum, block) => sum + block.seconds, 0), day.seconds);
  // Pieces of one entry never sit side by side, even when a short piece gets the minimum height.
  assert.ok(day.blocks.every(block => block.lanes === 1));
  assert.equal(view.pendingPeriodCount, 1);
  assert.equal(view.pendingSeconds, 3600);
});

test('a resolved running timer is live; a timer to verify is drawn and never counted', () => {
  const start = '2026-11-19T08:00:00Z';
  const read = Date.parse('2026-11-19T09:00:00Z');
  const now = read + 30 * 60_000;
  const active: ActiveReportEntry = { id: 9, task_id: null, project_id: 20, started_at: start, ended_at: new Date(read).toISOString(),
    duration_seconds: 3600, billable: false, description: 'Na żywo', unresolved: false };
  const data = { entries: [entry(1, '2026-11-19T06:00:00Z', '2026-11-19T07:00:00Z')], active, time_zone: zone };
  const snapshot: CalendarClockEntry = { id: 9, project_id: 20, task_id: null, started_at: start, description: 'Na żywo', billable: false };
  // At the read instant the calendar equals the report exactly.
  const atRead = week(data, '2026-11-16', read, { snapshotActive: snapshot, snapshotFresh: true });
  assert.equal(atRead.weekSeconds, report(data, '2026-11-16', '2026-11-22').liveSeconds);
  // Later, with a fresh snapshot of the same resolved timer, the block and the day grow with the clock.
  const live = week(data, '2026-11-16', now, { snapshotActive: snapshot, snapshotFresh: true });
  assert.equal(live.days[3].seconds, 3600 + 3600 + 1800);
  const running = live.days[3].blocks.filter(block => block.running);
  assert.equal(Math.max(...running.map(block => block.endMinute)), 10 * 60 + 30); // 09:30 UTC = 10:30 in Warsaw
  assert.equal(live.nowMinute, 10 * 60 + 30);
  // Stale snapshot: no extension beyond the report.
  assert.equal(week(data, '2026-11-16', now, { snapshotActive: snapshot, snapshotFresh: false }).days[3].seconds, 7200);
  // The clock says "do weryfikacji": not counted, drawn as unverified up to now.
  const verify = week(data, '2026-11-16', now, { snapshotActive: { ...snapshot, recovered: true }, snapshotFresh: true });
  assert.equal(verify.days[3].seconds, 3600);
  assert.ok(verify.unverifiedActive);
  assert.deepEqual(verify.days[3].blocks.filter(block => block.kind === 'unverified').map(block => pieceRange(block)), ['09:00–10:30']);
  // Unresolved in the report: same rule.
  const unresolved = week({ ...data, active: { ...active, unresolved: true } }, '2026-11-16', now);
  assert.equal(unresolved.days[3].seconds, 3600);
  assert.ok(unresolved.unverifiedActive);
  // Another week: no "now" line.
  assert.equal(week(data, '2026-11-09', now).nowMinute, null);
});

test('overlapping blocks sit side by side; short blocks keep a minimum height without covering each other', () => {
  const block = (entryId: number, startMinute: number, endMinute: number) => ({ entryId, startMinute, endMinute });
  const laid = layoutDay([block(1, 600, 660), block(2, 630, 690), block(3, 700, 701), block(4, 705, 706), block(5, 900, 960)]);
  const byId = new Map(laid.map(item => [item.entryId, item]));
  assert.deepEqual([byId.get(1)!.lane, byId.get(1)!.lanes, byId.get(2)!.lane, byId.get(2)!.lanes], [0, 2, 1, 2]);
  // 1-minute entries are MIN_BLOCK_MINUTES tall and therefore placed next to each other.
  assert.equal(byId.get(3)!.bottom - byId.get(3)!.top, MIN_BLOCK_MINUTES);
  assert.deepEqual([byId.get(3)!.lanes, byId.get(4)!.lanes], [2, 2]);
  assert.notEqual(byId.get(3)!.lane, byId.get(4)!.lane);
  assert.deepEqual([byId.get(5)!.lane, byId.get(5)!.lanes], [0, 1]);
  // A block at the very end of the day stays inside the axis.
  const late = layoutDay([block(6, 1439, 1440)])[0];
  assert.deepEqual([late.top, late.bottom], [1440 - MIN_BLOCK_MINUTES, 1440]);
  // Legacy overlapping entries are drawn side by side in the week view too.
  const data = { entries: [entry(1, '2026-11-18T08:00:00Z', '2026-11-18T09:00:00Z'), entry(2, '2026-11-18T08:30:00Z', '2026-11-18T09:30:00Z')], active: null, time_zone: zone };
  const view = week(data, '2026-11-16', 0);
  assert.deepEqual(view.days[2].blocks.map(item => item.lanes), [2, 2]);
  assert.deepEqual(view.overlapEntryIds.sort(), [1, 2]);
});

test('invalid zone or week gives no view', () => {
  const data = { entries: [], active: null, time_zone: 'Nie/Strefa' };
  assert.equal(calendarWeek({ data, catalog, filter: all, weekStart: '2026-11-16', now: 0, snapshotActive: null, snapshotFresh: false }), null);
  assert.equal(calendarWeek({ data: { ...data, time_zone: zone }, catalog, filter: all, weekStart: '2026-02-30', now: 0, snapshotActive: null, snapshotFresh: false }), null);
});

// The fixed entries the Windows E2E creates (tests/windows-application.mjs, calendarFixture): the E2E checks
// the calendar UI against these figures, and here they are tied to the report's own calculation.
test('E2E fixture week: calendar figures are the report figures (midnight and DST, Europe/Warsaw)', () => {
  const entries = [
    entry(1, '2026-03-23T08:00:00Z', '2026-03-23T09:30:00Z'),
    entry(2, '2026-03-23T22:50:00Z', '2026-03-23T23:10:00Z'),
    entry(3, '2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z'),
  ];
  const data = { entries, active: null, time_zone: zone };
  const view = week(data, '2026-03-25', Date.parse('2026-11-23T12:00:00Z'));
  const plain = reportByDay(entries, '2026-03-23', '2026-03-29', zone);
  assert.deepEqual(view.days.map(day => day.seconds), [6000, 600, 0, 0, 0, 0, 3600]);
  assert.deepEqual(view.days.map(day => day.seconds), view.days.map(day => plain.days.find(item => item.date === day.date)?.seconds ?? 0));
  assert.equal(view.weekSeconds, 10200);
  assert.equal(view.weekSeconds, plain.totalSeconds);
  assert.equal(view.days.reduce((sum, day) => sum + day.blocks.length, 0), 4);
  assert.equal(weekLabel(view.from, view.through), '23–29 marca 2026');
  const next = weekDates(shiftWeek(view.from, 1));
  assert.equal(weekLabel(next[0], next[6]), '30 marca – 5 kwietnia 2026');
});

// Calendar styles use the Quiet Precision tokens only (UIQ-03/04), like app.css outside :root.
test('calendar.css has no raw colours, no own custom properties and token font sizes', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/calendar.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.doesNotMatch(css, /--[\w-]+\s*:/);
  for (const [, value] of css.matchAll(/font-size:\s*([^;]+);/g)) assert.match(value.trim(), /^var\(--text-(xs|sm|md|lg|xl)\)$/);
});
