import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../src/App.tsx';
import { choicesFor, createRequestGate, recentChoices } from '../src/miniTimerModel.ts';
import { selectionFor, selectionKey, startBlocked } from '../src/timerChoice.ts';

// Synthetic data only. The main window uses the mini timer's own choice model.
const snapshot: Snapshot = {
  clients: [{ id: 1, name: 'Klient A', archived: false }, { id: 2, name: 'Archiwum', archived: true }],
  projects: [{ id: 10, client_id: 1, name: 'Strona', archived: false, billable: true }, { id: 11, client_id: 1, name: 'Stary', archived: true, billable: false },
    { id: 20, client_id: 2, name: 'Ukryty', archived: false, billable: false }],
  tasks: [{ id: 100, project_id: 10, name: 'Makiety', archived: false }, { id: 101, project_id: 10, name: 'Zamknięte', archived: true }],
  active: null,
  entries: [
    { id: 3, task_id: 100, project_id: 10, started_at: '2026-11-20T09:00:00Z', ended_at: '2026-11-20T10:00:00Z', billable: true, description: '' },
    { id: 2, task_id: null, project_id: 10, started_at: '2026-11-19T09:00:00Z', ended_at: '2026-11-19T10:00:00Z', billable: true, description: '' },
    { id: 1, task_id: 100, project_id: 10, started_at: '2026-11-18T09:00:00Z', ended_at: '2026-11-18T10:00:00Z', billable: true, description: '' },
  ],
};
const choices = choicesFor(snapshot);

test('only active clients, projects and tasks can be chosen; recent items come first without duplicates', () => {
  assert.deepEqual(choices.map(choice => choice.key), ['project:10', 'task:100']);
  assert.deepEqual(recentChoices(choices, snapshot.entries).map(choice => choice.key), ['task:100', 'project:10']);
});

test('a choice maps onto the client, project and task the main window starts with', () => {
  assert.deepEqual(selectionFor(choices, 'task:100'), { clientId: '1', projectId: '10', taskId: '100' });
  assert.deepEqual(selectionFor(choices, 'project:10'), { clientId: '1', projectId: '10', taskId: '' });
  assert.equal(selectionFor(choices, 'task:101'), null, 'archived task is not selectable');
  assert.equal(selectionFor(choices, 'project:20'), null, 'project of an archived client is not selectable');
  assert.equal(selectionKey('10', '100'), 'task:100');
  assert.equal(selectionKey('10', ''), 'project:10');
  assert.equal(selectionKey('', ''), undefined);
});

test('Start keeps the list rules: project required, archive blocked, same running target not started twice', () => {
  const ready = { busy: false, loaded: true, projectId: '10', taskId: '100', active: null };
  assert.equal(startBlocked(ready), false);
  assert.equal(startBlocked({ ...ready, projectId: '' }), true);
  assert.equal(startBlocked({ ...ready, busy: true }), true);
  assert.equal(startBlocked({ ...ready, loaded: false }), true);
  assert.equal(startBlocked({ ...ready, project: { id: 10, archived: true } }), true);
  assert.equal(startBlocked({ ...ready, client: { id: 1, archived: true } }), true);
  assert.equal(startBlocked({ ...ready, task: { id: 100, archived: true } }), true);
  const running = { project_id: 10, task_id: 100 };
  assert.equal(startBlocked({ ...ready, active: running }), true, 'the running task is not started again');
  assert.equal(startBlocked({ ...ready, taskId: '', active: running }), false, 'switching to the project without a task');
  assert.equal(startBlocked({ ...ready, taskId: '', active: { project_id: 10, task_id: null } }), true);
  assert.equal(startBlocked({ ...ready, active: { project_id: 20, task_id: null } }), false, 'switching projects');
  assert.equal(startBlocked({ ...ready, active: { project_id: 20, task_id: null, recovered: true } }), true);
});

test('the request gate lets only one write through until it ends (fast double click)', () => {
  const gate = createRequestGate();
  assert.equal(gate.beginWrite(), true);
  assert.equal(gate.beginWrite(), false);
  gate.endWrite();
  assert.equal(gate.beginWrite(), true);
});
