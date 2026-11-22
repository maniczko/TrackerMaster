import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluralForm, sleepPeriodCount } from '../src/plural.ts';

test('Polish plural: 1 okres, 2–4 okresy, 5+ okresów, with the teens and 22–24 rule', () => {
  const form = (n: number) => pluralForm(n, 'okres', 'okresy', 'okresów');
  assert.equal(form(1), 'okres');
  for (const n of [2, 3, 4, 22, 23, 24, 32, 102, 1004]) assert.equal(form(n), 'okresy', String(n));
  for (const n of [0, 5, 6, 9, 10, 11, 12, 13, 14, 15, 20, 21, 25, 111, 112, 114, 1000]) assert.equal(form(n), 'okresów', String(n));
  assert.equal(sleepPeriodCount(1), '1 okres');
  assert.equal(sleepPeriodCount(2), '2 okresy');
  assert.equal(sleepPeriodCount(4), '4 okresy');
  assert.equal(sleepPeriodCount(5), '5 okresów');
  assert.equal(sleepPeriodCount(12), '12 okresów');
});

test('sleep and review texts use the plural helper and no gendered form', async () => {
  const { readFileSync } = await import('node:fs');
  const sleep = readFileSync(new URL('../src/SleepPending.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(sleep, /sleepPeriodCount\(items\.length\)/);
  assert.doesNotMatch(sleep, /'okres' : 'okresów'/);
  for (const source of [sleep, app]) assert.doesNotMatch(source, /skończyłeś|skończyłaś/);
});
