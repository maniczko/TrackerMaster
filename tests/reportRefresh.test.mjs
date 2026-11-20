import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const report = readFileSync(new URL('../src/Report.tsx', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../src/EntryDraftEditor.tsx', import.meta.url), 'utf8');

// Source-wiring regression: React E2E on a signed Windows 11 build is a separate QA gate.
test('a confirmed draft commit invalidates the report, even if snapshot refresh fails', () => {
  assert.match(editor, /const entryId = await invoke<number>\('apply_entry_draft',[\s\S]*?await onCommitted\(entryId\)/);
  const handler = app.match(/onCommitted=\{async entryId => \{([\s\S]*?)\}\} \/>/);
  assert.ok(handler, 'EntryDraftEditor must have an onCommitted handler');
  assert.match(handler[1], /setReportRevision\(version => version \+ 1\)/);
  assert.ok(handler[1].indexOf('setReportRevision(') < handler[1].indexOf('await refresh()'),
    'Report invalidation must not wait for potentially failing snapshot/history reads');
  assert.match(app, /<Report\b[^>]*\brevision=\{reportRevision\}/);
});

test('report refresh depends on revision and invalidates stale CSV previews', () => {
  assert.match(report, /revision: number/);
  assert.match(report, /\}, \[open, loaded, refresh, revision\]\)/);
  assert.match(report, /<ReportExport key=\{JSON\.stringify\(\[client, range\.from, range\.through, data\.time_zone, revision\]\)\}/);
});

test('a new revision does not render old report data or expose its CSV preview', () => {
  assert.match(report, /const \[snapshot, setSnapshot\] = useState<\{ revision: number; data: Data \} \| null>\(null\)/);
  assert.match(report, /const data = snapshot\?\.revision === revision \? snapshot\.data : null/);
  assert.match(report, /setSnapshot\(\{ revision, data: next \}\)/);
  assert.doesNotMatch(report, /setData\(/, 'unversioned data must not bypass revision validation');
});
