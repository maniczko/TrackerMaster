import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportByDay } from '../src/reportTime.ts';
import {
  exportCsv, formatDuration, makeExportRows, makeClientExportRows,
  localTimestamp, sameExportRows, spreadsheetText
} from '../src/reportCsv.ts';
import type { ExportEntry } from '../src/reportCsv.ts';
import { makeReportView, sortReportRows } from '../src/reportView.ts';
import { allReportClients, changeReportScope, resolveReportScope } from '../src/reportScope.ts';
import type { ActiveReportEntry, CompletedReportEntry } from '../src/reportView.ts';

// TECH-10: exercise production TypeScript functions. No private customer data.
// This parser is deliberately independent of the production CSV writer.
function parseSemicolonCsv(source: string): string[][] {
  const text = source.startsWith('\ufeff') ? source.slice(1) : source;
  const rows: string[][] = [];
  let current: string[] = [], field = '', inside = false, justClosed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inside) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inside = false; justClosed = true; }
      } else field += ch;
    } else if (ch === '"') {
      if (field || justClosed) throw new Error('Malformed CSV quoting');
      inside = true;
    } else if (ch === ';') {
      current.push(field); field = ''; justClosed = false;
    } else if (ch === '\r' && text[i + 1] === '\n') {
      current.push(field); rows.push(current); current = []; field = '';
      justClosed = false; i++;
    } else if (ch === '\n' || ch === '\r') {
      throw new Error('Unexpected newline outside CSV field');
    } else {
      if (justClosed) throw new Error('Unexpected character after CSV quote');
      field += ch;
    }
  }
  if (inside || current.length || field) throw new Error('CSV must end with CRLF');
  return rows;
}
const a1: ExportEntry = {
  id: 10, client: 'Alfa', project: 'Wspólny projekt', task: '',
  description: 'Zażółć gęślą jaźń; "tekst"\r\nDruga linia',
  started_at: '2026-01-31T23:30:00Z', ended_at: '2026-02-01T00:30:00Z',
  duration_seconds: 3600, billable: true
};
const a2: ExportEntry = {
  id: 11, client: 'Alfa', project: 'Wspólny projekt', task: 'Rozmowy',
  description: '=1+1',
  started_at: '2026-01-31T22:50:00Z', ended_at: '2026-01-31T23:10:00Z',
  duration_seconds: 1200, billable: false
};
const b1: ExportEntry = {
  id: 12, client: 'Beta-ZNACZNIK-B', project: 'Wspólny projekt',
  task: 'Tajne-ZNACZNIK-B', description: 'Opis-ZNACZNIK-B',
  started_at: '2026-01-31T22:50:00Z', ended_at: '2026-01-31T23:10:00Z',
  duration_seconds: 1200, billable: true
};
const reportSources = (rows: ExportEntry[]) => rows.map(
  ({ id, started_at, ended_at, duration_seconds }) => ({
    id, started_at, ended_at, duration_seconds
  })
);
const totalContribution = (rows: ReturnType<typeof makeExportRows>) =>
  rows.reduce((total, row) => total + row.contribution, 0);

test('TECH-10: Warsaw January and February Detailed contributions equal Calendar and CSV source rows', () => {
  const items = [a1, a2];
  for (const [from, through, expected, ids] of [
    ['2026-01-01', '2026-01-31', 600, [11]],
    ['2026-02-01', '2026-02-28', 4200, [10, 11]],
    ['2026-01-01', '2026-02-28', 4800, [10, 11]]
  ] as const) {
    const details = makeClientExportRows(items, 'Alfa', from, through, 'Europe/Warsaw');
    const calendar = reportByDay(reportSources(items), from, through, 'Europe/Warsaw');
    assert.equal(totalContribution(details), expected);
    assert.equal(calendar.totalSeconds, expected);
    assert.deepEqual(details.map(r => r.source.id), ids);
    const csv = parseSemicolonCsv(exportCsv(details, 'Europe/Warsaw'));
    assert.equal(csv.length - 1, ids.length);
    assert.equal(csv.slice(1).reduce((sum, row) => sum + Number(row[10]), 0), expected);
    assert.equal(csv.slice(1).reduce((sum, row) => sum + Number(row[8]), 0),
      details.reduce((sum, row) => sum + row.source.duration_seconds, 0));
  }
});
test('TECH-10: London January reports 1800+1200 seconds; source duration and UTC never change', () => {
  const items = [a1, a2];
  const rows = makeClientExportRows(items, 'Alfa', '2026-01-01', '2026-01-31', 'Europe/London');
  assert.deepEqual(rows.map(row => [row.source.id, row.contribution]), [[10, 1800], [11, 1200]]);
  assert.equal(reportByDay(reportSources(items), '2026-01-01', '2026-01-31', 'Europe/London').totalSeconds, 3000);
  assert.deepEqual(parseSemicolonCsv(exportCsv(rows, 'Europe/London')).slice(1).map(row => [row[0], row[10]]),
    [['10', '1800'], ['11', '1200']]);
  assert.equal(a1.started_at, '2026-01-31T23:30:00Z');
});
test('TECH-10: CSV uses the exact D12 header and every completed entry contributes one source row', () => {
  const csv = exportCsv(makeClientExportRows([a1, a2], 'Alfa', '2026-01-01', '2026-02-28', 'Europe/Warsaw'), 'Europe/Warsaw');
  assert.equal(csv.slice(0, csv.indexOf('\n') + 1),
    '\ufeff"ID wpisu";"Klient";"Projekt";"Zadanie";"Opis";"Start";"Koniec";"Rozliczalność";' +
    '"Czas całkowity w sekundach";"Czas całkowity HH:MM:SS";' +
    '"Czas w wybranym okresie w sekundach";"Czas w wybranym okresie HH:MM:SS"\r\n');
  const rows = parseSemicolonCsv(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(1).map(row => row[0]), ['10', '11']);
  assert.ok(rows.every(row => row.length === 12));
  assert.equal(rows[1][7], 'Tak');
  assert.equal(rows[2][7], 'Nie');
  assert.equal(rows[1][8], '3600');
  assert.equal(rows[2][8], '1200');
  assert.equal(rows[1][10], '3600');
  assert.equal(rows[2][10], '1200');
});
test('TECH-10: real CSV file preserves exact UTF-8 BOM bytes, semicolon, CRLF, Polish characters and quotes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trackermaster-tech10-'));
  const file = join(directory, 'two-sources.csv');
  try {
    const csv = exportCsv(makeClientExportRows([a1, a2], 'Alfa', '2026-01-01', '2026-02-28', 'Europe/Warsaw'), 'Europe/Warsaw');
    await writeFile(file, csv, { encoding: 'utf8' });
    const bytes = await readFile(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.subarray(3).includes(Buffer.from([0xef, 0xbb, 0xbf])), false);
    const decoded = bytes.toString('utf8');
    assert.equal(decoded, csv);
    assert.equal(decoded.slice(1).startsWith('"ID wpisu";'), true);
    assert.equal(decoded.endsWith('\r\n'), true);
    const rows = parseSemicolonCsv(decoded);
    assert.equal(rows[1][4], a1.description);
    assert.equal(rows[2][4], "'=1+1");
    assert.equal(rows[1][3], '');
    assert.equal(rows[1][1], 'Alfa');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('TECH-10: client B marker cannot leak through A client export input', () => {
  const entries = [a1, b1];
  assert.throws(() => makeClientExportRows(entries, 'Alfa', '2026-01-01', '2026-02-28', 'UTC'), /innego klienta/);
  const csv = exportCsv(makeClientExportRows([a1, a2], 'Alfa', '2026-01-01', '2026-02-28', 'UTC'), 'UTC');
  assert.equal(csv.includes('ZNACZNIK-B'), false);
  assert.throws(() => makeClientExportRows([a1], '', '2026-01-01', '2026-02-28', 'UTC'));
  assert.equal(b1.client, 'Beta-ZNACZNIK-B');
});
test('TECH-10: formula injection is protected in every user-text column without mutating source', () => {
  const risky = { ...a1, client: '=CMD()', project: ' \t+SUM(1;1)', task: '@SHELL', description: '\r\n-1' };
  const csv = exportCsv(makeExportRows([risky], '2026-01-01', '2026-02-28', 'UTC'), 'UTC');
  const fields = parseSemicolonCsv(csv)[1];
  assert.deepEqual(fields.slice(1, 5), ["'=CMD()", "' \t+SUM(1;1)", "'@SHELL", "'\r\n-1"]);
  assert.equal(risky.description, '\r\n-1');
  assert.equal(spreadsheetText('Zażółć'), 'Zażółć');
});
test('TECH-10: day-with-work denominator excludes zero days and includes weekend', () => {
  const entries = [
    { id: 20, started_at: '2026-01-02T09:00:00Z', ended_at: '2026-01-02T17:00:00Z', duration_seconds: 28800 },
    { id: 21, started_at: '2026-01-03T09:00:00Z', ended_at: '2026-01-03T15:00:00Z', duration_seconds: 21600 }
  ];
  const report = reportByDay(entries, '2026-01-01', '2026-01-05', 'Europe/Warsaw');
  assert.deepEqual(report.days.map(x => x.date), ['2026-01-02', '2026-01-03']);
  assert.equal(report.totalSeconds, 50400);
  assert.equal(report.averageSeconds, 25200);
  assert.equal(reportByDay([], '2026-01-01', '2026-01-05', 'Europe/Warsaw').averageSeconds, null);
});
test('TECH-10: billable ratio uses contributed seconds, not full source duration', () => {
  const rows = makeClientExportRows([a1, a2], 'Alfa', '2026-02-01', '2026-02-28', 'Europe/Warsaw');
  const billableSeconds = rows.filter(row => row.source.billable).reduce((n, row) => n + row.contribution, 0);
  const allSeconds = totalContribution(rows);
  assert.equal(allSeconds, 4200);
  assert.equal(billableSeconds, 3600);
  assert.equal(billableSeconds / allSeconds, 6 / 7);
  assert.equal(totalContribution([]), 0);
});
test('TECH-10: running projection is displayed separately, excluded from finalized CSV', () => {
  const completed = { ...a1, started_at: '2026-11-18T09:00:00Z',
    ended_at: '2026-11-18T14:00:00Z', duration_seconds: 5 * 3600 };
  const provisional = { id: 40, started_at: '2026-11-18T14:00:00Z',
    ended_at: '2026-11-18T14:45:00Z', duration_seconds: 2700 };
  const finalized = reportByDay(reportSources([completed]), '2026-11-18', '2026-11-18', 'UTC');
  const live = reportByDay([...reportSources([completed]), provisional], '2026-11-18', '2026-11-18', 'UTC');
  assert.equal(finalized.totalSeconds, 5 * 3600);
  assert.equal(live.totalSeconds, finalized.totalSeconds + 2700);
  const rows = makeClientExportRows([completed], 'Alfa', '2026-11-18', '2026-11-18', 'UTC');
  assert.equal(totalContribution(rows), finalized.totalSeconds);
  assert.equal(exportCsv(rows, 'UTC').includes('"40"'), false);
});
test('TECH-10: duplicate IDs and invalid duration reject instead of exporting partial or incorrect data', () => {
  assert.throws(() => makeExportRows([a1, a1], '2026-01-01', '2026-02-28', 'UTC'));
  assert.throws(() => makeExportRows([{ ...a1, duration_seconds: 1 }], '2026-01-01', '2026-02-28', 'UTC'));
  assert.throws(() => makeExportRows([{ ...a1, id: -1 }], '2026-01-01', '2026-02-28', 'UTC'));
});
test('TECH-10: over-24h duration formatting never wraps and DST-local offsets are explicit', () => {
  assert.equal(formatDuration(90000), '25:00:00');
  assert.equal(formatDuration(5027), '01:23:47');
  assert.equal(localTimestamp('2026-03-29T00:30:00Z', 'Europe/Warsaw'), '2026-03-29T01:30:00+01:00');
  assert.equal(localTimestamp('2026-03-29T01:30:00Z', 'Europe/Warsaw'), '2026-03-29T03:30:00+02:00');
  assert.equal(localTimestamp('2026-10-25T00:30:00Z', 'Europe/Warsaw'), '2026-10-25T02:30:00+02:00');
  assert.equal(localTimestamp('2026-10-25T01:30:00Z', 'Europe/Warsaw'), '2026-10-25T02:30:00+01:00');
});

const reportsCatalog = {
  clients: [{ id: 1, name: 'Alfa' }, { id: 2, name: 'Beta' }],
  projects: [{ id: 1, client_id: 1, name: 'Wspólny' }, { id: 2, client_id: 2, name: 'Wspólny' }],
  tasks: [{ id: 4, project_id: 2, name: 'Tylko u klienta Beta' }],
};

function reportEntry(
  id: number, start: string, end: string, seconds: number, overrides: Partial<CompletedReportEntry> = {},
): CompletedReportEntry {
  return {
    id, started_at: start, ended_at: end, duration_seconds: seconds,
    project_id: 1, task_id: null, description: '', billable: false, ...overrides,
  };
}

test('Detailed, Summary and independently fetched CSV agree on finalized work in the selected range', () => {
  const midnight = reportEntry(1, '2026-01-31T23:30:00Z', '2026-02-01T01:30:00Z', 7200, { billable: true });
  const awaiting = reportEntry(2, '2026-01-31T09:00:00Z', '2026-01-31T12:00:00Z', 7200, {
    sleep_periods: [{ id: 1, entryId: 2, startedMs: Date.parse('2026-01-31T10:00:00Z'), endedMs: Date.parse('2026-01-31T11:00:00Z'), decision: 'pending' }],
  });
  const foreign = reportEntry(3, '2026-01-31T13:00:00Z', '2026-01-31T16:00:00Z', 10800, { project_id: 2, task_id: 4 });
  const active: ActiveReportEntry = {
    ...reportEntry(4, '2026-01-31T17:00:00Z', '2026-01-31T17:45:00Z', 2700),
    unresolved: false,
  };
  const view = makeReportView({ entries: [midnight, foreign, awaiting], active, time_zone: 'UTC' },
    reportsCatalog, { ...allReportClients, clientId: 1 }, '2026-01-31', '2026-01-31');
  assert.deepEqual(view.rows.map(row => [row.source.id, row.status, row.contribution]), [
    [1, 'finalized', 1800], [2, 'pending', 7200], [4, 'running', 2700],
  ]);
  assert.equal(view.finalizedSeconds, 1800);
  assert.equal(view.liveSeconds, 11700);
  assert.equal(view.billableSeconds, 1800);
  assert.equal(view.pendingSeconds, 3600);
  assert.equal(view.awaitingSeconds, 7200);
  assert.deepEqual(view.liveDays, [{ date: '2026-01-31', seconds: 11700 }]);

  const backing = [awaiting, midnight].map(entry => ({ ...entry, client: 'Alfa', project: 'Wspólny', task: '' }));
  const csvRows = makeClientExportRows(backing, 'Alfa', '2026-01-31', '2026-01-31', 'UTC');
  assert.ok(sameExportRows(csvRows, view.finalizedRows));
  assert.equal(parseSemicolonCsv(exportCsv(csvRows, 'UTC'))[1][10], '1800');
  assert.ok(!sameExportRows([{ ...csvRows[0], source: { ...csvRows[0].source, description: 'Zmieniony opis' } }], view.finalizedRows));
});

test('known work remains in report totals while each pending sleep period is decided separately', () => {
  const span = (id: number, started: string, ended: string) => ({
    id, entryId: 11, startedMs: Date.parse(started), endedMs: Date.parse(ended), decision: 'pending' as const,
  });
  const sleep = [
    span(1, '2026-01-01T23:00:00Z', '2026-01-01T23:20:00Z'),
    span(2, '2026-01-01T23:20:00Z', '2026-01-02T00:00:00Z'),
    span(3, '2026-01-02T00:00:00Z', '2026-01-02T00:15:00Z'),
  ];
  const later = reportEntry(12, '2026-01-02T13:00:00Z', '2026-01-02T13:30:00Z', 1800);
  const foreign = reportEntry(13, '2026-01-02T09:00:00Z', '2026-01-02T12:00:00Z', 10800, { project_id: 2 });
  const scope = { ...allReportClients, clientId: 1 };
  const decisions = [
    { values: ['pending', 'pending', 'pending'], work: 3600, pending: 4500, count: 3, finalized: 1800 },
    { values: ['included', 'pending', 'pending'], work: 4800, pending: 3300, count: 2, finalized: 1800 },
    { values: ['included', 'excluded', 'pending'], work: 4800, pending: 900, count: 1, finalized: 1800 },
    { values: ['included', 'excluded', 'included'], work: 5700, pending: 0, count: 0, finalized: 7500 },
  ] as const;
  for (const step of decisions) {
    const entry = reportEntry(11, '2026-01-01T22:00:00Z', '2026-01-02T00:15:00Z', step.work, {
      billable: true, sleep_periods: sleep.map((period, index) => ({ ...period, decision: step.values[index] })),
    });
    const data = { entries: [entry, later, foreign], active: null, time_zone: 'UTC' };
    const view = makeReportView(data, reportsCatalog, scope, '2026-01-01', '2026-01-02');
    assert.equal(view.liveSeconds, step.work + 1800);
    assert.equal(view.billableSeconds, step.work);
    assert.equal(view.averageSeconds, (step.work + 1800) / 2);
    assert.equal(view.pendingSeconds, step.pending);
    assert.equal(view.pendingPeriodCount, step.count);
    assert.equal(view.finalizedSeconds, step.finalized);
    assert.deepEqual(view.rows.map(row => row.source.id), [11, 12]);
    const exportSource = [entry, later].map(source => ({ ...source, client: 'Alfa', project: 'Wspólny', task: '' }));
    const csv = makeClientExportRows(exportSource, 'Alfa', '2026-01-01', '2026-01-02', 'UTC');
    assert.ok(sameExportRows(csv, view.finalizedRows));
    assert.equal(csv.reduce((sum, row) => sum + row.contribution, 0), step.finalized);

    if (step.count === 3) {
      const dayTwo = makeReportView(data, reportsCatalog, scope, '2026-01-02', '2026-01-02');
      assert.equal(dayTwo.pendingPeriodCount, 1);
      assert.equal(dayTwo.pendingSeconds, 900);
      assert.equal(dayTwo.liveSeconds, 1800);
    }
  }
});

test('Detailed hides names from an unrelated task and stays stable when sorting equal values', () => {
  const first = reportEntry(10, '2026-01-31T07:00:00Z', '2026-01-31T08:00:00Z', 3600);
  const second = reportEntry(5, '2026-01-31T07:00:00Z', '2026-01-31T08:00:00Z', 3600);
  const mismatch = reportEntry(2, '2026-01-31T09:00:00Z', '2026-01-31T10:00:00Z', 3600, { task_id: 4 });
  const invalidTime = reportEntry(3, '2026-02-30T09:00:00Z', '2026-03-02T10:00:00Z', 3600);
  const view = makeReportView({ entries: [first, second, mismatch, invalidTime], active: null, time_zone: 'UTC' },
    reportsCatalog, { ...allReportClients, clientId: 1 }, '2026-01-31', '2026-03-02');
  assert.equal(view.missingRelations, true);
  assert.deepEqual(view.excludedEntryIds, [3]);
  assert.equal(view.finalizedSeconds, 7200);
  for (const descending of [true, false]) {
    assert.deepEqual(sortReportRows(view.rows, 'start', descending).map(row => row.source.id), [5, 10]);
    assert.deepEqual(sortReportRows(view.rows, 'contribution', descending).map(row => row.source.id), [5, 10]);
  }
});

test('restoring a scope respects archived IDs and distinguishes missing or foreign selections', () => {
  const chosen = { clientId: 2, projectId: 2, taskId: 4 };
  const catalog = { ...reportsCatalog, projects: [
    reportsCatalog.projects[0], { ...reportsCatalog.projects[1], archived: true, name: 'Nowa nazwa' },
  ] };
  assert.equal(resolveReportScope(chosen, catalog).problem, '');
  assert.equal(resolveReportScope(chosen, catalog).project?.name, 'Nowa nazwa');
  assert.match(resolveReportScope({ ...chosen, clientId: 99 }, catalog).problem, /klient/);
  assert.match(resolveReportScope({ ...chosen, projectId: 99 }, catalog).problem, /projekt/);
  assert.match(resolveReportScope({ ...chosen, taskId: 99 }, catalog).problem, /zadanie/);
  assert.match(resolveReportScope({ ...chosen, clientId: 1 }, catalog).problem, /projekt nie należy/);
  assert.match(resolveReportScope({ ...chosen, projectId: null }, catalog).problem, /zadanie nie należy/);

  const unchanged = changeReportScope(chosen, 'clientId', 2, catalog);
  assert.deepEqual(unchanged, { scope: chosen, message: '' });
  const newClient = changeReportScope(chosen, 'clientId', 1, catalog);
  assert.deepEqual(newClient.scope, { ...allReportClients, clientId: 1 });
  assert.match(newClient.message, /projekt i zadanie/);
  const newProject = changeReportScope(chosen, 'projectId', null, catalog);
  assert.deepEqual(newProject.scope, { ...allReportClients, clientId: 2 });
  assert.match(newProject.message, /zadanie/);
});

test('the shared report scope includes only the selected task across a month boundary', () => {
  const from = '2026-11-30T22:30:00Z';
  const through = '2026-12-01T01:30:00Z';
  const foreign = reportEntry(1, from, through, 10800);
  const projectOnly = reportEntry(2, from, through, 10800, { project_id: 2 });
  const selected = reportEntry(3, from, through, 10800, { project_id: 2, task_id: 4 });
  const data = { entries: [foreign, projectOnly, selected], active: { ...projectOnly, id: 4, unresolved: false }, time_zone: 'Europe/Warsaw' };
  const scope = { clientId: 2, projectId: 2, taskId: 4 };
  const november = makeReportView(data, reportsCatalog, scope, '2026-11-01', '2026-11-30');
  const december = makeReportView(data, reportsCatalog, scope, '2026-12-01', '2026-12-31');
  assert.equal(november.finalizedSeconds, 1800);
  assert.equal(december.finalizedSeconds, 9000);
  assert.equal(november.active, null);
  assert.deepEqual(december.finalizedRows.map(row => row.source.id), [3]);
});

test('TECH-10: report and CSV agree while each pending sleep period is decided separately', () => {
  const span = (id: number, started: string, ended: string) => ({
    id, entryId: 11, startedMs: Date.parse(started), endedMs: Date.parse(ended), decision: 'pending' as const,
  });
  const sleep = [
    span(1, '2026-01-01T23:00:00Z', '2026-01-01T23:20:00Z'),
    span(2, '2026-01-01T23:20:00Z', '2026-01-02T00:00:00Z'),
    span(3, '2026-01-02T00:00:00Z', '2026-01-02T00:15:00Z'),
  ];
  const later: ExportEntry = {
    id: 12, client: 'Alfa', project: 'Wspólny', task: '', description: '', billable: false,
    started_at: '2026-01-02T13:00:00Z', ended_at: '2026-01-02T13:30:00Z', duration_seconds: 1800,
  };
  const decisions = [
    { values: ['pending', 'pending', 'pending'], work: 3600, pending: 4500, count: 3, finalized: 1800 },
    { values: ['included', 'pending', 'pending'], work: 4800, pending: 3300, count: 2, finalized: 1800 },
    { values: ['included', 'excluded', 'pending'], work: 4800, pending: 900, count: 1, finalized: 1800 },
    { values: ['included', 'excluded', 'included'], work: 5700, pending: 0, count: 0, finalized: 7500 },
  ] as const;
  for (const step of decisions) {
    const entry: ExportEntry = {
      id: 11, client: 'Alfa', project: 'Wspólny', task: '', description: '', billable: true,
      started_at: '2026-01-01T22:00:00Z', ended_at: '2026-01-02T00:15:00Z', duration_seconds: step.work,
      sleep_periods: sleep.map((period, index) => ({ ...period, decision: step.values[index] })),
    };
    const report = reportByDay([entry, later], '2026-01-01', '2026-01-02', 'UTC');
    assert.deepEqual(report.excludedEntryIds, []);
    // Known work stays in the report; undecided sleep is shown separately.
    assert.equal(report.totalSeconds, step.work + 1800);
    assert.equal(report.pendingSeconds, step.pending);
    assert.equal(report.pendingPeriodCount, step.count);
    const csv = makeClientExportRows([entry, later], 'Alfa', '2026-01-01', '2026-01-02', 'UTC');
    // An entry reaches the CSV only after every one of its periods is decided.
    assert.equal(csv.reduce((sum, row) => sum + row.contribution, 0), step.finalized);
    assert.deepEqual(csv.map(row => row.source.id), step.count ? [12] : [11, 12]);
    assert.equal(parseSemicolonCsv(exportCsv(csv, 'UTC')).length, csv.length + 1);
    if (step.count === 3) {
      const dayTwo = reportByDay([entry, later], '2026-01-02', '2026-01-02', 'UTC');
      assert.equal(dayTwo.pendingPeriodCount, 1);
      assert.equal(dayTwo.pendingSeconds, 900);
      assert.equal(dayTwo.totalSeconds, 1800);
    }
  }
});
