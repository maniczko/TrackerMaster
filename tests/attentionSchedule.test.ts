import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ATTENTION_SETTINGS,
  idlePromptText,
  longTimerReminderText,
  openIdleLabel,
  validateAttentionSettings,
  workWindowStatus,
} from '../src/attentionSchedule.ts';

test('workdays and DST transitions in Europe/Warsaw respect local clock hours (I20)', () => {
  // Saturday: off workday even at 10:00
  const sat = Date.parse('2026-11-28T09:00:00Z');
  assert.equal(workWindowStatus(DEFAULT_ATTENTION_SETTINGS, sat, 'Europe/Warsaw')?.inWorkHours, false);

  // Monday 10:00 CET (+1) -> in hours; Monday 17:00 CET -> out of hours [09:00, 17:00)
  const monIn = Date.parse('2026-11-30T08:30:00Z');
  const monOut = Date.parse('2026-11-30T16:00:00Z');
  assert.equal(workWindowStatus(DEFAULT_ATTENTION_SETTINGS, monIn, 'Europe/Warsaw')?.inWorkHours, true);
  assert.equal(workWindowStatus(DEFAULT_ATTENTION_SETTINGS, monOut, 'Europe/Warsaw')?.inWorkHours, false);

  // Spring forward 2026-03-29 (Sunday) with Sunday enabled and start at skipped 02:30 -> advances to 03:00 CEST (01:00Z)
  const springSettings = { ...DEFAULT_ATTENTION_SETTINGS, workdays: [7], workStart: '02:30', workEnd: '05:00' };
  const beforeSkipped = Date.parse('2026-03-29T00:59:59Z'); // 01:59:59 CET
  const afterSkipped = Date.parse('2026-03-29T01:00:00Z');  // 03:00:00 CEST
  assert.equal(workWindowStatus(springSettings, beforeSkipped, 'Europe/Warsaw')?.inWorkHours, false);
  assert.equal(workWindowStatus(springSettings, afterSkipped, 'Europe/Warsaw')?.inWorkHours, true);

  // Fall back 2026-10-25 (Sunday): window 09:00–17:00 is +1 CET -> 08:00Z..16:00Z
  const autumnSettings = { ...DEFAULT_ATTENTION_SETTINGS, workdays: [7] };
  assert.equal(workWindowStatus(autumnSettings, Date.parse('2026-10-25T07:59:00Z'), 'Europe/Warsaw')?.inWorkHours, false);
  assert.equal(workWindowStatus(autumnSettings, Date.parse('2026-10-25T08:00:00Z'), 'Europe/Warsaw')?.inWorkHours, true);
  assert.equal(workWindowStatus(autumnSettings, Date.parse('2026-10-25T15:59:00Z'), 'Europe/Warsaw')?.inWorkHours, true);
  assert.equal(workWindowStatus(autumnSettings, Date.parse('2026-10-25T16:00:00Z'), 'Europe/Warsaw')?.inWorkHours, false);
});

test('settings validation rejects invalid thresholds, empty workdays and inverted hours (I22)', () => {
  assert.equal(validateAttentionSettings(DEFAULT_ATTENTION_SETTINGS), null);
  assert.ok(validateAttentionSettings({ ...DEFAULT_ATTENTION_SETTINGS, idleThresholdMinutes: 7 }));
  assert.ok(validateAttentionSettings({ ...DEFAULT_ATTENTION_SETTINGS, workdays: [] }));
  assert.ok(validateAttentionSettings({ ...DEFAULT_ATTENTION_SETTINGS, workStart: '17:00', workEnd: '09:00' }));
  assert.ok(validateAttentionSettings({ ...DEFAULT_ATTENTION_SETTINGS, longTimerHours: 5 }));
});

test('idle and reminder Polish messages show exact wall time and duration', () => {
  const start = Date.parse('2026-11-25T09:02:00Z'); // 10:02 CET
  const end = start + 23 * 60_000;                  // 10:25 CET
  assert.equal(openIdleLabel(start, start + 10 * 60_000, 'Europe/Warsaw'), 'Bezczynność od 10:02 — 10 min czeka na decyzję');
  assert.equal(idlePromptText(start, end, 'Europe/Warsaw'), 'Nie było Cię 23 min (10:02–10:25). Co zrobić z tym czasem?');
  assert.match(longTimerReminderText(start, start + 4 * 3_600_000 + 300_000), /^Timer działa od 4 h 5 min \(04:05:00\)\.$/);
});
