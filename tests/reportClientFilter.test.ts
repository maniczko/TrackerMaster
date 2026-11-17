import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { filterByClient } from '../src/reportClientFilter.ts';

test('filters entries by the owning project even if a task is absent', () => {
  const projects = [{ id: 1, client_id: 10 }, { id: 2, client_id: 20 }];
  const entries = [{ id: 1, project_id: 1, task_id: null }, { id: 2, project_id: 2, task_id: 5 }];
  const active = { id: 3, project_id: 1, task_id: null };
  const result = filterByClient(entries, active, projects, '10');
  assert.deepEqual(result.entries.map(entry => entry.id), [1]);
  assert.equal(result.active?.id, 3);
  assert.equal(result.missingRelations, false);
});

test('warns about unresolved projects without hiding them from the unfiltered view', () => {
  const entries = [{ id: 1, project_id: 99 }];
  assert.equal(filterByClient(entries, null, [], '10').missingRelations, true);
  const unfiltered = filterByClient(entries, null, [], '');
  assert.equal(unfiltered.entries.length, 1);
  assert.equal(unfiltered.missingRelations, false);
});
