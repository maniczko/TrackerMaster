import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalDate } from '../src/localDateTime.ts';

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
