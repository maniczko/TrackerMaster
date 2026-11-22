process.env.TZ = 'Europe/Warsaw';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { entryTimeRange, menuStep } from '../src/historyFormat.ts';

const now = Date.parse('2026-11-21T12:00:00Z');

test('History rows show a short local time; the end date only when it is another day', () => {
  assert.deepEqual(entryTimeRange('2026-11-21T09:15:00Z', '2026-11-21T10:45:30Z', now), { start: '21.11, 10:15', end: '11:45' });
  assert.deepEqual(entryTimeRange('2026-11-20T22:30:00Z', '2026-11-20T23:30:00Z', now), { start: '20.11, 23:30', end: '21.11, 00:30' });
  assert.deepEqual(entryTimeRange('2025-12-31T10:00:00Z', '2025-12-31T11:00:00Z', now), { start: '31.12.2025, 11:00', end: '12:00' });
  assert.deepEqual(entryTimeRange('2026-07-01T06:05:00Z', null, now), { start: '01.07, 08:05', end: '—' }); // summer time
  assert.deepEqual(entryTimeRange('bad', 'also bad', now), { start: 'bad', end: 'also bad' });
});

test('menu keys move between enabled items only and wrap around', () => {
  const enabled = [true, false, true, true, false];
  assert.equal(menuStep(enabled, -1, 'ArrowDown'), 0);
  assert.equal(menuStep(enabled, 0, 'ArrowDown'), 2);
  assert.equal(menuStep(enabled, 3, 'ArrowDown'), 0);
  assert.equal(menuStep(enabled, 0, 'ArrowUp'), 3);
  assert.equal(menuStep(enabled, -1, 'ArrowUp'), 3);
  assert.equal(menuStep(enabled, 2, 'Home'), 0);
  assert.equal(menuStep(enabled, 0, 'End'), 3);
  assert.equal(menuStep([false, false], -1, 'ArrowDown'), -1);
});

// Presentation-only change: the row menu keeps each former button's command, disabled rule and name.
test('History menu items keep the handlers and disabled rules of the former row buttons', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const menu = readFileSync(new URL('../src/EntryMenu.tsx', import.meta.url), 'utf8');
  for (const [label, disabled, action] of [
    ['`Zmień opis: ${name}`', 'busy || !loaded', "entryEditor.current?.openEntry(Number(e.id), 'description')"],
    ['`${billingLabel}: ${name}`', 'busy || !loaded', "invoke('set_entry_billable', { entryId: Number(e.id), expected: e.billable, billable: !e.billable })"],
    ['`Popraw wpis: ${name}`', 'busy || !e.ended_at', "entryEditor.current?.openEntry(Number(e.id), 'start')"],
    ['`Usuń wpis: ${name}`', 'busy || !e.ended_at', 'setDeleting(e)'],
  ]) {
    const item = app.split('\n').find(line => line.includes(`ariaLabel: ${label}`));
    assert.ok(item, `menu item ${label} is missing`);
    assert.ok(item.includes(`disabled: ${disabled},`), `${label} changed its disabled rule`);
    assert.ok(item.includes(action), `${label} changed its handler`);
  }
  const history = app.split('\n').find(line => line.includes('ariaLabel: `Historia zmian: ${name}`'));
  assert.ok(history && !history.includes('disabled:') && history.includes('showRevisions(e.id)'));
  assert.match(app, /disabled=\{busy \|\| !loaded \|\| !!data\.active\?\.recovered\} aria-label=\{`Wznów: \$\{name\}`\}/);
  assert.match(menu, /aria-haspopup="menu" aria-expanded=\{open\}/);
  assert.match(menu, /role="menuitem"/);
  assert.match(menu, /event\.key === 'Escape'/);
});
