import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportGlance } from '../src/reportGlanceModel.ts';
import { makeReportView } from '../src/reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from '../src/reportView.ts';
import { reportPresetRange } from '../src/reportPresets.ts';
import { allReportClients } from '../src/reportScope.ts';

// Synthetic data only. "Now" is Thursday 19.11.2026 13:00 in Warsaw; the week is Mon 16 – Sun 22.
const now = Date.parse('2026-11-19T12:00:00Z');
const catalog = {
  clients: [{ id: 1, name: 'Klient A' }, { id: 2, name: 'Klient B' }],
  projects: [{ id: 10, client_id: 1, name: 'Projekt A' }, { id: 20, client_id: 2, name: 'Projekt B' }],
  tasks: [],
};
const entry = (id: number, project: number, start: string, end: string, billable: boolean, extra: Partial<CompletedReportEntry> = {}): CompletedReportEntry => ({
  id, task_id: null, project_id: project, started_at: start, ended_at: end,
  duration_seconds: (Date.parse(end) - Date.parse(start)) / 1000, billable, description: '', ...extra,
});
const base: CompletedReportEntry[] = [
  entry(1, 10, '2026-11-19T07:00:00Z', '2026-11-19T08:00:00Z', true),   // today, billable
  entry(2, 20, '2026-11-17T09:00:00Z', '2026-11-17T11:00:00Z', false),  // this week, other client
  entry(3, 10, '2026-11-13T09:00:00Z', '2026-11-13T10:00:00Z', true),   // previous week
];
const active: ActiveReportEntry = { id: 9, task_id: null, project_id: 20, started_at: '2026-11-19T11:00:00Z', ended_at: '2026-11-19T12:00:00Z',
  duration_seconds: 3600, billable: false, description: '', unresolved: false };

function reportFor(data: Parameters<typeof makeReportView>[0], preset: 'today' | 'week') {
  const range = reportPresetRange(preset, now, data.time_zone);
  return makeReportView(data, catalog, allReportClients, range.from, range.through);
}

test('card values are the report sums for all clients (today, this week, billable this week)', () => {
  const data = { entries: base, active, time_zone: 'Europe/Warsaw' };
  const glance = reportGlance(data, catalog, now)!;
  assert.deepEqual(glance, { todaySeconds: 7200, weekSeconds: 14400, billableWeekSeconds: 3600, needsReview: false });
  assert.equal(glance.todaySeconds, reportFor(data, 'today').liveSeconds);
  assert.equal(glance.weekSeconds, reportFor(data, 'week').liveSeconds);
  assert.equal(glance.billableWeekSeconds, reportFor(data, 'week').billableSeconds);
});

test('sleep to decide and an unresolved timer follow the report and are flagged for review', () => {
  const sleepy = entry(4, 10, '2026-11-19T08:30:00Z', '2026-11-19T09:30:00Z', true, {
    duration_seconds: 2700, // the native source reports work without pending and rejected sleep
    sleep_periods: [{ id: 1, entryId: 4, startedMs: Date.parse('2026-11-19T09:00:00Z'), endedMs: Date.parse('2026-11-19T09:15:00Z'), decision: 'pending' }],
  });
  const excluded = entry(5, 10, '2026-11-18T08:00:00Z', '2026-11-18T09:00:00Z', true, {
    duration_seconds: 2700,
    sleep_periods: [{ id: 2, entryId: 5, startedMs: Date.parse('2026-11-18T08:30:00Z'), endedMs: Date.parse('2026-11-18T08:45:00Z'), decision: 'excluded' }],
  });
  for (const data of [
    { entries: [...base, sleepy, excluded], active, time_zone: 'Europe/Warsaw' },
    { entries: [...base, sleepy, excluded], active: { ...active, unresolved: true }, time_zone: 'Europe/Warsaw' },
  ]) {
    const glance = reportGlance(data, catalog, now)!;
    const today = reportFor(data, 'today');
    const week = reportFor(data, 'week');
    assert.equal(glance.todaySeconds, today.liveSeconds);
    assert.equal(glance.weekSeconds, week.liveSeconds);
    assert.equal(glance.billableWeekSeconds, week.billableSeconds);
    assert.equal(glance.needsReview, true);
  }
  // The excluded quarter-hour is not work in the report, so it is not in the card either.
  const onlyExcluded = { entries: [excluded], active: null, time_zone: 'Europe/Warsaw' };
  assert.equal(reportGlance(onlyExcluded, catalog, now)!.weekSeconds, 2700);
});

test('the report zone decides the day, not the computer zone', () => {
  // 23:30 UTC on 18.11 is already 19.11 in Warsaw but still 18.11 in New York.
  const late = entry(6, 10, '2026-11-18T23:30:00Z', '2026-11-19T00:00:00Z', false);
  assert.equal(reportGlance({ entries: [late], active: null, time_zone: 'Europe/Warsaw' }, catalog, now)!.todaySeconds, 1800);
  assert.equal(reportGlance({ entries: [late], active: null, time_zone: 'America/New_York' }, catalog, now)!.todaySeconds, 0);
  assert.equal(reportGlance({ entries: [late], active: null, time_zone: 'Nie/Strefa' }, catalog, now), null);
});
