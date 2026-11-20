import assert from 'node:assert/strict';
import test from 'node:test';
import { clientLabels } from '../src/clientLabels.ts';

// PTT-22 / DEV-12: pickers must keep clients with identical display names
// distinguishable, while the stored client name stays unchanged.

test('unique client names are shown unchanged', () => {
  const labels = clientLabels([{ id: 1, name: 'Alfa' }, { id: 2, name: 'Beta' }]);
  assert.deepEqual([...labels], [['1', 'Alfa'], ['2', 'Beta']]);
});

test('identical names get a stable ID prefix, other clients stay unchanged', () => {
  const labels = clientLabels([{ id: 7, name: 'Kowalski' }, { id: 9, name: 'Kowalski' }, { id: 3, name: 'Nowak' }]);
  assert.equal(labels.get('7'), 'ID 7 · Kowalski');
  assert.equal(labels.get('9'), 'ID 9 · Kowalski');
  assert.equal(labels.get('3'), 'Nowak');
});

test('names differing only by case, outer whitespace or Unicode normalization are treated as identical', () => {
  const composed = 'Łódź';
  const decomposed = 'Łódź';
  assert.notEqual(composed, decomposed);
  const labels = clientLabels([
    { id: 1, name: composed },
    { id: 2, name: ` ${decomposed.toLocaleUpperCase('pl')} ` },
  ]);
  assert.equal(labels.get('1'), `ID 1 · ${composed}`);
  // The stored name is kept verbatim (including whitespace); only the prefix is added.
  assert.equal(labels.get('2'), `ID 2 ·  ${decomposed.toLocaleUpperCase('pl')} `);
});

test('a real name that looks like a generated label forces prefixes for every client', () => {
  const labels = clientLabels([
    { id: 1, name: 'Acme' },
    { id: 2, name: 'Acme' },
    { id: 3, name: 'ID 1 · Acme' },
  ]);
  const rendered = [...labels.values()];
  assert.equal(new Set(rendered.map(label => label.toLocaleLowerCase('pl'))).size, rendered.length);
  assert.equal(labels.get('3'), 'ID 3 · ID 1 · Acme');
});

test('string IDs are supported and the label map is keyed by String(id)', () => {
  const labels = clientLabels([{ id: 'a', name: 'X' }, { id: 'b', name: 'x' }]);
  assert.equal(labels.get('a'), 'ID a · X');
  assert.equal(labels.get('b'), 'ID b · x');
});

test('an empty client list gives an empty map', () => {
  assert.equal(clientLabels([]).size, 0);
});
