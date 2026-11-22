import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyDays, shortDuration, timerTotals } from '../src/reportDayModel.ts';
import { makeReportView } from '../src/reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from '../src/reportView.ts';
import { reportPresetRange } from '../src/reportPresets.ts';
import { allReportClients } from '../src/reportScope.ts';

// Synthetic data only; reporting zone Europe/Warsaw.
const zone = 'Europe/Warsaw';
const catalog = {
  clients: [{ id: 1, name: 'Klient A' }, { id: 2, name: 'Klient B' }],
  projects: [{ id: 10, client_id: 1, name: 'Projekt A' }, { id: 20, client_id: 2, name: 'Projekt B' }],
  tasks: [],
};
const entry = (id: number, start: string, end: string, extra: Partial<CompletedReportEntry> = {}): CompletedReportEntry => ({
  id, task_id: null, project_id: id % 2 ? 10 : 20, started_at: start, ended_at: end,
  duration_seconds: (Date.parse(end) - Date.parse(start)) / 1000, billable: true, description: `Wpis ${id}`, ...extra,
});
const data = (entries: CompletedReportEntry[], active: ActiveReportEntry | null = null) => ({ entries, active, time_zone: zone });
const report = (d: ReturnType<typeof data>, now: number, preset: 'today' | 'week') => {
  const range = reportPresetRange(preset, now, zone);
  return makeReportView(d, catalog, allReportClients, range.from, range.through).liveSeconds;
};
const sameAsReport = (d: ReturnType<typeof data>, now: number) => {
  const totals = timerTotals(d, catalog, now)!;
  assert.equal(totals.todaySeconds, report(d, now, 'today'));
  assert.equal(totals.weekSeconds, report(d, now, 'week'));
  return totals;
};

test('short duration uses whole minutes', () => {
  assert.equal(shortDuration(0), '0 min');
  assert.equal(shortDuration(59), '0 min');
  assert.equal(shortDuration(45 * 60), '45 min');
  assert.equal(shortDuration(2 * 3600 + 15 * 60 + 59), '2 h 15 min');
  assert.equal(shortDuration(11 * 3600 + 40 * 60), '11 h 40 min');
  assert.equal(shortDuration(-5), '0 min');
});

test('totals next to the timer equal the report, with a resolved active timer only', () => {
  const now = Date.parse('2026-11-19T12:00:00Z'); // Thursday 13:00 in Warsaw
  const entries = [entry(1, '2026-11-19T07:00:00Z', '2026-11-19T08:15:00Z'), entry(2, '2026-11-17T09:00:00Z', '2026-11-17T19:25:00Z')];
  const active: ActiveReportEntry = { id: 9, task_id: null, project_id: 20, started_at: '2026-11-19T11:00:00Z', ended_at: '2026-11-19T12:00:00Z',
    duration_seconds: 3600, billable: false, description: '', unresolved: false };
  const totals = sameAsReport(data(entries, active), now);
  assert.equal(totals.text, 'Dziś 2 h 15 min · Tydzień 12 h 40 min');
  // An unresolved (uncertain/recovered) timer is not projected, exactly as in the report.
  const unresolved = sameAsReport(data(entries, { ...active, ended_at: null, duration_seconds: null, unresolved: true }), now);
  assert.equal(unresolved.todaySeconds, 75 * 60);
  assert.equal(unresolved.needsReview, true);
});

test('day and week boundaries: an entry over Sunday midnight is split between the weeks', () => {
  const now = Date.parse('2026-11-22T23:30:00Z'); // Monday 23.11 00:30 in Warsaw
  const crossing = entry(1, '2026-11-22T22:30:00Z', '2026-11-22T23:15:00Z'); // Sun 23:30 – Mon 00:15
  const totals = sameAsReport(data([crossing]), now);
  assert.deepEqual([totals.todaySeconds, totals.weekSeconds], [900, 900]);
  const sunday = Date.parse('2026-11-22T22:59:00Z'); // still Sunday 23:59
  assert.deepEqual([sameAsReport(data([crossing]), sunday).todaySeconds, sameAsReport(data([crossing]), sunday).weekSeconds], [1800, 1800]);
});

test('daylight saving change: the 25-hour day counts real elapsed time', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');
  const night = entry(1, '2026-10-24T22:00:00Z', '2026-10-25T03:00:00Z'); // 00:00 – 04:00 local, 5 h real
  const totals = sameAsReport(data([night]), now);
  assert.equal(totals.todaySeconds, 5 * 3600);
  const [day] = historyDays([night], data([night]), catalog, now)!;
  assert.deepEqual([day.date, day.label, day.seconds, day.rows[0].start, day.rows[0].end, day.rows[0].part], ['2026-10-25', 'Dziś', 18000, '00:00', '04:00', 'whole']);
});

test('sleep: excluded and pending periods follow the report', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  // The native source supplies work seconds without pending and excluded sleep.
  const excluded = entry(1, '2026-11-19T07:00:00Z', '2026-11-19T09:00:00Z', { duration_seconds: 5400,
    sleep_periods: [{ id: 1, entryId: 1, startedMs: Date.parse('2026-11-19T07:30:00Z'), endedMs: Date.parse('2026-11-19T08:00:00Z'), decision: 'excluded' }] });
  const pending = entry(3, '2026-11-19T09:30:00Z', '2026-11-19T10:30:00Z', { duration_seconds: 2700,
    sleep_periods: [{ id: 2, entryId: 3, startedMs: Date.parse('2026-11-19T10:00:00Z'), endedMs: Date.parse('2026-11-19T10:15:00Z'), decision: 'pending' }] });
  const d = data([excluded, pending]);
  const totals = sameAsReport(d, now);
  assert.equal(totals.needsReview, true);
  const [day] = historyDays([excluded, pending], d, catalog, now)!;
  assert.equal(day.seconds, totals.todaySeconds);
  assert.equal(day.rows.find(row => row.entry.id === 1)!.seconds, 90 * 60);
  assert.equal(day.rows.find(row => row.entry.id === 3)!.seconds, 45 * 60);
  assert.equal(day.rows.reduce((sum, row) => sum + (row.seconds ?? 0), 0), day.seconds);
});

test('History groups by day in the reporting zone; an entry over midnight is in both days', () => {
  const now = Date.parse('2026-11-20T09:00:00Z'); // Friday 10:00 in Warsaw
  const entries = [
    entry(1, '2026-11-20T07:15:00Z', '2026-11-20T07:45:00Z'),   // today 08:15–08:45
    entry(2, '2026-11-19T22:30:00Z', '2026-11-19T23:45:00Z'),   // Thu 23:30 – Fri 00:45
    entry(3, '2026-11-18T09:00:00Z', '2026-11-18T10:00:00Z'),   // Wednesday
    entry(5, '2026-11-18T11:00:00Z', '2026-11-18T11:00:01Z', { duration_seconds: 99 }), // inconsistent: report excludes it
  ];
  const d = data(entries);
  const days = historyDays(entries, d, catalog, now)!;
  assert.deepEqual(days.map(day => [day.date, day.label]), [['2026-11-20', 'Dziś'], ['2026-11-19', 'Wczoraj'], ['2026-11-18', 'Środa, 18 listopada']]);
  const [today, yesterday, wednesday] = days;
  assert.deepEqual(today.rows.map(row => [row.entry.id, row.part, row.start, row.end, row.seconds]), [[1, 'whole', '08:15', '08:45', 1800], [2, 'last', '00:00', '00:45', 2700]]);
  assert.deepEqual(yesterday.rows.map(row => [row.entry.id, row.part, row.start, row.end, row.seconds]), [[2, 'first', '23:30', '24:00', 1800]]);
  assert.equal(wednesday.rows.find(row => row.entry.id === 5)!.seconds, null);
  const view = makeReportView(d, catalog, allReportClients, '2026-11-18', '2026-11-20');
  for (const day of days) assert.equal(day.seconds, view.liveDays.find(item => item.date === day.date)?.seconds ?? 0, day.date);
  assert.deepEqual(historyDays(entries, { ...d, time_zone: 'Mars/Base' }, catalog, now), null);
  assert.deepEqual(historyDays([], d, catalog, now), []);
});

// Review of #53: one local date can have several report pieces (local and UTC midnight, DST, sleep).
// For every day: sum of the rows' "w tym dniu" == day header == report for that single date.
function daysMatchReport(entries: CompletedReportEntry[], now: number) {
  const d = data(entries);
  const days = historyDays(entries, d, catalog, now)!;
  for (const day of days) {
    const rows = day.rows.reduce((sum, row) => sum + (row.seconds ?? 0), 0);
    const single = makeReportView(d, catalog, allReportClients, day.date, day.date).liveSeconds;
    assert.equal(rows, day.seconds, `${day.date}: rows vs day total`);
    assert.equal(day.seconds, single, `${day.date}: day total vs report`);
  }
  return days;
}
const piece = (days: ReturnType<typeof daysMatchReport>, date: string, id = 1) => {
  const row = days.find(day => day.date === date)!.rows.find(item => item.entry.id === id)!;
  return [row.part, row.start, row.end, row.seconds];
};

test('owner case: Thu 23:00 → Fri 02:00 in Warsaw crosses local and UTC midnight', () => {
  const days = daysMatchReport([entry(1, '2026-11-19T22:00:00Z', '2026-11-20T01:00:00Z')], Date.parse('2026-11-20T09:00:00Z'));
  assert.deepEqual(piece(days, '2026-11-19'), ['first', '23:00', '24:00', 3600]);
  assert.deepEqual(piece(days, '2026-11-20'), ['last', '00:00', '02:00', 7200]);
});

test('an entry over two midnights is in three days with full report amounts', () => {
  const days = daysMatchReport([entry(1, '2026-11-19T21:00:00Z', '2026-11-21T00:00:00Z')], Date.parse('2026-11-21T09:00:00Z')); // Thu 22:00 → Sat 01:00
  assert.deepEqual(piece(days, '2026-11-19'), ['first', '22:00', '24:00', 7200]);
  assert.deepEqual(piece(days, '2026-11-20'), ['middle', '00:00', '24:00', 86400]);
  assert.deepEqual(piece(days, '2026-11-21'), ['last', '00:00', '01:00', 3600]);
});

test('daylight saving: March (23-hour day) and October (25-hour day) across midnight', () => {
  const march = daysMatchReport([entry(1, '2026-03-28T22:00:00Z', '2026-03-29T02:00:00Z')], Date.parse('2026-03-29T10:00:00Z')); // Sat 23:00 → Sun 04:00
  assert.deepEqual(piece(march, '2026-03-28'), ['first', '23:00', '24:00', 3600]);
  assert.deepEqual(piece(march, '2026-03-29'), ['last', '00:00', '04:00', 10800]);
  const october = daysMatchReport([entry(1, '2026-10-24T21:00:00Z', '2026-10-25T02:00:00Z')], Date.parse('2026-10-25T10:00:00Z')); // Sat 23:00 → Sun 03:00
  assert.deepEqual(piece(october, '2026-10-24'), ['first', '23:00', '24:00', 3600]);
  assert.deepEqual(piece(october, '2026-10-25'), ['last', '00:00', '03:00', 14400]);
});

test('sleep at the day boundary: each day counts only its work', () => {
  // Thu 23:00 → Fri 02:00 Warsaw, excluded sleep Thu 23:30 → Fri 00:30 (also across UTC midnight).
  const sleepy = entry(1, '2026-11-19T22:00:00Z', '2026-11-20T01:00:00Z', { duration_seconds: 7200,
    sleep_periods: [{ id: 1, entryId: 1, startedMs: Date.parse('2026-11-19T22:30:00Z'), endedMs: Date.parse('2026-11-19T23:30:00Z'), decision: 'excluded' }] });
  const days = daysMatchReport([sleepy], Date.parse('2026-11-20T09:00:00Z'));
  assert.deepEqual(piece(days, '2026-11-19'), ['first', '23:00', '24:00', 1800]);
  assert.deepEqual(piece(days, '2026-11-20'), ['last', '00:00', '02:00', 5400]);
});
