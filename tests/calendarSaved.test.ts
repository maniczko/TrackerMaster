import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALENDAR_STORAGE_KEY, readSavedState, save } from '../src/calendarSaved.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

test('calendar saved filters fail closed on corrupt JSON or malformed scope', () => {
  const storage = memoryStorage();
  assert.deepEqual(readSavedState(storage), { saved: {}, corrupt: false });

  storage.setItem(CALENDAR_STORAGE_KEY, '{broken');
  assert.deepEqual(readSavedState(storage), { saved: {}, corrupt: true });

  storage.setItem(CALENDAR_STORAGE_KEY, '[]');
  assert.deepEqual(readSavedState(storage), { saved: {}, corrupt: true });

  storage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify({ scope: { clientId: '1', projectId: null, taskId: null } }));
  assert.deepEqual(readSavedState(storage), { saved: {}, corrupt: true });

  storage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify({ scope: { clientId: null, projectId: 2, taskId: null } }));
  assert.deepEqual(readSavedState(storage), { saved: {}, corrupt: true });
});

test('calendar saved filters preserve week, month and valid scope together', () => {
  const storage = memoryStorage();
  save({ week: '2026-11-18', scope: { clientId: 1, projectId: 2, taskId: null }, billable: 'billable' }, storage);
  save({ month: '2026-11' }, storage);
  const read = readSavedState(storage);
  assert.equal(read.corrupt, false);
  assert.deepEqual(read.saved, {
    week: '2026-11-16',
    month: '2026-11',
    scope: { clientId: 1, projectId: 2, taskId: null },
    billable: 'billable',
  });
});
