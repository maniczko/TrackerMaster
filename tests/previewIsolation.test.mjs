// The browser UI preview (npm run preview:ui) uses a mocked backend. It must never
// reach the application build: no app code may import it and the Tauri build config
// must not alias the real API to the mocks.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = path => readFileSync(path, 'utf8');
const files = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

test('application sources never import the preview mocks', () => {
  for (const file of files('src')) {
    assert.doesNotMatch(read(file), /preview\/|mockCore|mockEvent|mockWindow/, `${file} references the preview mocks`);
  }
});

test('the application build config does not alias Tauri APIs to mocks', () => {
  const config = read('vite.config.ts');
  assert.doesNotMatch(config, /preview|mock/i);
  assert.doesNotMatch(read('index.html'), /preview/i);
});

test('the preview config replaces every Tauri API module the app uses', () => {
  const config = read('vite.preview.config.ts');
  const used = new Set(files('src').flatMap(file => [...read(file).matchAll(/from '(@tauri-apps\/[^']+)'/g)].map(match => match[1])));
  assert.ok(used.size > 0);
  for (const module of used) assert.ok(config.includes(`'${module}'`), `preview does not mock ${module}`);
});

test('a production bundle, when present, contains no preview code', { skip: !existsSync('dist') }, () => {
  for (const file of files('dist').filter(path => /\.(js|html)$/.test(path))) {
    assert.doesNotMatch(read(file), /PREVIEW ONLY|tm-preview-widget|\[podgląd\]/, `${file} contains preview code`);
  }
});
