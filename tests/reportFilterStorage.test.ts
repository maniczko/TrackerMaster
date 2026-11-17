import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReportFilter, saveReportFilter, validReportFilter } from '../src/reportFilterStorage.ts';
import { reportPresetRange } from '../src/reportPresets.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

test('restores the relative filter, then resolves it using the new day and reporting zone', () => {
  const storage = memoryStorage();
  assert.equal(saveReportFilter(storage, { kind: 'today' }), true);
  const restored = readReportFilter(storage).filter;
  assert.deepEqual(restored, { kind: 'today' });
  if (!restored || restored.kind === 'custom') throw new Error('Relative filter was not restored');
  assert.deepEqual(reportPresetRange(restored.kind, Date.parse('2026-11-15T23:30:00Z'), 'Europe/Warsaw'), { from: '2026-11-16', through: '2026-11-16' });
  assert.deepEqual(reportPresetRange(restored.kind, Date.parse('2026-11-15T23:30:00Z'), 'Europe/London'), { from: '2026-11-15', through: '2026-11-15' });
});

test('restores exact custom dates and keeps the last valid selection on invalid edit', () => {
  const storage = memoryStorage();
  const custom = { kind: 'custom' as const, from: '2026-01-01', through: '2026-01-31' };
  assert.equal(saveReportFilter(storage, custom), true);
  assert.equal(saveReportFilter(storage, { kind: 'custom', from: '2026-02-30', through: '2026-03-01' }), false);
  assert.deepEqual(readReportFilter(storage), { filter: custom, problem: false });
  assert.equal(validReportFilter({ kind: 'custom', from: '2026-02-01', through: '2026-01-31' }), false);
});

test('missing, malformed and inaccessible storage cannot crash or write history', () => {
  const storage = memoryStorage();
  assert.deepEqual(readReportFilter(storage), { filter: null, problem: false });
  storage.setItem('report-date-filter-v1', '{broken');
  assert.deepEqual(readReportFilter(storage), { filter: null, problem: true });
  const unavailable = { getItem: () => { throw Error('unavailable'); }, setItem: () => { throw Error('unavailable'); } };
  assert.deepEqual(readReportFilter(unavailable), { filter: null, problem: true });
  assert.equal(saveReportFilter(unavailable, { kind: 'week' }), false);
});
