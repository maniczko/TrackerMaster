import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeClientExportRows, makeExportRows, formatDuration } from '../src/reportCsv.ts';
import { exportXlsx, exportClientXlsxFromEntries, inspectZipStore, writeXlsxAtomically } from '../src/reportXlsx.ts';

const baseEntry = {
  id: 14,
  client: 'Klient Źródełko',
  project: 'Projekt Łódź',
  task: 'Zadanie Żółć',
  description: 'Zażółć gęślą jaźń — ĄĆĘŁŃÓŚŹŻ',
  started_at: '2026-01-31T23:30:00Z',
  ended_at: '2026-02-01T00:30:00Z',
  duration_seconds: 3600,
  billable: true,
};

test('DEV-17: XLSX generates a real OOXML zip package matching filters, sums and Polish characters', () => {
  const entries = [
    baseEntry,
    {
      ...baseEntry,
      id: 15,
      project: 'Drugi projekt',
      task: '',
      description: 'Długa sesja ponad 24h',
      started_at: '2026-02-02T06:00:00Z',
      ended_at: '2026-02-03T07:00:00Z',
      duration_seconds: 90_000,
      billable: false,
    },
  ];
  const bytes = exportClientXlsxFromEntries(entries, {
    client: 'Klient Źródełko',
    from: '2026-02-01',
    through: '2026-02-05',
    zone: 'Europe/London',
  });
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

  const files = inspectZipStore(bytes);
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/workbook.xml',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
  ]) {
    assert.ok(files.has(required), `Missing OOXML part: ${required}`);
  }

  const sheet1 = files.get('xl/worksheets/sheet1.xml')!;
  const sheet2 = files.get('xl/worksheets/sheet2.xml')!;
  // Europe/London Feb 1..5: entry 14 contributes 1800s (00:00..00:30 UTC), entry 15 contributes 90000s (25:00:00).
  assert.ok(sheet1.includes('Zażółć gęślą jaźń — ĄĆĘŁŃÓŚŹŻ'));
  assert.ok(sheet1.includes('<v>1800</v>'));
  assert.ok(sheet1.includes('<v>90000</v>'));
  assert.ok(sheet1.includes(formatDuration(90_000)));
  assert.ok(sheet1.includes('25:00:00'));
  assert.ok(sheet2.includes(`<v>${91_800}</v>`));
  assert.ok(sheet2.includes('25:30:00'));
});

test('DEV-17: XLSX treats formula-like user values safely as inline strings with protective apostrophe', () => {
  const risky = {
    ...baseEntry,
    id: 22,
    client: '=CMD()',
    project: '+SUM(1;1)',
    task: '@EXEC',
    description: '\t-1+2 & <tag>',
    started_at: '2026-02-10T10:00:00Z',
    ended_at: '2026-02-10T11:00:00Z',
  };
  const rows = makeExportRows([risky], '2026-02-10', '2026-02-10', 'UTC');
  const files = inspectZipStore(exportXlsx(rows, { client: '=CMD()', from: '2026-02-10', through: '2026-02-10', zone: 'UTC' }));
  const sheet1 = files.get('xl/worksheets/sheet1.xml')!;
  assert.ok(!sheet1.includes('<f>'));
  assert.ok(sheet1.includes('&apos;=CMD()'));
  assert.ok(sheet1.includes('&apos;+SUM(1;1)'));
  assert.ok(sheet1.includes('&apos;@EXEC'));
  assert.ok(sheet1.includes('&apos;\t-1+2 &amp; &lt;tag&gt;'));
  assert.equal(risky.description, '\t-1+2 & <tag>');
});

test('DEV-17: XLSX enforces client isolation, pending-sleep rules and leaves no empty file on cancel or error', async () => {
  const otherClient = { ...baseEntry, id: 16, client: 'Obcy klient' };
  assert.throws(() => makeClientExportRows([baseEntry, otherClient], 'Klient Źródełko', '2026-01-31', '2026-02-01', 'UTC'), /innego klienta/);

  const dir = await mkdtemp(join(tmpdir(), 'tm-xlsx-cancel-'));
  try {
    const target = join(dir, 'canceled.xlsx');
    const rows = makeClientExportRows([baseEntry], baseEntry.client, '2026-01-31', '2026-02-01', 'UTC');
    const meta = { client: baseEntry.client, from: '2026-01-31', through: '2026-02-01', zone: 'UTC' };
    const cancelled = await writeXlsxAtomically(rows, meta, async () => 'cancelled');
    assert.equal(cancelled, 'cancelled');
    assert.deepEqual(await readdir(dir), []);

    await assert.rejects(
      () => writeXlsxAtomically(rows, { ...meta, client: '' }, async bytes => {
        await writeFile(target, bytes);
        return 'saved';
      }),
      /metadanych/,
    );
    assert.deepEqual(await readdir(dir), []);

    const saved = await writeXlsxAtomically(rows, meta, async bytes => {
      await writeFile(target, bytes);
      return 'saved';
    });
    assert.equal(saved, 'saved');
    assert.deepEqual(await readdir(dir), ['canceled.xlsx']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
