import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localInputRange, localRangeProblem, parseLocalDate, toLocalInputValue } from '../src/localDateTime.ts';

process.env.TZ = 'Europe/Warsaw';

test('rejects nonexistent and repeated local times on daylight saving changes', () => {
  assert.equal(parseLocalDate('2026-03-29T02:30:00'), null);
  assert.equal(parseLocalDate('2026-10-25T02:30:00'), null);
  assert.equal(parseLocalDate('2026-10-25T03:30:00')?.toISOString(), '2026-10-25T02:30:00.000Z');
  assert.equal(parseLocalDate('2026-03-29T03:30:00')?.toISOString(), '2026-03-29T01:30:00.000Z');
});

test('rejects malformed and calendar-invalid values without changing valid precision', () => {
  assert.equal(parseLocalDate('2026-02-30T10:00:00'), null);
  assert.equal(parseLocalDate('2026-11-15T25:00:00'), null);
  assert.equal(parseLocalDate(''), null);
  assert.equal(parseLocalDate('2026-11-15T10:30:47')?.toISOString(), '2026-11-15T09:30:47.000Z');
});

test('datetime-local values use the local wall clock, rounded down to a second, in winter and summer time', () => {
  assert.equal(toLocalInputValue(Date.parse('2026-11-21T08:05:09.987Z')), '2026-11-21T09:05:09');
  assert.equal(toLocalInputValue(Date.parse('2026-07-01T10:00:00.000Z')), '2026-07-01T12:00:00');
  // Not the UTC text that toISOString().slice would give.
  assert.notEqual(toLocalInputValue(Date.parse('2026-11-21T23:30:00Z')), '2026-11-21T23:30:00');
  assert.equal(toLocalInputValue(Date.parse('2026-11-21T23:30:00Z')), '2026-11-22T00:30:00');
});

test('min is the start rounded up to a second and max is now, also across daylight saving changes', () => {
  assert.deepEqual(localInputRange(Date.parse('2026-11-21T08:00:00.200Z'), Date.parse('2026-11-21T09:30:15.900Z')),
    { min: '2026-11-21T09:00:01', max: '2026-11-21T10:30:15' });
  assert.deepEqual(localInputRange(Date.parse('2026-11-21T08:00:00.000Z'), Date.parse('2026-11-21T08:00:00.000Z')),
    { min: '2026-11-21T09:00:00', max: '2026-11-21T09:00:00' });
  // Spring forward: 01:30 CET → 03:30 CEST (02:xx does not exist).
  assert.deepEqual(localInputRange(Date.parse('2026-03-29T00:30:00Z'), Date.parse('2026-03-29T01:30:00Z')),
    { min: '2026-03-29T01:30:00', max: '2026-03-29T03:30:00' });
  // Fall back: start 02:40 CEST is later on the wall clock than now 02:10 CET; min is dropped instead of blocking input.
  assert.deepEqual(localInputRange(Date.parse('2026-10-25T00:40:00Z'), Date.parse('2026-10-25T01:10:00Z')),
    { max: '2026-10-25T02:10:00' });
  assert.deepEqual(localInputRange(null, Date.parse('2026-11-21T08:00:00Z')), { max: '2026-11-21T09:00:00' });
  assert.deepEqual(localInputRange(Number.NaN, Date.parse('2026-11-21T08:00:00Z')), { max: '2026-11-21T09:00:00' });
});

test('range problems: empty, ambiguous or nonexistent, before the start and in the future', () => {
  const start = Date.parse('2026-11-21T08:00:00.500Z');
  const now = Date.parse('2026-11-21T09:00:00.000Z');
  assert.equal(localRangeProblem('', start, now), null);
  assert.equal(localRangeProblem('2026-11-21T09:30:00', start, now), null);
  assert.equal(localRangeProblem('2026-11-21T10:00:00', start, now), null, 'now itself is allowed');
  assert.equal(localRangeProblem('2026-11-21T10:00:01', start, now), 'after');
  assert.equal(localRangeProblem('2027-01-01T00:00:00', start, now), 'after');
  assert.equal(localRangeProblem('2026-11-21T09:00:00', start, now), 'before', 'the floored second is before a start with milliseconds');
  assert.equal(localRangeProblem('2026-11-21T09:00:01', start, now), null);
  assert.equal(localRangeProblem('2026-11-21T08:59:59', null, now), null, 'no start limit');
  assert.equal(localRangeProblem('2026-10-25T02:30:00', null, Date.parse('2026-10-26T00:00:00Z')), 'invalid', 'repeated hour');
  assert.equal(localRangeProblem('2026-03-29T02:30:00', null, Date.parse('2026-03-30T00:00:00Z')), 'invalid', 'missing hour');
  assert.equal(localRangeProblem('2026-02-30T10:00:00', null, now), 'invalid');
});
