import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSleepTime } from '../src/sleepTime.ts';
import type { SleepPeriod } from '../src/sleepTime.ts';
const hour = 3600000;
const period = (id: number, start: number, end: number | null, decision: SleepPeriod['decision'] = 'pending'): SleepPeriod => ({ id, entryId: 1, startedMs: start, endedMs: end, decision });

test('D4: one hour work and two hours pending; include or exclude by decision', () => {
  const entry = [1, 10*hour, 13*hour] as const;
  const pending = splitSleepTime(...entry, [period(7, 11*hour, 13*hour)]);
  assert.deepEqual([pending.workMs, pending.pendingMs, pending.excludedMs], [hour, 2*hour, 0]);
  const include = splitSleepTime(...entry, [period(7, 11*hour, 13*hour, 'included')]);
  assert.deepEqual([include.workMs, include.pendingMs], [3*hour, 0]);
  const exclude = splitSleepTime(...entry, [period(7, 11*hour, 13*hour, 'excluded')]);
  assert.deepEqual([exclude.workMs, exclude.excludedMs], [hour, 2*hour]);
});

test('multiple independent decisions and later work do not change other periods', () => {
  const p = [period(1, 10, 30, 'included'), period(2, 50, 90, 'excluded'), period(3, 100, 115)];
  const r = splitSleepTime(1, 0, 150, [...p].reverse());
  assert.deepEqual([r.workMs, r.pendingMs, r.excludedMs], [95, 15, 40]);
  assert.deepEqual(p.map(x => x.decision), ['included', 'excluded', 'pending']);
});

test('open sleep is conservatively pending through the observation boundary', () => {
  const r = splitSleepTime(1, 0, 100, [period(1, 40, null)]);
  assert.deepEqual([r.workMs, r.pendingMs, r.hasOpenSleep], [40, 60, true]);
  assert.throws(() => splitSleepTime(1, 0, 100, [period(1, 40, null, 'included')]));
});

test('refuses corrupt or mismatched data rather than inventing work', () => {
  for (const periods of [[period(1, 10, 40), period(2, 30, 50)], [period(1, 10, 20), period(1, 30, 40)], [period(1, 10, 101)], [{...period(1,10,20),entryId:2}], [period(1, 10, null), period(2, 20, 30)]]) {
    assert.throws(() => splitSleepTime(1, 0, 100, periods));
  }
});

test('elapsed duration remains correct over Warsaw DST rollback and subsecond boundaries', () => {
  const start = Date.parse('2026-10-25T00:00:00.500Z');
  const end = Date.parse('2026-10-25T02:00:00.250Z');
  const p = period(1, start + 1000, end - 250, 'pending');
  const r = splitSleepTime(1, start, end, [p]);
  assert.equal(r.workMs + r.pendingMs + r.excludedMs, end - start);
  assert.equal(r.workMs, 1250);
});

test('D4 short sleep: an automatically included period is work, counted once next to pending and excluded sleep', () => {
  const p = [period(1, 10, 20, 'auto_included'), period(2, 30, 60), period(3, 70, 80, 'excluded'), period(4, 90, 95, 'auto_included')];
  const split = splitSleepTime(1, 0, 100, p);
  assert.deepEqual({ work: split.workMs, pending: split.pendingMs, excluded: split.excludedMs }, { work: 60, pending: 30, excluded: 10 });
  assert.equal(split.workMs + split.pendingMs + split.excludedMs, 100, 'no second is counted twice or lost');
  assert.deepEqual(split.segments.filter(part => part.sleepId).map(part => [part.sleepId, part.kind]), [[1, 'work'], [2, 'pending'], [3, 'excluded'], [4, 'work']]);
  assert.throws(() => splitSleepTime(1, 0, 100, [period(1, 40, null, 'auto_included')]), /otwarte/);
});
