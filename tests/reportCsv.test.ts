import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeExportRows, makeClientExportRows, exportCsv, spreadsheetText, formatDuration } from '../src/reportCsv.ts';

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

test('fails closed on duplicate or invalid IDs, preventing double-counting in CSV', () => {
  const dateFrom = '2026-01-01', dateTo = '2026-02-01', zone = 'UTC';
  assert.throws(() => makeExportRows([entry, { ...entry, duration_seconds: 3600 }], dateFrom, dateTo, zone), /powtórzony identyfikator/);
  assert.throws(() => makeExportRows([{ ...entry, id: 0 }], dateFrom, dateTo, zone), /identyfikator/);
  assert.throws(() => makeExportRows([{ ...entry, id: Number.NaN }], dateFrom, dateTo, zone), /identyfikator/);
  // A duplicate outside the selected period is also rejected, rather than
  // silently trusting a malformed response for this client's export.
  assert.throws(() => makeExportRows([entry, { ...entry, started_at: '2025-12-01T00:00:00Z', ended_at: '2025-12-01T01:00:00Z' }], dateFrom, dateTo, zone));
});

test('refuses to mix clients in the selected client CSV preview', () => {
  const other = { ...entry, id: 8, client: 'Inny klient' };
  assert.throws(() => makeClientExportRows([entry, other], 'Klient', '2026-01-01', '2026-02-01', 'UTC'), /innego klienta/);
  assert.throws(() => makeClientExportRows([entry], '', '2026-01-01', '2026-02-01', 'UTC'), /innego klienta/);
  assert.deepEqual(makeClientExportRows([entry], 'Klient', '2026-01-01', '2026-02-01', 'UTC'),
    makeExportRows([entry], '2026-01-01', '2026-02-01', 'UTC'));
  // No mutation of source records when rejecting the response.
  assert.equal(other.client, 'Inny klient');
});

test('does not export entries with pending sleep and preserves one row after a decision', () => {
  const start = Date.parse(entry.started_at);
  const sleep = { id:1, entryId:entry.id, startedMs:start+600000, endedMs:start+1200000, decision:'pending' as const };
  const pending = {...entry, duration_seconds:3000, sleep_periods:[sleep]};
  assert.deepEqual(makeExportRows([pending], '2026-01-01', '2026-02-01', 'UTC'), []);
  const completed = { ...entry, id: entry.id + 1 };
  const mixed = makeExportRows([pending, completed], '2026-01-01', '2026-02-01', 'UTC');
  assert.deepEqual(mixed.map(row => row.source.id), [completed.id]);
  assert.equal(mixed[0].contribution, 3600);
  const excluded = {...pending, sleep_periods:[{...sleep,decision:'excluded' as const}]};
  const rows = makeExportRows([excluded], '2026-01-01', '2026-02-01', 'UTC');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contribution, 3000);
  assert.equal(rows[0].source.id, entry.id);
});

test('a sleep fragment clipped at an early manual end counts the same in report and CSV', () => {
  // Rust periods_within_entry: entry 18:48–22:30, period 22:15–23:00 clipped to
  // 22:15–22:30, a later period omitted. Pending until decided, then CSV-ready.
  const ms = (value: string) => Date.parse(value);
  const base = { ...entry, id: 70, started_at: '2026-11-19T18:48:00Z', ended_at: '2026-11-19T22:30:00Z' };
  const clipped = { id: 4, entryId: 70, startedMs: ms('2026-11-19T22:15:00Z'), endedMs: ms('2026-11-19T22:30:00Z') };
  const pending = { ...base, duration_seconds: 13_320 - 900, sleep_periods: [{ ...clipped, decision: 'pending' as const }] };
  assert.deepEqual(makeExportRows([pending], '2026-11-19', '2026-11-19', 'UTC'), []);
  const included = { ...base, duration_seconds: 13_320, sleep_periods: [{ ...clipped, decision: 'included' as const }] };
  assert.equal(makeExportRows([included], '2026-11-19', '2026-11-19', 'UTC')[0].contribution, 13_320);
  const excluded = { ...base, duration_seconds: 13_320 - 900, sleep_periods: [{ ...clipped, decision: 'excluded' as const }] };
  assert.equal(makeExportRows([excluded], '2026-11-19', '2026-11-19', 'UTC')[0].contribution, 12_420);
  // An unclipped period reaching past the entry end is rejected, not counted.
  const unclipped = { ...pending, sleep_periods: [{ ...clipped, endedMs: ms('2026-11-19T23:00:00Z'), decision: 'excluded' as const }] };
  assert.throws(() => makeExportRows([unclipped], '2026-11-19', '2026-11-19', 'UTC'));
});
