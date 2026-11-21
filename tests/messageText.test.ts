import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentence } from '../src/messageText.ts';

test('adds a final period only when the text does not end a sentence', () => {
  assert.equal(sentence('Zakończenie nie może być w przyszłości.'), 'Zakończenie nie może być w przyszłości.');
  assert.equal(sentence('Nie udało się zapisać lub odczytać danych lokalnych'), 'Nie udało się zapisać lub odczytać danych lokalnych.');
  assert.equal(sentence('  Czy na pewno?  '), 'Czy na pewno?');
  assert.equal(sentence('Uwaga!'), 'Uwaga!');
  assert.equal(sentence('Trwa zapis…'), 'Trwa zapis…');
  assert.equal(sentence(''), '');
  assert.equal(sentence(new Error('Brak dostępu')), 'Error: Brak dostępu.');
});

test('composed operation errors never contain a double period', () => {
  for (const backend of ['Zakończenie nie może być w przyszłości.', 'Zakończenie nie może być w przyszłości', new Error('Dysk pełny.')]) {
    const message = `Nie udało się potwierdzić operacji: ${sentence(backend)} Sprawdź aktualny stan przed ponowieniem.`;
    assert.doesNotMatch(message, /\.\./);
    assert.match(message, /: .+[.] Sprawdź aktualny stan/);
  }
});
