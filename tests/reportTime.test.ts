import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportByWarsawDay, reportByDay, reportOverlaps, validTimeZone } from '../src/reportTime.ts';

const entry = (id: number, started_at: string, ended_at: string, duration_seconds: number) => ({ id, started_at, ended_at, duration_seconds });
const range = (entries: ReturnType<typeof entry>[], from = '2026-01-01', through = '2026-12-31') => reportByWarsawDay(entries, from, through);

test('splits a single source entry at Warsaw midnight and filters each month', () => {
  const data = [entry(1, '2026-01-31T22:50:00Z', '2026-01-31T23:10:00Z', 1200)];
  assert.deepEqual(range(data).days, [{ date: '2026-01-31', seconds: 600 }, { date: '2026-02-01', seconds: 600 }]);
  assert.equal(range(data, '2026-01-01', '2026-01-31').totalSeconds, 600);
  assert.equal(range(data, '2026-02-01', '2026-02-28').totalSeconds, 600);
});

test('counts real elapsed seconds on 23-hour and 25-hour DST days', () => {
  const spring = range([entry(1, '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23 * 3600)]);
  const autumn = range([entry(2, '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', 25 * 3600)]);
  assert.deepEqual(spring.days, [{ date: '2026-03-29', seconds: 23 * 3600 }]);
  assert.deepEqual(autumn.days, [{ date: '2026-10-25', seconds: 25 * 3600 }]);
});

test('preserves seconds at a fractional midnight boundary', () => {
  const data = [entry(1, '2026-01-01T22:59:59.500Z', '2026-01-01T23:00:01.500Z', 2)];
  assert.deepEqual(range(data).days, [{ date: '2026-01-02', seconds: 2 }]);
  assert.equal(range(data).totalSeconds, 2);
});

test('averages only days with recorded work, including weekends', () => {
  const data = [entry(1, '2026-01-02T09:00:00Z', '2026-01-02T17:00:00Z', 28800), entry(2, '2026-01-03T09:00:00Z', '2026-01-03T15:00:00Z', 21600)];
  const report = range(data);
  assert.equal(report.totalSeconds, 50400);
  assert.equal(report.averageSeconds, 25200);
  assert.equal(range([]).averageSeconds, null);
});

test('excludes inconsistent, malformed and timezone-free records', () => {
  const data = [entry(1, '2026-01-01T22:50:00Z', '2026-01-01T23:10:00Z', 1199), entry(2, 'bad', '2026-01-01T11:00:00Z', 0), entry(3, '2026-01-01T10:00:00', '2026-01-01T11:00:00', 3600)];
  assert.deepEqual(range(data).excludedEntryIds, [1, 2, 3]);
  assert.equal(range(data).totalSeconds, 0);
});

test('uses measured duration for small single-day clock differences and ignores other months', () => {
  const data = [entry(1, '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', 3599), entry(2, '2026-02-01T22:50:00Z', '2026-02-01T23:10:00Z', 1199)];
  const result = range(data, '2026-01-01', '2026-01-31');
  assert.equal(result.totalSeconds, 3599);
  assert.deepEqual(result.excludedEntryIds, []);
  assert.deepEqual(range(data, '2026-02-01', '2026-02-02').excludedEntryIds, [2]);
});

test('rejects invalid dates and duplicate source entries', () => {
  assert.throws(() => range([], '2026-02-30', '2026-03-01'));
  assert.throws(() => range([], '2026-03-01', '2026-02-28'));
  const e = entry(1, '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', 3600);
  assert.throws(() => range([e, e]));
});

test('changing the report zone changes day allocation without changing total duration', () => {
  const e = [entry(1, '2026-01-01T23:30:00Z', '2026-01-02T01:30:00Z', 7200)];
  assert.deepEqual(reportByDay(e, '2026-01-01', '2026-01-02', 'Europe/Warsaw').days, [{ date: '2026-01-02', seconds: 7200 }]);
  assert.deepEqual(reportByDay(e, '2026-01-01', '2026-01-02', 'Europe/London').days, [{ date: '2026-01-01', seconds: 1800 }, { date: '2026-01-02', seconds: 5400 }]);
  assert.ok(!validTimeZone('Not/A_Zone'));
  assert.throws(() => reportByDay(e, '2026-01-01', '2026-01-02', 'Not/A_Zone'));
});

test('handles a skipped local date without inventing time', () => {
  const e = [entry(1, '2011-12-30T09:30:00Z', '2011-12-30T10:30:00Z', 3600)];
  assert.deepEqual(reportByDay(e, '2011-12-29', '2011-12-31', 'Pacific/Apia').days, [{ date: '2011-12-29', seconds: 1800 }, { date: '2011-12-31', seconds: 1800 }]);
});

test('handles a clock rollback crossing midnight twice', () => {
  const e = [entry(1, '1988-10-30T01:20:00Z', '1988-10-30T04:00:00Z', 9600)];
  const result = reportByDay(e, '1988-10-29', '1988-10-30', 'America/St_Johns');
  assert.deepEqual(result.days, [{ date: '1988-10-29', seconds: 7740 }, { date: '1988-10-30', seconds: 1860 }]);
  assert.equal(result.totalSeconds, 9600);
});

test('warns about historical overlaps in the selected dates without changing the total', () => {
  const data = [entry(1, '2026-01-01T09:00:00Z', '2026-01-01T10:00:00Z', 3600), entry(2, '2026-01-01T09:30:00Z', '2026-01-01T10:30:00Z', 3600), entry(3, '2026-01-01T10:30:00Z', '2026-01-01T11:00:00Z', 1800)];
  assert.deepEqual(reportOverlaps(data, '2026-01-01', '2026-01-01', 'Europe/Warsaw'), { entryIds: [1, 2], truncated: false });
  assert.equal(reportByDay(data, '2026-01-01', '2026-01-01', 'Europe/Warsaw').totalSeconds, 9000);
  assert.deepEqual(reportOverlaps(data, '2026-01-02', '2026-01-02', 'Europe/Warsaw').entryIds, []);
});

test('overlap alert follows report zone and half-open intervals', () => {
  const data = [entry(1, '2026-01-01T23:20:00Z', '2026-01-01T23:50:00Z', 1800), entry(2, '2026-01-01T23:30:00Z', '2026-01-02T00:00:00Z', 1800), entry(3, '2026-01-02T00:00:00Z', '2026-01-02T00:10:00Z', 600)];
  assert.deepEqual(reportOverlaps(data, '2026-01-01', '2026-01-01', 'Europe/Warsaw').entryIds, []);
  assert.deepEqual(reportOverlaps(data, '2026-01-02', '2026-01-02', 'Europe/Warsaw').entryIds, [1, 2]);
  assert.deepEqual(reportOverlaps(data, '2026-01-01', '2026-01-01', 'Europe/London').entryIds, [1, 2]);
});

test('splits work and pending sleep by day without counting pending as work', () => {
  const start = Date.parse('2026-01-01T22:00:00Z');
  const sleep = { id:1, entryId:1, startedMs:start + 3600000, endedMs:start + 7200000, decision:'pending' as const };
  const e = {...entry(1, '2026-01-01T22:00:00Z', '2026-01-02T01:00:00Z', 7200), sleep_periods:[sleep]};
  const all = reportByDay([e], '2026-01-01', '2026-01-02', 'Europe/Warsaw');
  assert.deepEqual(all.days, [{date:'2026-01-01',seconds:3600},{date:'2026-01-02',seconds:3600}]);
  assert.equal(all.pendingSeconds, 3600);
  assert.equal(reportByDay([e], '2026-01-01', '2026-01-01', 'Europe/Warsaw').pendingSeconds, 0);
  assert.equal(reportByDay([e], '2026-01-02', '2026-01-02', 'Europe/Warsaw').pendingSeconds, 3600);
  const included = {...e, duration_seconds:10800, sleep_periods:[{...sleep,decision:'included' as const}]};
  assert.equal(reportByDay([included], '2026-01-01', '2026-01-02', 'Europe/Warsaw').totalSeconds, 10800);
});

test('carries fractional work across multiple segments, and rejects inconsistent durations', () => {
  const start = Date.parse('2026-01-01T12:00:00Z');
  const e = {...entry(1, new Date(start).toISOString(), new Date(start+1600).toISOString(), 1), sleep_periods:[{id:1,entryId:1,startedMs:start+600,endedMs:start+1000,decision:'excluded' as const}]};
  const valid = reportByDay([e], '2026-01-01', '2026-01-01', 'UTC');
  assert.equal(valid.totalSeconds, 1);
  assert.deepEqual(valid.excludedEntryIds, []);
  const invalid = reportByDay([{...e,duration_seconds:2}], '2026-01-01', '2026-01-01', 'UTC');
  assert.equal(invalid.totalSeconds, 0);
  assert.deepEqual(invalid.excludedEntryIds, [1]);
});
