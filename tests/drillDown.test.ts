import test from 'node:test';
import assert from 'node:assert/strict';
import { drillBackLabel, projectDrillTarget, resolveDrillScope, summaryGroupDrillTarget } from '../src/drillDown.ts';
import type { ReportCatalog } from '../src/reportScope.ts';

const catalog: ReportCatalog = {
  clients: [
    { id: 1, name: 'Klient Alfa', archived: false },
    { id: 2, name: 'Klient Beta', archived: false },
  ],
  projects: [
    { id: 10, client_id: 1, name: 'Projekt A1', archived: false },
    { id: 20, client_id: 2, name: 'Projekt B1', archived: false },
  ],
  tasks: [
    { id: 100, project_id: 10, name: 'Analiza', archived: false },
    { id: 200, project_id: 20, name: 'Testy', archived: false },
  ],
};

test('DEV-34: resolves chart bar, project segment and client/project/task group drill targets', () => {
  const projectTarget = projectDrillTarget('10', '2026-02-01', '2026-02-28', catalog);
  assert.deepEqual(projectTarget, {
    from: '2026-02-01',
    through: '2026-02-28',
    clientId: 1,
    projectId: 10,
    taskId: null,
    sourceLabel: 'Projekt A1',
  });
  assert.equal(projectDrillTarget('unknown', '2026-02-01', '2026-02-28', catalog), null);

  assert.deepEqual(
    summaryGroupDrillTarget('client:1', 'Klient Alfa', '2026-02-01', '2026-02-28', catalog),
    { from: '2026-02-01', through: '2026-02-28', clientId: 1, projectId: null, taskId: null, sourceLabel: 'Klient Alfa' },
  );
  assert.deepEqual(
    summaryGroupDrillTarget('project:10', 'Projekt A1', '2026-02-01', '2026-02-28', catalog),
    { from: '2026-02-01', through: '2026-02-28', clientId: 1, projectId: 10, taskId: null, sourceLabel: 'Projekt A1' },
  );
  assert.deepEqual(
    summaryGroupDrillTarget('task:100', 'Analiza', '2026-02-01', '2026-02-28', catalog),
    { from: '2026-02-01', through: '2026-02-28', clientId: 1, projectId: 10, taskId: 100, sourceLabel: 'Analiza' },
  );
  assert.deepEqual(
    summaryGroupDrillTarget('task:none:10', 'Bez zadania', '2026-02-01', '2026-02-28', catalog),
    {
      from: '2026-02-01',
      through: '2026-02-28',
      clientId: 1,
      projectId: 10,
      taskId: null,
      unassignedTaskOnly: true,
      sourceLabel: 'Projekt A1 / Bez zadania',
    },
  );
  assert.equal(summaryGroupDrillTarget('client:unknown', 'Bez przypisania', '2026-02-01', '2026-02-28', catalog), null);
});

test('DEV-34 AC2: active client/project/task filters refuse drilling into hidden unrelated records', () => {
  const hiddenBeta = { clientId: 1, projectId: null, taskId: null };
  assert.deepEqual(
    resolveDrillScope(hiddenBeta, { clientId: 2, projectId: 20, taskId: null }, catalog),
    { allowed: false, scope: hiddenBeta, taskUnassignedOnly: false },
  );
  assert.deepEqual(
    resolveDrillScope(hiddenBeta, { clientId: 1, projectId: 10, taskId: null }, catalog),
    { allowed: true, scope: { clientId: 1, projectId: 10, taskId: null }, taskUnassignedOnly: false },
  );
  assert.deepEqual(
    resolveDrillScope(hiddenBeta, {}, catalog),
    { allowed: true, scope: hiddenBeta, taskUnassignedOnly: false },
  );

  // Clicking a parent client while locked on a specific project preserves the project filter (cannot widen).
  const lockedProject = { clientId: 1, projectId: 10, taskId: null };
  assert.deepEqual(
    resolveDrillScope(lockedProject, { clientId: 1, projectId: null, taskId: null }, catalog),
    { allowed: true, scope: { clientId: 1, projectId: 10, taskId: null }, taskUnassignedOnly: false },
  );
  assert.deepEqual(
    resolveDrillScope(lockedProject, { clientId: 1, projectId: 10, taskId: 100 }, catalog),
    { allowed: true, scope: { clientId: 1, projectId: 10, taskId: 100 }, taskUnassignedOnly: false },
  );

  // Locked task cannot jump to unassigned or another task.
  const lockedTask = { clientId: 1, projectId: 10, taskId: 100 };
  assert.deepEqual(
    resolveDrillScope(lockedTask, { clientId: 1, projectId: 10, taskId: null, unassignedTaskOnly: true }, catalog),
    { allowed: false, scope: lockedTask, taskUnassignedOnly: false },
  );

  assert.equal(drillBackLabel({ label: 'Podsumowanie raportu' }), '← Wstecz (Podsumowanie raportu)');
});
