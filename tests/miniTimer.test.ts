import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../src/App.tsx';
import { activeContext, choicesFor, clockState, createRequestGate, descriptionCommand, durationText, pickerGroups, pickerKey, readLegacyPin, recentChoices, toggleCommand } from '../src/miniTimerModel.ts';

const entry = { id: 9, task_id: '3', project_id: 2, started_at: '2026-11-17T09:00:00Z', ended_at: null, billable: true, description: 'Szkic' };
const snapshot: Snapshot = {
  clients: [{ id: 1, name: 'Łódź', archived: false }, { id: 52, name: 'Archiwum', archived: true }],
  projects: [{ id: '2', client_id: 1, name: 'Wdrożenie', archived: false, billable: true }, { id: 53, client_id: 52, name: 'Niedostępny', archived: false, billable: false }],
  tasks: [{ id: 3, project_id: '2', name: 'Przygotowanie dokumentacji końcowej dla zespołu wdrożeniowego', archived: false }, { id: 4, project_id: 2, name: 'Ukryty', archived: true }],
  active: null, entries: [],
};
const choices = choicesFor(snapshot);

test('clock renders idle, long running, recovered and disconnected without rolling over at 24 h', () => {
  const now = Date.parse('2026-11-18T12:04:03Z');
  assert.equal(durationText(359999), '99:59:59');
  assert.equal(durationText(360000), '100:00:00');
  assert.deepEqual(clockState(snapshot, now), { mode: 'idle', text: '00:00:00' });
  assert.deepEqual(clockState({ ...snapshot, active: entry }, now), { mode: 'running', text: '27:04:03' });
  assert.equal(clockState({ ...snapshot, active: { ...entry, recovered: true } }, now).mode, 'recovered');
  assert.equal(clockState({ ...snapshot, active: { ...entry, uncertain: true } }, now).mode, 'recovered');
  assert.deepEqual(clockState({ ...snapshot, active: { ...entry, excluded_sleep_ms: 60_000 } }, now), { mode: 'running', text: '27:03:03' });
  assert.equal(clockState({ ...snapshot, active: { ...entry, started_at: 'invalid' } }, now).mode, 'unavailable');
  assert.equal(clockState(null, now).mode, 'unavailable');
});

test('active context retains full names even if archived; only valid choices can start new timers', () => {
  const context = activeContext(snapshot, entry);
  assert.equal(context.title, snapshot.tasks[0].name);
  assert.equal(context.path, 'Łódź / Wdrożenie');
  assert.equal(activeContext(snapshot, { ...entry, task_id: 4 }).title, 'Ukryty');
  assert.deepEqual(choices.map(choice => choice.key), ['project:2', 'task:3']);
});

test('recent choices are unique, limited and filtered; search matches Polish names and no-task entries', () => {
  const entries = [entry, entry, { ...entry, project_id: 53, task_id: null }, { ...entry, task_id: null }];
  assert.deepEqual(recentChoices(choices, entries, 1).map(choice => choice.key), ['task:3']);
  const recent = recentChoices(choices, entries);
  assert.deepEqual(recent.map(choice => choice.key), ['task:3', 'project:2']);
  assert.equal(pickerGroups(choices, recent, '', false)[0].id, 'recent');
  assert.equal(pickerGroups(choices, recent, '', true)[0].label, 'Łódź / Wdrożenie');
  assert.deepEqual(pickerGroups(choices, recent, 'lodz bez zadania', false)[0].items.map(choice => choice.key), ['project:2']);
  assert.deepEqual(pickerGroups(choices, recent, 'nie istnieje', false), []);
});

test('picker navigates by stable keys, clamps to edges and leaves Tab and Escape to the panel', () => {
  const keys = ['project:2', 'task:3'];
  assert.deepEqual(pickerKey(keys, null, 'ArrowDown'), { highlight: 'project:2' });
  assert.deepEqual(pickerKey(keys, null, 'ArrowUp'), { highlight: 'task:3' });
  assert.deepEqual(pickerKey(keys, 'task:3', 'ArrowDown'), { highlight: 'task:3' });
  assert.deepEqual(pickerKey(keys, 'task:3', 'ArrowUp'), { highlight: 'project:2' });
  assert.deepEqual(pickerKey(keys, 'task:3', 'Enter'), { select: 'task:3' });
  assert.equal(pickerKey([], null, 'Enter'), null);
  assert.equal(pickerKey(keys, 'task:3', 'Tab'), null);
  assert.equal(pickerKey(keys, 'task:3', 'Escape'), null);
});

test('timer mutations use exact native IDs with optional tasks and never run for uncertain or unavailable time', () => {
  assert.deepEqual(toggleCommand('idle', null, choices[0], 'Szkic'), { name: 'widget_project_start', args: { projectId: 2, taskId: null, description: 'Szkic' } });
  assert.deepEqual(toggleCommand('running', entry, choices[1], ''), { name: 'widget_stop', args: { entryId: 9 } });
  assert.equal(toggleCommand('idle', null, undefined, ''), null);
  assert.equal(toggleCommand('unavailable', entry, choices[0], ''), null);
  assert.equal(toggleCommand('recovered', entry, choices[0], ''), null);
});

test('description drafts are scoped to one entry and cannot overwrite a conflicting database value', () => {
  const draft = { entryId: '9', expected: 'Szkic', value: 'Zmieniony' };
  assert.deepEqual(descriptionCommand(entry, draft)?.args, { entryId: 9, expected: 'Szkic', description: 'Zmieniony' });
  assert.equal(descriptionCommand({ ...entry, description: 'Nowa wersja z głównego okna' }, draft), null);
  assert.equal(descriptionCommand({ ...entry, id: 10 }, draft), null);
  assert.equal(descriptionCommand({ ...entry, recovered: true }, draft), null);
  assert.equal(descriptionCommand(null, draft), null);
  assert.equal(draft.value, 'Zmieniony');
});

test('a write invalidates old polls and rejects a simultaneous second action', () => {
  const gate = createRequestGate();
  const firstRead = gate.beginRead();
  assert.equal(gate.beginWrite(), true);
  assert.equal(gate.isCurrent(firstRead), false);
  assert.equal(gate.beginWrite(), false);
  const resync = gate.beginRead();
  assert.equal(gate.isCurrent(resync), true);
  gate.endWrite();
  assert.equal(gate.beginWrite(), true);
  assert.equal(gate.isCurrent(resync), false);
});

test('pin migration preserves explicit old choices and defers missing or unreadable data to native settings', () => {
  assert.equal(readLegacyPin({ getItem: key => key === 'widget-on-top' ? 'true' : null }), true);
  assert.equal(readLegacyPin({ getItem: () => 'false' }), false);
  assert.equal(readLegacyPin({ getItem: () => 'invalid' }), null);
  assert.equal(readLegacyPin({ getItem: () => { throw Error('Storage unavailable'); } }), null);
  assert.equal(readLegacyPin({ getItem: () => null }), null);
});
