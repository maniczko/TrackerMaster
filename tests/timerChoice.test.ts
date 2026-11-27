import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../src/App.tsx';
import { ACTION_SETTLE_MS, choicesFor, createActionSettle, createRequestGate, recentChoices } from '../src/miniTimerModel.ts';
import { mainAction, quickRecentBlocked, selectionFor, selectionKey, startBlocked } from '../src/timerChoice.ts';

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

test('UIQ-01: the main action sits under the clock; description and Switch come before the picker results', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  const clock = app.indexOf('<div className="clock" aria-live="off">');
  const main = app.indexOf('className={`actions timer-main ');
  const setup = app.indexOf('<div className="timer-setup">');
  assert.ok(clock > 0 && clock < main && main < setup, 'Start/Stop must be one control under the clock, outside the setup column');
  assert.equal(app.match(/actions timer-main /g)?.length, 1, 'one main action');
  const bar = app.indexOf('<div className="timer-bar">');
  const switcher = app.indexOf('className="actions timer-start timer-switch"');
  assert.ok(setup < bar && bar < switcher && switcher < app.indexOf('<div className="timer-picker">'),
    'Switch must not sit under the results list');
  assert.match(app, /\{data\.active && <div className="actions timer-start timer-switch"><button type="button" className="secondary"/,
    'next to the description there is only the secondary Switch, while a timer runs');
  // Package 3: five or six choices visible at 1280×720 (rows of 49 px), clear of the scrollbar.
  assert.match(css, /\.timer-picker \.qp-results \{ max-height: 288px; padding-right: var\(--space-1\); \}/);
});

test('main action: Stop while running, Start with a project, otherwise it leads to the project search', () => {
  const base = { busy: false, loaded: true, projectId: '', taskId: '', active: null };
  assert.deepEqual(mainAction(base), { kind: 'choose', disabled: false }, 'no disabled Start without an explanation');
  assert.deepEqual(mainAction({ ...base, busy: true }), { kind: 'choose', disabled: true });
  assert.deepEqual(mainAction({ ...base, loaded: false }), { kind: 'choose', disabled: true });
  assert.deepEqual(mainAction({ ...base, projectId: '10' }), { kind: 'start', disabled: false });
  assert.deepEqual(mainAction({ ...base, projectId: '10', project: { id: 10, archived: true } }), { kind: 'start', disabled: true }, 'startBlocked still applies');
  const running = { project_id: 10, task_id: null };
  assert.deepEqual(mainAction({ ...base, projectId: '10', active: running }), { kind: 'stop', disabled: false });
  assert.deepEqual(mainAction({ ...base, active: running }), { kind: 'stop', disabled: false });
  assert.deepEqual(mainAction({ ...base, active: { ...running, recovered: true } }), { kind: 'stop', disabled: true }, 'a recovered timer needs its end time');
  assert.deepEqual(mainAction({ ...base, busy: true, active: running }), { kind: 'stop', disabled: true });
});

test('double click on the main action does nothing in either direction (Stop → Start, Start → Stop), counted from the end of the write', async () => {
  // Stop → quick Start: the Stop write ends at 80 ms and the button is "Rozpocznij" again; the second click lands at 150 ms.
  const stop = createActionSettle();
  assert.equal(stop.allows(1_000), true);
  stop.mark(1_000);                         // click: Stop
  stop.mark(1_080);                         // the write ended, the button now says Rozpocznij
  assert.equal(stop.allows(1_150), false, 'the second click of a double click on Stop must not start a timer');
  assert.equal(stop.allows(1_080 + ACTION_SETTLE_MS - 1), false, 'the quiet period runs from the end of the write');
  assert.equal(stop.allows(1_080 + ACTION_SETTLE_MS), true, 'a deliberate Start later works');
  // A slow write: the quiet period still starts when it ends, not at the click.
  const slow = createActionSettle();
  slow.mark(0); slow.mark(2_000);
  assert.equal(slow.allows(ACTION_SETTLE_MS + 10), false);
  assert.equal(slow.allows(2_000 + ACTION_SETTLE_MS), true);
  // Start → quick Stop, the same rule.
  const start = createActionSettle();
  start.mark(5_000); start.mark(5_060);
  assert.equal(start.allows(5_200), false, 'the second click of a double click on Start must not stop the new timer');
  // The start itself is also guarded by the write gate: a synchronous second click sends nothing.
  const gate = createRequestGate();
  assert.equal(gate.beginWrite(), true);
  assert.equal(gate.beginWrite(), false);
  // Wiring: both windows check and mark the guard for every action that changes meaning in place.
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const widget = readFileSync(new URL('../src/Widget.tsx', import.meta.url), 'utf8');
  const run = app.match(/function runMainAction\(\) \{([\s\S]*?)\r?\n  \}\r?\n/);
  assert.ok(run, 'App must define runMainAction()');
  const body = run[1];
  assert.ok(body.indexOf('mainSettle.allows(Date.now())') < body.indexOf("invoke('stop_timer'") && body.indexOf('mainSettle.allows(Date.now())') < body.indexOf('startTimer()'),
    'Stop and Start are both behind the guard');
  assert.match(body, /'Pomiar zatrzymany\.'\)\.finally\(settled\)/, 'Stop marks the guard when its write ends');
  assert.match(body, /startTimer\(\)\.finally\(settled\)/, 'Start marks the guard when its write ends');
  assert.equal(widget.match(/settle\.allows\(Date\.now\(\)\)/g)?.length, 2, 'the round toggle (and shortcut) and quick switching are guarded');
  assert.equal(widget.match(/\.finally\(\(\) => settle\.mark\(Date\.now\(\)\)\)/g)?.length, 2);
});

test('DEV-16 quickRecentBlocked skips archived entries and blocks restarting the active task', () => {
  const activeTask = choices.find(choice => choice.key === 'task:100')!;
  const projectOnly = choices.find(choice => choice.key === 'project:10')!;
  assert.equal(quickRecentBlocked(activeTask, { busy: false, loaded: true, active: null }), false);
  assert.equal(quickRecentBlocked(activeTask, { busy: true, loaded: true, active: null }), true);
  assert.equal(quickRecentBlocked(activeTask, { busy: false, loaded: false, active: null }), true);
  assert.equal(quickRecentBlocked(activeTask, { busy: false, loaded: true, active: { project_id: 10, task_id: 100 } }), true);
  assert.equal(quickRecentBlocked(projectOnly, { busy: false, loaded: true, active: { project_id: 10, task_id: 100 } }), false);
  assert.equal(quickRecentBlocked(activeTask, { busy: false, loaded: true, active: { project_id: 10, task_id: null, recovered: true } }), true);
  const archivedTask = { ...activeTask, task: { id: 101, project_id: 10, name: 'Zamknięte', archived: true } };
  assert.equal(quickRecentBlocked(archivedTask, { busy: false, loaded: true, active: null }), true);
});
