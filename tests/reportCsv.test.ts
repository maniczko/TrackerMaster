import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeExportRows, exportCsv, spreadsheetText, formatDuration } from '../src/reportCsv.ts';

const entry = { id: 7, client: 'Klient', project: 'Projekt', task: '', description: 'Zażółć; "tekst"\nlinia', started_at: '2026-01-31T23:30:00Z', ended_at: '2026-02-01T00:30:00Z', duration_seconds: 3600, billable: true };

test('exports the same contribution as the report with local timestamp offsets', () => {
  const rows = makeExportRows([entry], '2026-01-01', '2026-01-31', 'Europe/London');
  assert.equal(rows[0].contribution, 1800);
  assert.equal(makeExportRows([entry], '2026-01-01', '2026-01-31', 'Europe/Warsaw').length, 0);
  const csv = exportCsv(rows, 'Europe/London');
  assert.ok(csv.startsWith('\ufeff"ID wpisu";'));
  assert.ok(csv.includes('"Zażółć; ""tekst""\nlinia"'));
  assert.ok(csv.includes('"2026-01-31T23:30:00+00:00"'));
  assert.ok(csv.includes('"3600";"01:00:00";"1800";"00:30:00"'));
  assert.equal(formatDuration(90000), '25:00:00');
});

test('escapes formula-like text without mutating original data', () => {
  for (const value of ['=1+1', '+1', '-1', '@SUM', '\t=1', '  =1', '\nhello']) assert.equal(spreadsheetText(value), `'${value}`);
  const risky = { ...entry, description: '=1+1' };
  assert.ok(exportCsv(makeExportRows([risky], '2026-01-01', '2026-02-01', 'UTC'), 'UTC').includes('"\'=1+1"'));
  assert.equal(risky.description, '=1+1');
});

test('refuses inconsistent records rather than silently exporting a partial report', () => {
  assert.throws(() => makeExportRows([{ ...entry, duration_seconds: 100 }], '2026-01-01', '2026-02-01', 'UTC'));
  const zero = { ...entry, started_at: '2026-02-01T01:00:00Z', ended_at: '2026-02-01T01:00:00Z', duration_seconds: 0 };
  assert.equal(makeExportRows([zero], '2026-02-01', '2026-02-01', 'UTC').length, 1);
});
