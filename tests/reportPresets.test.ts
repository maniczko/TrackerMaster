import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportPresetRange } from '../src/reportPresets.ts';

test('relative periods follow the reporting zone at the same instant', () => {
  const instant = Date.parse('2026-11-15T23:30:00Z');
  assert.deepEqual(reportPresetRange('today', instant, 'Europe/Warsaw'), { from: '2026-11-16', through: '2026-11-16' });
  assert.deepEqual(reportPresetRange('today', instant, 'Europe/London'), { from: '2026-11-15', through: '2026-11-15' });
  assert.deepEqual(reportPresetRange('week', instant, 'Europe/Warsaw'), { from: '2026-11-16', through: '2026-11-22' });
  assert.deepEqual(reportPresetRange('week', instant, 'Europe/London'), { from: '2026-11-09', through: '2026-11-15' });
});

test('week boundaries cross years and daylight saving changes', () => {
  assert.deepEqual(reportPresetRange('week', Date.parse('2027-01-01T12:00:00Z'), 'Europe/Warsaw'), { from: '2026-12-28', through: '2027-01-03' });
  assert.deepEqual(reportPresetRange('week', Date.parse('2026-03-29T12:00:00Z'), 'Europe/Warsaw'), { from: '2026-03-23', through: '2026-03-29' });
});
