import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../src/App.tsx';
import { activeContext, barContext, choicesFor, clockState, createRequestGate, descriptionCommand, durationText, pickerGroups, pickerKey, PROJECT_COLOURS, projectColour, readLegacyPin, recentChoices, switchChoices, switchCommand, toggleCommand } from '../src/miniTimerModel.ts';
import { clientLabels } from '../src/clientLabels.ts';

const entry = { id: 9, task_id: '3', project_id: 2, started_at: '2026-11-17T09:00:00Z', ended_at: null, billable: true, description: 'Szkic' };
const snapshot: Snapshot = {
  clients: [{ id: 1, name: 'Łódź', archived: false }, { id: 52, name: 'Archiwum', archived: true }],
  projects: [{ id: '2', client_id: 1, name: 'Wdrożenie', archived: false, billable: true }, { id: 53, client_id: 52, name: 'Niedostępny', archived: false, billable: false }],
  tasks: [{ id: 3, project_id: '2', name: 'Przygotowanie dokumentacji końcowej dla zespołu wdrożeniowego', archived: false }, { id: 4, project_id: 2, name: 'Ukryty', archived: true }],
  active: null, entries: [],
};
const choices = choicesFor(snapshot);

test('duplicate client names have stable distinct labels in selection and active context', () => {
  const duplicates: Snapshot = {
    ...snapshot,
    clients: [{ id: 1, name: 'Łódź', archived: false }, { id: 52, name: 'Łódź', archived: false }],
    projects: [snapshot.projects[0], { ...snapshot.projects[1], name: 'Wdrożenie' }],
  };
  const labels = clientLabels(duplicates.clients);
  assert.equal(labels.get('1'), 'ID 1 · Łódź');
  assert.equal(labels.get('52'), 'ID 52 · Łódź');
  const groups = pickerGroups(choicesFor(duplicates), [], '', true);
  assert.deepEqual(groups.map(group => group.label), ['ID 1 · Łódź / Wdrożenie', 'ID 52 · Łódź / Wdrożenie']);
  assert.equal(activeContext(duplicates, entry).path, 'ID 1 · Łódź / Wdrożenie');
  assert.equal(clientLabels(snapshot.clients).get('1'), 'Łódź');
  assert.equal(clientLabels([{ id: 1, name: 'ŻÓŁĆ' }, { id: 2, name: 'żółć' }]).get('2'), 'ID 2 · żółć');
  const ambiguous = clientLabels([{ id: 1, name: 'X' }, { id: 2, name: 'X' }, { id: 3, name: 'ID 1 · X' }]);
  assert.equal(new Set(ambiguous.values()).size, 3);
});

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

test('bar context: description, then task, then project; second line is client · project without repeating the title', () => {
  const running = { ...snapshot, active: entry, entries: [entry] };
  const withDescription = barContext(running, { ...entry, description: '  Przegląd\n umowy  ' }, undefined);
  assert.equal(withDescription.title, 'Przegląd umowy');
  assert.equal(withDescription.subtitle, 'Łódź · Wdrożenie');
  assert.equal(withDescription.full, 'Przegląd umowy — Przygotowanie dokumentacji końcowej dla zespołu wdrożeniowego — Łódź / Wdrożenie');
  const taskOnly = barContext(running, { ...entry, description: '' }, undefined);
  assert.equal(taskOnly.title, 'Przygotowanie dokumentacji końcowej dla zespołu wdrożeniowego');
  assert.equal(taskOnly.subtitle, 'Łódź · Wdrożenie');
  const projectOnly = barContext(running, { ...entry, task_id: null, description: '' }, undefined);
  assert.equal(projectOnly.title, 'Wdrożenie');
  assert.equal(projectOnly.subtitle, 'Łódź');
  assert.equal(projectOnly.full, 'Bez zadania — Łódź / Wdrożenie');
  const missing = barContext(running, { ...entry, project_id: 999, task_id: null, description: '' }, undefined);
  assert.deepEqual([missing.title, missing.subtitle, missing.colour], ['Nieznany projekt', 'Nieznany klient', null]);
  // Unchanged contract used by the expanded panel and E2E.
  assert.deepEqual(activeContext(snapshot, entry), { title: 'Przygotowanie dokumentacji końcowej dla zespołu wdrożeniowego', path: 'Łódź / Wdrożenie' });
});

test('bar context for a stopped timer follows the selected choice and keeps full names for assistive text', () => {
  const projectChoice = choices.find(choice => choice.task === null)!;
  const taskChoice = choices.find(choice => choice.task !== null)!;
  assert.deepEqual(barContext(snapshot, null, projectChoice), { title: 'Wdrożenie', subtitle: 'Łódź', full: 'Bez zadania — Łódź / Wdrożenie', colour: projectColour('2') });
  assert.equal(barContext(snapshot, null, taskChoice).subtitle, 'Łódź · Wdrożenie');
  assert.equal(barContext(snapshot, null, taskChoice).full, `${taskChoice.task!.name} — Łódź / Wdrożenie`);
  assert.deepEqual(barContext(snapshot, null, undefined), { title: 'Wybierz projekt lub zadanie', subtitle: 'Gotowy do nowego pomiaru', full: 'Wybierz projekt lub zadanie — Gotowy do nowego pomiaru', colour: null });
  assert.equal(barContext(null, null, undefined).subtitle, 'Mini timer');
});

test('project colour is a stable decorative slot 1…8 for numeric and text IDs', () => {
  assert.equal(PROJECT_COLOURS, 8);
  assert.deepEqual([1, 2, 8, 9, 16].map(projectColour), [2, 3, 1, 2, 1]);
  assert.equal(projectColour('9'), projectColour(9));
  assert.equal(projectColour('9007199254740993'), Number(9007199254740993n % 8n) + 1);
  for (const id of ['abc', 'Łódź', '', 'x'.repeat(200)]) {
    const slot = projectColour(id);
    assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 8);
    assert.equal(projectColour(id), slot);
  }
});

test('expanded mini timer: recent targets other than the running one switch atomically (D3), never for a timer under review', () => {
  const many: Snapshot = {
    ...snapshot,
    projects: [...snapshot.projects, { id: 7, client_id: 1, name: 'Serwis', archived: false, billable: false }, { id: 8, client_id: 1, name: 'Szkolenia', archived: false, billable: true }],
  };
  const all = choicesFor(many);
  const done = (project_id: number | string, task_id: number | string | null, id: number) => ({ ...entry, id, project_id, task_id, ended_at: '2026-11-17T10:00:00Z' });
  const recent = recentChoices(all, [done(2, '3', 20), done(7, null, 19), done(2, null, 18), done(8, null, 17)]);
  const running = { ...entry, id: 30 };
  const quick = switchChoices(recent, running);
  assert.deepEqual(quick.map(choice => choice.key), ['project:7', 'project:2', 'project:8'], 'the running task is left out; at most three');
  assert.deepEqual(switchChoices(recent, running, 2).map(choice => choice.key), ['project:7', 'project:2']);
  assert.deepEqual(switchChoices(recent, null), [], 'nothing to switch without a running timer');
  const now = Date.parse('2026-11-18T12:00:00Z');
  const mode = clockState({ ...many, active: running }, now).mode;
  assert.equal(mode, 'running');
  assert.deepEqual(switchCommand(mode, running, quick[0]), { name: 'start_project_timer', args: { projectId: 7, taskId: null, expectedActiveId: 30, description: '' } });
  assert.equal(switchCommand(mode, running, all.find(choice => choice.key === 'task:3')), null, 'the running task is not started again');
  assert.equal(switchCommand('recovered', { ...running, recovered: true }, quick[0]), null);
  assert.equal(switchCommand('running', { ...running, uncertain: true }, quick[0]), null);
  assert.equal(switchCommand('unavailable', running, quick[0]), null);
  assert.equal(switchCommand('idle', null, quick[0]), null);
  assert.equal(switchCommand(mode, running, undefined), null);
});
