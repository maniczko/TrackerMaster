import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftRange, mergeDraftFields, sourceFields } from '../src/entryDraft.ts';
import type { DraftFields, DraftSource } from '../src/entryDraft.ts';
import { createDraftSort } from '../src/draftSort.ts';
import type { DraftSort, DraftSortState } from '../src/draftSort.ts';

const source: DraftSource = {
  databaseId: 'db', entryId: 10, clientId: 1, projectId: 2, taskId: null,
  startedAt: '2026-01-01T09:00:00.000Z', endedAt: '2026-01-01T10:00:00.000Z', durationSeconds: 3600,
  description: 'Current', billable: false, timeRevision: 2, descriptionRevision: 3, billingRevision: 4,
};

test('resolves edits using the time zone recorded in the draft', () => {
  const fields = sourceFields(source, 'Europe/Warsaw');
  assert.equal(fields.start, '2026-01-01T10:00:00');
  assert.deepEqual(draftRange({ ...fields, end: '2026-01-01T11:30' }), {
    startedAt: '2026-01-01T09:00:00Z', endedAt: '2026-01-01T10:30:00Z',
  });
  assert.throws(() => draftRange({ ...fields, end: '2026-03-29T02:30' }), /Sprawdź daty/);
  assert.throws(() => draftRange({ ...fields, end: '2026-10-25T02:30' }), /Sprawdź daty/);
  assert.throws(() => draftRange({ ...fields, end: '' }), /Sprawdź daty/);
});

test('copies only the selected fields from an older draft', () => {
  const current = sourceFields(source, 'Europe/Warsaw');
  const recovered: DraftFields = { ...current, end: '2026-01-01T11:30', description: 'Recovered' };
  assert.deepEqual(mergeDraftFields(current, recovered, ['description']), { ...current, description: 'Recovered' });
  assert.equal(current.description, 'Current');
  assert.equal(recovered.end, '2026-01-01T11:30');
});

test('coalesces sort changes while a previous preference is being written', async () => {
  const writes: DraftSort[] = [];
  const states: DraftSortState[] = [];
  const completions: (() => void)[] = [];
  const sort = createDraftSort(order => {
    writes.push(order);
    return new Promise<void>(resolve => completions.push(resolve));
  }, state => states.push(state));
  const first = sort.choose('oldest');
  await Promise.resolve();
  const last = sort.choose('newest');
  assert.deepEqual(writes, ['oldest']);
  assert.equal(states.at(-1)?.order, 'newest');
  completions.shift()?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['oldest', 'newest']);
  completions.shift()?.();
  await Promise.all([first, last]);
  assert.deepEqual(states.at(-1), { order: 'newest', writing: false, failed: false });
});

test('manual sort retry does not postpone or trigger automatic retry', async () => {
  let time = 0;
  let attempts = 0;
  let writable = false;
  const states: DraftSortState[] = [];
  const sort = createDraftSort(async () => {
    attempts++;
    if (!writable) throw new Error('unavailable');
  }, state => states.push(state), () => time);

  await sort.choose('oldest');
  await sort.enterList();
  assert.equal(attempts, 2);
  time = 9 * 60_000;
  await sort.retry();
  await sort.enterList();
  assert.equal(attempts, 3);
  assert.deepEqual(states.at(-1), { order: 'oldest', writing: false, failed: true });
  writable = true;
  time = 10 * 60_000;
  await sort.enterList();
  await sort.enterList();
  assert.equal(attempts, 4);
  assert.deepEqual(states.at(-1), { order: 'oldest', writing: false, failed: false });
});
