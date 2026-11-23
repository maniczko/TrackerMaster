import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultEnd, formProblem, keyboardRange, minuteAt, overlapping, slotStart, wallInstant, wallValue } from '../src/calendarEntry.ts';
import type { FormInput } from '../src/calendarEntry.ts';
import { draftRange } from '../src/entryDraft.ts';

// DEV-26 (calendar package B). Synthetic data only; the reporting zone is Europe/Warsaw.
const zone = 'Europe/Warsaw';
const at = (iso: string) => Date.parse(iso);
const nowMs = at('2026-11-23T12:00:00Z');
const base = (patch: Partial<FormInput> = {}): FormInput => ({
  start: '2026-11-20T09:00:00', end: '2026-11-20T09:30:00', description: '', zone, nowMs,
  entryId: null, needsProject: true, projectId: 7, others: [], ...patch,
});

test('a click on an empty slot starts on the quarter-hour at or before it and ends 30 minutes later', () => {
  assert.equal(slotStart('2026-11-20', 9 * 60 + 14.9), '2026-11-20T09:00:00');
  assert.equal(slotStart('2026-11-20', 9 * 60 + 15), '2026-11-20T09:15:00');
  assert.equal(slotStart('2026-11-20', 0), '2026-11-20T00:00:00');
  assert.equal(slotStart('2026-11-20', 1439.9), '2026-11-20T23:45:00');
  assert.equal(slotStart('2026-11-20', -3), '2026-11-20T00:00:00');
  assert.equal(defaultEnd('2026-11-20T09:15:00', zone), '2026-11-20T09:45:00');
  // 40 px per hour: 9:20 is 373.3 px into a 960 px column.
  assert.equal(slotStart('2026-11-20', minuteAt(9 * 40 + 13.3, 960)!), '2026-11-20T09:15:00');
  assert.equal(minuteAt(-1, 960), null);
  assert.equal(minuteAt(960, 960), null);
  assert.equal(minuteAt(10, 0), null);
});

test('midnight: a slot at 23:45 ends at 00:15 of the next day and is one 30-minute entry', () => {
  const start = slotStart('2026-11-20', 23 * 60 + 50);
  const end = defaultEnd(start, zone);
  assert.deepEqual([start, end], ['2026-11-20T23:45:00', '2026-11-21T00:15:00']);
  assert.equal(formProblem(base({ start, end })), null);
  assert.deepEqual(draftRange({ start, end, description: '', inputTimeZone: zone }),
    { startedAt: '2026-11-20T22:45:00Z', endedAt: '2026-11-20T23:15:00Z' });
});

test('DST 29.03.2026: 02:00–03:00 does not exist; the form names it and the default end counts real time', () => {
  for (const minute of [120, 135, 165]) {
    const start = slotStart('2026-03-29', minute);
    assert.deepEqual(wallInstant(start, zone), { problem: 'nonexistent' });
    const problem = formProblem(base({ start, end: '2026-03-29T03:30:00' }));
    assert.equal(problem?.field, 'start');
    assert.match(problem!.message, /^Rozpoczęcie: godzina 02:\d\d w dniu 29\.03\.2026 nie istnieje \(zmiana czasu na letni\)/);
  }
  // 01:45 CET + 30 min = 03:15 CEST (30 minutes of work, not 1 h 30 min).
  assert.equal(defaultEnd('2026-03-29T01:45:00', zone), '2026-03-29T03:15:00');
  assert.equal(formProblem(base({ start: '2026-03-29T01:45:00', end: '2026-03-29T03:15:00' })), null);
  assert.deepEqual(draftRange({ start: '2026-03-29T01:45:00', end: '2026-03-29T03:15:00', description: '', inputTimeZone: zone }),
    { startedAt: '2026-03-29T00:45:00Z', endedAt: '2026-03-29T01:15:00Z' });
  assert.match(formProblem(base({ start: '2026-03-29T01:30:00', end: '2026-03-29T02:30:00' }))!.message, /^Zakończenie: godzina 02:30 .* nie istnieje/);
});

test('DST 25.10.2026: 02:00–03:00 happens twice; the form refuses to guess which one', () => {
  assert.deepEqual(wallInstant('2026-10-25T02:15:00', zone), { problem: 'ambiguous' });
  assert.deepEqual(wallInstant('2026-10-25T01:59:59', zone), { ms: at('2026-10-24T23:59:59Z') });
  assert.deepEqual(wallInstant('2026-10-25T03:00:00', zone), { ms: at('2026-10-25T02:00:00Z') });
  const problem = formProblem(base({ start: '2026-10-25T02:15:00', end: '2026-10-25T03:30:00' }));
  assert.equal(problem?.field, 'start');
  assert.match(problem!.message, /godzina 02:15 w dniu 25\.10\.2026 występuje dwa razy \(zmiana czasu na zimowy\)/);
  // 01:45 CEST + 30 min = 02:15 CEST, a repeated wall time: the end is named, nothing is saved by guess.
  assert.equal(defaultEnd('2026-10-25T01:45:00', zone), '2026-10-25T02:15:00');
  assert.equal(formProblem(base({ start: '2026-10-25T01:45:00', end: defaultEnd('2026-10-25T01:45:00', zone) }))?.field, 'end');
  // The whole 25-hour day around the change is fine when both ends are unique.
  assert.equal(formProblem(base({ start: '2026-10-25T01:30:00', end: '2026-10-25T03:30:00' })), null);
  assert.throws(() => draftRange({ start: '2026-10-25T02:15:00', end: '2026-10-25T03:30:00', description: '', inputTimeZone: zone }));
});

test('validation: missing or malformed times, end not after start, future, project and description length', () => {
  assert.deepEqual(formProblem(base({ start: '' })), { field: 'start', message: 'Podaj datę i godzinę: rozpoczęcie.' });
  assert.equal(formProblem(base({ end: '2026-11-20' }))?.message, 'Zakończenie: sprawdź datę i godzinę.');
  assert.equal(formProblem(base({ start: '2026-02-30T09:00:00' }))?.message, 'Rozpoczęcie: sprawdź datę i godzinę.');
  assert.deepEqual(formProblem(base({ end: '2026-11-20T09:00:00' })), { field: 'end', message: 'Koniec musi być późniejszy od początku.' });
  assert.deepEqual(formProblem(base({ end: '2026-11-20T08:59:00' })), { field: 'end', message: 'Koniec musi być późniejszy od początku.' });
  assert.deepEqual(formProblem(base({ start: '2026-11-23T12:45:00', end: '2026-11-23T13:15:00' })),
    { field: 'end', message: 'Czas zakończenia nie może być w przyszłości.' });
  // Ending exactly now is allowed (the backend refuses only end > now).
  assert.equal(formProblem(base({ start: '2026-11-23T12:30:00', end: '2026-11-23T13:00:00' })), null);
  assert.deepEqual(formProblem(base({ projectId: null })), { field: 'project', message: 'Wybierz klienta i projekt.' });
  assert.equal(formProblem(base({ projectId: null, needsProject: false })), null);
  assert.equal(formProblem(base({ description: 'ż'.repeat(2000) })), null);
  assert.equal(formProblem(base({ description: 'ż'.repeat(2001) }))?.field, 'description');
});

test('overlap follows ensure_no_overlap: touching is fine, the edited entry and zero-length entries are ignored, a running timer is open-ended', () => {
  const others = [
    { id: 1, startMs: at('2026-11-20T08:00:00Z'), endMs: at('2026-11-20T08:30:00Z'), label: 'wpis #1, 20.11.2026 09:00–09:30' },
    { id: 2, startMs: at('2026-11-20T10:00:00Z'), endMs: at('2026-11-20T10:00:00Z'), label: 'wpis #2' },
    { id: 3, startMs: at('2026-11-23T11:00:00Z'), endMs: null, label: 'trwający pomiar od 12:00' },
  ];
  assert.equal(formProblem(base({ others, start: '2026-11-20T09:30:00', end: '2026-11-20T10:00:00' })), null);
  assert.equal(formProblem(base({ others, start: '2026-11-20T08:30:00', end: '2026-11-20T09:00:00' })), null);
  assert.deepEqual(formProblem(base({ others, start: '2026-11-20T09:15:00', end: '2026-11-20T09:45:00' })), {
    field: 'start', message: 'Ten czas nakłada się na istniejący pomiar (wpis #1, 20.11.2026 09:00–09:30). Popraw godziny przed zapisaniem.' });
  // Editing entry #1 itself, the same range is no overlap.
  assert.equal(formProblem(base({ others, entryId: 1, needsProject: false, projectId: null, start: '2026-11-20T09:00:00', end: '2026-11-20T09:45:00' })), null);
  assert.equal(overlapping(at('2026-11-20T09:55:00Z'), at('2026-11-20T10:05:00Z'), others, null), null);
  assert.equal(overlapping(at('2026-11-23T10:00:00Z'), at('2026-11-23T11:30:00Z'), others, null)?.id, 3);
  assert.equal(overlapping(at('2026-11-23T10:00:00Z'), at('2026-11-23T11:00:00Z'), others, null), null);
});

test('keyboard "+ Wpis": the last full half hour of today, or 09:00 on Monday of another week', () => {
  assert.deepEqual(keyboardRange('2026-11-23', '2026-11-23', at('2026-11-23T12:07:00Z'), zone), { start: '2026-11-23T12:30:00', end: '2026-11-23T13:00:00' });
  assert.equal(formProblem(base({ ...keyboardRange('2026-11-23', '2026-11-23', at('2026-11-23T12:07:00Z'), zone), nowMs: at('2026-11-23T12:07:00Z') })), null);
  assert.deepEqual(keyboardRange('2026-03-23', '2026-11-23', nowMs, zone), { start: '2026-03-23T09:00:00', end: '2026-03-23T09:30:00' });
  assert.equal(wallValue(at('2026-03-29T01:00:00Z'), zone), '2026-03-29T03:00:00');
});
