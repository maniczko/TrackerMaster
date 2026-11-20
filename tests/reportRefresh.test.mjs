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

test('every confirmed operation outside the draft editor invalidates the report', () => {
  const execute = app.match(/async function execute\(action[^)]*\)[^{]*\{([\s\S]*?)\r?\n  \}\r?\n/);
  assert.ok(execute, 'App must define execute()');
  const body = execute[1];
  const failure = body.indexOf('catch (e)');
  const bump = body.indexOf('setReportRevision(version => version + 1)');
  assert.ok(bump > failure && bump > body.indexOf('return;'), 'only a confirmed action may invalidate the report');
  assert.ok(bump < body.lastIndexOf('await refresh()'), 'invalidation must not wait for a possibly failing snapshot read');
  assert.match(app, /set_entry_description[\s\S]*?'Opis został zapisany\.'/);
  for (const command of ['set_entry_description', 'set_entry_billable', 'delete_time_entry']) {
    assert.match(app, new RegExp(String.raw`execute\([^;]*invoke\('` + command + "'"), `${command} must go through execute()`);
  }
});

test('sleep decisions and manual re-read invalidate the report, the periodic refresh does not', () => {
  const sleep = app.match(/<SleepPending loaded=\{loaded\} onResolved=\{async \(\) => \{([\s\S]*?)\}\} \/>/);
  assert.ok(sleep, 'SleepPending must have an onResolved handler');
  assert.ok(sleep[1].indexOf('setReportRevision(version => version + 1)') >= 0);
  assert.ok(sleep[1].indexOf('setReportRevision(') < sleep[1].indexOf('await refresh()'));
  assert.match(app, /async function retryRefresh\(\)[\s\S]*?await refresh\(\); setReportRevision\(version => version \+ 1\)/);
  const refresh = app.match(/const refresh = useCallback\(async \(\) => \{([\s\S]*?)\r?\n  \}, /);
  assert.ok(refresh, 'App must define refresh()');
  assert.doesNotMatch(refresh[1], /setReportRevision/, 'the 2.5 s refresh must not reset the report');
});
