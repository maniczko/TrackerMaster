import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProposal, dropFields, keyFields, pointerMinute, proposalSeconds, snapMinute, wallAt } from '../src/calendarDrag.ts';
import type { DragEntry, DragPiece } from '../src/calendarDrag.ts';
import { draftRange } from '../src/entryDraft.ts';

// DEV-38. Synthetic data only; the reporting zone is Europe/Warsaw (CET = UTC+1, CEST = UTC+2).
const zone = 'Europe/Warsaw';
const at = (iso: string) => Date.parse(iso);
const nowMs = at('2026-11-25T12:00:00Z');
const entry = (start: string, end: string, id = 7): DragEntry => ({ id, startMs: at(start), endMs: at(end) });
const whole = (e: DragEntry, date: string): DragPiece => ({ date, startMs: e.startMs, endMs: e.endMs });
const check = (proposed: Parameters<typeof checkProposal>[0], e: DragEntry, others = [] as Parameters<typeof checkProposal>[4]) => checkProposal(proposed, e, zone, nowMs, others);

test('the grid is 15 minutes, rounded to the nearest line and kept within the day; 1440 is the next midnight', () => {
  assert.equal(snapMinute(10 * 60 + 7), 10 * 60);
  assert.equal(snapMinute(10 * 60 + 8), 10 * 60 + 15);
  assert.equal(snapMinute(-20), 0);
  assert.equal(snapMinute(1450), 1440);
  assert.equal(wallAt('2026-02-17', 1440), '2026-02-18T00:00:00');
  assert.equal(wallAt('2026-12-31', 1440), '2027-01-01T00:00:00');
  assert.equal(pointerMinute(-5, 960), 0);
  assert.equal(pointerMinute(480, 960), 720);
  assert.equal(pointerMinute(2000, 960), 1440);
});

test('AC1: 09:00–10:00 moved to 11:00 is 11:00–12:00, 3600 s, sent as the form would send it', () => {
  const e = entry('2026-02-17T08:00:00Z', '2026-02-17T09:00:00Z');
  const result = check(dropFields('move', e, whole(e, '2026-02-17'), { date: '2026-02-17', minute: 11 * 60 + 6 }, zone), e);
  assert.ok(result.ok && result.changed);
  assert.deepEqual(result.fields, { start: '2026-02-17T11:00:00', end: '2026-02-17T12:00:00' });
  assert.equal(proposalSeconds(result.startMs, result.endMs), 3600);
  assert.deepEqual(draftRange({ ...result.fields, description: '', inputTimeZone: zone }), { startedAt: '2026-02-17T10:00:00Z', endedAt: '2026-02-17T11:00:00Z' });
  // To another day: the same length, on that day.
  const other = check(dropFields('move', e, whole(e, '2026-02-17'), { date: '2026-02-19', minute: 14 * 60 }, zone), e);
  assert.ok(other.ok);
  assert.deepEqual(other.fields, { start: '2026-02-19T14:00:00', end: '2026-02-19T15:00:00' });
});

test('AC2: the end handle from 12:00 to 12:30 gives 5400 s and changes only the end', () => {
  const e = entry('2026-02-17T10:00:00Z', '2026-02-17T11:00:00Z');
  const result = check(dropFields('end', e, whole(e, '2026-02-17'), { date: '2026-02-17', minute: 12 * 60 + 29 }, zone), e);
  assert.ok(result.ok && result.changed);
  assert.deepEqual(result.fields, { start: '2026-02-17T11:00:00', end: '2026-02-17T12:30:00' });
  assert.equal(proposalSeconds(result.startMs, result.endMs), 5400);
  assert.equal(result.startMs, e.startMs);
  // The start handle changes only the start.
  const start = check(dropFields('start', e, whole(e, '2026-02-17'), { date: '2026-02-17', minute: 10 * 60 + 44 }, zone), e);
  assert.ok(start.ok);
  assert.deepEqual(start.fields, { start: '2026-02-17T10:45:00', end: '2026-02-17T12:00:00' });
  assert.equal(start.endMs, e.endMs);
});

test('seconds are never lost by the drag itself: the length stays exact and the untouched end is sent as shown', () => {
  // 09:00:07.000–10:00:52.400 = 3645 whole seconds.
  const e = entry('2026-02-17T08:00:07.000Z', '2026-02-17T09:00:52.400Z');
  const moved = check(dropFields('move', e, whole(e, '2026-02-17'), { date: '2026-02-17', minute: 11 * 60 }, zone), e);
  assert.ok(moved.ok);
  assert.deepEqual(moved.fields, { start: '2026-02-17T11:00:00', end: '2026-02-17T12:00:45' });
  assert.equal(proposalSeconds(moved.startMs, moved.endMs), proposalSeconds(e.startMs, e.endMs));
  assert.equal(moved.endMs - moved.startMs, e.endMs - e.startMs);
  // Resizing the start keeps the end as shown (10:00:52); the backend keeps its stored milliseconds (#58).
  const start = check(dropFields('start', e, whole(e, '2026-02-17'), { date: '2026-02-17', minute: 8 * 60 + 45 }, zone), e);
  assert.ok(start.ok);
  assert.equal(start.fields.end, '2026-02-17T10:00:52');
  // A press without a move, or a drop on the place it already has, changes nothing and saves nothing.
  const grid = entry('2026-02-17T08:00:00Z', '2026-02-17T09:00:00Z');
  const same = check(dropFields('move', grid, whole(grid, '2026-02-17'), { date: '2026-02-17', minute: 9 * 60 + 5 }, zone), grid);
  assert.ok(same.ok && !same.changed);
  // Keyboard keeps the seconds of the start too.
  const key = check(keyFields('later', e, zone), e);
  assert.ok(key.ok);
  assert.deepEqual(key.fields, { start: '2026-02-17T09:15:07', end: '2026-02-17T10:15:52' });
  assert.equal(proposalSeconds(key.startMs, key.endMs), 3645);
});

test('midnight: an end at 24:00 is the next day 00:00; a piece after midnight moves the whole entry', () => {
  const e = entry('2026-02-17T21:00:00Z', '2026-02-17T22:00:00Z'); // 22:00–23:00
  const end = check(dropFields('end', e, whole(e, '2026-02-17'), { date: '2026-02-17', minute: 1440 }, zone), e);
  assert.ok(end.ok);
  assert.deepEqual(end.fields, { start: '2026-02-17T22:00:00', end: '2026-02-18T00:00:00' });
  // 23:00–01:00 is two pieces; the piece of 18.02 (00:00–01:00) dropped at 01:00 moves the entry by one hour.
  const over = entry('2026-02-17T22:00:00Z', '2026-02-18T00:00:00Z');
  const piece = { date: '2026-02-18', startMs: at('2026-02-17T23:00:00Z'), endMs: over.endMs };
  const moved = check(dropFields('move', over, piece, { date: '2026-02-18', minute: 60 }, zone), over);
  assert.ok(moved.ok);
  assert.deepEqual(moved.fields, { start: '2026-02-18T00:00:00', end: '2026-02-18T02:00:00' });
});

test('DST 29.03.2026: 02:15 does not exist; a move keeps the real length over the change', () => {
  const e = entry('2026-03-28T08:00:00Z', '2026-03-28T09:00:00Z');
  const gap = check(dropFields('move', e, whole(e, '2026-03-28'), { date: '2026-03-29', minute: 2 * 60 + 15 }, zone), e);
  assert.ok(!gap.ok);
  assert.match(gap.problem.message, /02:15 w dniu 29\.03\.2026 nie istnieje/);
  // 01:30 CET + 1 h of real time = 03:30 CEST.
  const over = check(dropFields('move', e, whole(e, '2026-03-28'), { date: '2026-03-29', minute: 90 }, zone), e);
  assert.ok(over.ok);
  assert.deepEqual(over.fields, { start: '2026-03-29T01:30:00', end: '2026-03-29T03:30:00' });
  assert.equal(proposalSeconds(over.startMs, over.endMs), 3600);
  // One day later by keyboard: the same wall-clock start, the same real length.
  const key = check(keyFields('nextDay', entry('2026-03-28T00:30:00Z', '2026-03-28T01:30:00Z'), zone), entry('2026-03-28T00:30:00Z', '2026-03-28T01:30:00Z'));
  assert.ok(key.ok);
  assert.deepEqual(key.fields, { start: '2026-03-29T01:30:00', end: '2026-03-29T03:30:00' });
});

test('DST 25.10.2026: 02:30 occurs twice and is refused; the 25-hour day still moves by real time', () => {
  const e = entry('2026-10-24T08:00:00Z', '2026-10-24T09:00:00Z');
  const twice = check(dropFields('move', e, whole(e, '2026-10-24'), { date: '2026-10-25', minute: 2 * 60 + 30 }, zone), e);
  assert.ok(!twice.ok);
  assert.match(twice.problem.message, /02:30 w dniu 25\.10\.2026 występuje dwa razy/);
  const end = check(dropFields('end', e, whole(e, '2026-10-24'), { date: '2026-10-25', minute: 2 * 60 + 30 }, zone), e);
  assert.ok(!end.ok);
  assert.equal(end.problem.field, 'end');
  const fine = check(dropFields('move', e, whole(e, '2026-10-24'), { date: '2026-10-25', minute: 4 * 60 }, zone), e);
  assert.ok(fine.ok);
  assert.deepEqual(fine.fields, { start: '2026-10-25T04:00:00', end: '2026-10-25T05:00:00' });
});

test('the edit form rules decide: overlap (D10), the future and an end not after the start are refused', () => {
  const e = entry('2026-02-17T08:00:00Z', '2026-02-17T09:00:00Z');
  const others = [{ id: 8, startMs: at('2026-02-18T13:00:00Z'), endMs: at('2026-02-18T14:00:00Z'), label: 'wpis #8, 18.02.2026 14:00–15:00' }];
  const overlap = check(dropFields('move', e, whole(e, '2026-02-17'), { date: '2026-02-18', minute: 14 * 60 + 30 }, zone), e, others);
  assert.ok(!overlap.ok);
  assert.match(overlap.problem.message, /nakłada się na istniejący pomiar \(wpis #8/);
  // Touching is allowed (13:00–14:00 ends where #8 starts).
  assert.ok(check(dropFields('move', e, whole(e, '2026-02-17'), { date: '2026-02-18', minute: 13 * 60 }, zone), e, others).ok);
  // A running timer (open end) is an overlap too.
  const running = [{ id: 9, startMs: at('2026-02-17T12:00:00Z'), endMs: null, label: 'trwający pomiar od 13:00' }];
  assert.ok(!check(dropFields('move', e, whole(e, '2026-02-17'), { date: '2026-02-17', minute: 18 * 60 }, zone), e, running).ok);
  const future = check(dropFields('move', e, whole(e, '2026-02-17'), { date: '2026-11-25', minute: 13 * 60 }, zone), e);
  assert.ok(!future.ok);
  assert.equal(future.problem.message, 'Czas zakończenia nie może być w przyszłości.');
  const reversed = check(dropFields('start', e, whole(e, '2026-02-17'), { date: '2026-02-17', minute: 10 * 60 }, zone), e);
  assert.ok(!reversed.ok);
  assert.equal(reversed.problem.message, 'Koniec musi być późniejszy od początku.');
});

test('keyboard: Alt+arrows move by 15 minutes or a day, Alt+Shift+arrows change the end', () => {
  const e = entry('2026-02-17T08:00:00Z', '2026-02-17T09:00:00Z');
  const fields = (action: Parameters<typeof keyFields>[0]) => { const result = check(keyFields(action, e, zone), e); assert.ok(result.ok); return result.fields; };
  assert.deepEqual(fields('earlier'), { start: '2026-02-17T08:45:00', end: '2026-02-17T09:45:00' });
  assert.deepEqual(fields('later'), { start: '2026-02-17T09:15:00', end: '2026-02-17T10:15:00' });
  assert.deepEqual(fields('previousDay'), { start: '2026-02-16T09:00:00', end: '2026-02-16T10:00:00' });
  assert.deepEqual(fields('nextDay'), { start: '2026-02-18T09:00:00', end: '2026-02-18T10:00:00' });
  assert.deepEqual(fields('longer'), { start: '2026-02-17T09:00:00', end: '2026-02-17T10:15:00' });
  assert.deepEqual(fields('shorter'), { start: '2026-02-17T09:00:00', end: '2026-02-17T09:45:00' });
  // A 15-minute entry cannot be shortened to nothing.
  const short = entry('2026-02-17T08:00:00Z', '2026-02-17T08:15:00Z');
  assert.ok(!check(keyFields('shorter', short, zone), short).ok);
});

// Moving saves only through the DEV-26 correction service (no write command of its own, no direct time update).
test('calendarMove.ts writes only through the draft correction commands', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/calendarMove.ts', import.meta.url), 'utf8');
  const commands = [...source.matchAll(/invoke(?:<[^>]*>)?\('([\w]+)'/g)].map(match => match[1]).sort();
  assert.deepEqual([...new Set(commands)], ['apply_entry_draft', 'discard_entry_draft', 'get_entry_drafts', 'get_entry_edit_source', 'save_entry_draft']);
  assert.match(source, /kind: 'correction'/);
  const hook = readFileSync(new URL('../src/useCalendarMove.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(hook, /invoke\(/, 'the hook never writes by itself');
});

// Quiet Precision tokens only (UIQ-03/04), like calendar.css.
test('calendarMove.css has no raw colours, no own custom properties and token font sizes', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/calendarMove.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.doesNotMatch(css, /--[\w-]+\s*:/);
  for (const [, value] of css.matchAll(/font-size:\s*([^;]+);/g)) assert.match(value.trim(), /^var\(--text-(xs|sm|md|lg|xl)\)$/);
});

// E2E AC4 (run 45623333020): Alt+Shift+arrows move only the end by 15 minutes and keep its seconds and the start.
test('keyboard end step keeps the seconds of both ends', () => {
  const e = entry('2026-02-19T08:15:00Z', '2026-02-19T08:45:27Z');
  const longer = check(keyFields('longer', e, zone), e);
  assert.ok(longer.ok);
  assert.deepEqual(longer.fields, { start: '2026-02-19T09:15:00', end: '2026-02-19T10:00:27' });
  assert.equal(proposalSeconds(longer.startMs, longer.endMs), 2727);
});
