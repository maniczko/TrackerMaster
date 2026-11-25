// TECH-15: the day-boundary cache in reportTime lives for the whole process. These tests make sure that
// reusing it never changes a result (repeated calls, other zones in between, input order, subsets), and that
// the reuse actually happens (a repeated report over many days is much faster than the first one).
// Each node test file runs in its own process, so the cache starts empty here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportByDay, reportOverlaps } from '../src/reportTime.ts';
import type { ReportEntry } from '../src/reportTime.ts';

const entry = (id: number, started_at: string, ended_at: string): ReportEntry =>
  ({ id, started_at, ended_at, duration_seconds: Math.floor((Date.parse(ended_at) - Date.parse(started_at)) / 1000) });

// Hand-computed Warsaw expectations: midnight in winter, spring forward (29.03.2026) and fall back (25.10.2026).
const fixture = [
  entry(1, '2026-01-31T22:50:00.000Z', '2026-01-31T23:10:00.000Z'), // 23:50–00:10 CET
  entry(2, '2026-03-28T22:30:00.000Z', '2026-03-29T02:00:00.000Z'), // 23:30 CET – 04:00 CEST: 30 min + 3 h
  entry(3, '2026-10-24T21:30:00.000Z', '2026-10-25T02:00:00.000Z'), // 23:30 CEST – 03:00 CET: 30 min + 4 h
];
const expectedWarsaw = [
  { date: '2026-01-31', seconds: 600 }, { date: '2026-02-01', seconds: 600 },
  { date: '2026-03-28', seconds: 1800 }, { date: '2026-03-29', seconds: 10_800 },
  { date: '2026-10-24', seconds: 1800 }, { date: '2026-10-25', seconds: 14_400 },
];

test('repeated reports and other zones in between never change the Warsaw midnight and DST seconds', () => {
  const first = reportByDay(fixture, '2026-01-01', '2026-12-31', 'Europe/Warsaw');
  assert.deepEqual(first.days, expectedWarsaw);
  const london = reportByDay(fixture, '2026-01-01', '2026-12-31', 'Europe/London');
  const newYork = reportByDay(fixture, '2026-01-01', '2026-12-31', 'America/New_York');
  assert.equal(london.totalSeconds, first.totalSeconds);
  assert.equal(newYork.totalSeconds, first.totalSeconds);
  const again = reportByDay(fixture, '2026-01-01', '2026-12-31', 'Europe/Warsaw');
  assert.deepEqual(again, first);
  const reversed = reportByDay([...fixture].reverse(), '2026-01-01', '2026-12-31', 'Europe/Warsaw');
  assert.deepEqual(reversed.days, expectedWarsaw);
  assert.deepEqual(reportByDay(fixture, '2026-03-29', '2026-03-29', 'Europe/Warsaw').days, [{ date: '2026-03-29', seconds: 10_800 }]);
  // The result arrays are fresh objects; changing them does not reach the cache.
  again.days[0].seconds = 0;
  assert.deepEqual(reportByDay(fixture, '2026-01-01', '2026-12-31', 'Europe/Warsaw').days, expectedWarsaw);
});

// Deterministic spread of entries: one or two per day over about four years, some across midnight.
function spread(count: number, firstDayUtc: number): ReportEntry[] {
  const list: ReportEntry[] = [];
  let seed = 41;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  for (let i = 0; i < count; i++) {
    const start = firstDayUtc + i * 86_400_000 + Math.floor(next() * 23) * 3_600_000 + Math.floor(next() * 60) * 60_000;
    const end = start + (5 + Math.floor(next() * 180)) * 60_000;
    list.push(entry(i + 1, new Date(start).toISOString(), new Date(end).toISOString()));
  }
  return list;
}

test('a subset of entries gets exactly the per-entry contributions it has inside a larger report', () => {
  const entries = spread(1500, Date.UTC(2021, 0, 1));
  const full = reportByDay(entries, '2021-01-01', '2026-12-31', 'Europe/Warsaw');
  const byId = new Map(full.contributions.map(item => [item.id, item]));
  const subset = entries.filter(item => item.id % 7 === 3);
  const alone = reportByDay(subset, '2021-01-01', '2026-12-31', 'Europe/Warsaw');
  assert.deepEqual(alone.contributions, subset.map(item => byId.get(item.id)));
  assert.equal(alone.totalSeconds, subset.reduce((sum, item) => sum + (byId.get(item.id)?.seconds ?? 0), 0));
});

test('the cache is reused across calls: a repeated report over many days is far faster than the first', () => {
  // A zone no other test in this file uses, so its first report starts with an empty cache.
  const entries = spread(1500, Date.UTC(2015, 0, 1));
  const zone = 'America/Sao_Paulo';
  let t0 = performance.now();
  const first = reportByDay(entries, '2015-01-01', '2019-12-31', zone);
  const firstMs = performance.now() - t0;
  t0 = performance.now();
  const second = reportByDay(entries, '2015-01-01', '2019-12-31', zone);
  const secondMs = performance.now() - t0;
  assert.deepEqual(second, first);
  assert.ok(secondMs * 5 < firstMs, `expected the second report (${secondMs.toFixed(1)} ms) to be at least 5× faster than the first (${firstMs.toFixed(1)} ms)`);
  // Overlap detection uses the same cache and returns the same answer.
  assert.deepEqual(reportOverlaps(entries, '2015-01-01', '2019-12-31', zone), reportOverlaps(entries, '2015-01-01', '2019-12-31', zone));
});
