import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesShortcut } from '../src/shortcut.ts';

test('matches only the chosen combination and ignores auto-repeat', () => {
  const event = { ctrlKey:true, shiftKey:true, altKey:false, metaKey:false, repeat:false, code:'Space' };
  assert.equal(matchesShortcut(event, 'Ctrl+Shift+Space'), true);
  assert.equal(matchesShortcut({ ...event, repeat:true }, 'Ctrl+Shift+Space'), false);
  assert.equal(matchesShortcut({ ...event, altKey:true }, 'Ctrl+Shift+Space'), false);
  assert.equal(matchesShortcut({ ...event, shiftKey:false, altKey:true, code:'KeyQ' }, 'Ctrl+Alt+Q'), true);
  assert.equal(matchesShortcut({ ...event, code:'F12' }, 'Ctrl+Shift+F12'), true);
  assert.equal(matchesShortcut(event, 'Ctrl+Shift+Unknown'), false);
});
