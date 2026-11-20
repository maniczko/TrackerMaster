// UIQ-03/04/06/13: one Quiet Precision token set, WCAG AA contrast of token pairs and minimum font sizes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appCss = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
const miniCss = readFileSync(new URL('../src/miniTimer.css', import.meta.url), 'utf8');
const withoutComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

function rootBlock(css) {
  const start = css.indexOf(':root {');
  assert.ok(start >= 0, 'app.css must define the tokens in a :root block');
  const end = css.indexOf('\n}', start);
  return { block: css.slice(start, end), rest: css.slice(0, start) + css.slice(end) };
}
const { block: root, rest: appOutsideRoot } = rootBlock(withoutComments(appCss));
const tokens = new Map([...root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));

function resolve(name, seen = new Set()) {
  assert.ok(tokens.has(name), `Missing token ${name}`);
  assert.ok(!seen.has(name), `Token cycle at ${name}`);
  seen.add(name);
  const value = tokens.get(name);
  const reference = value.match(/^var\((--[\w-]+)\)$/);
  return reference ? resolve(reference[1], seen) : value;
}
function hex(name) {
  const value = resolve(name).toLowerCase();
  assert.match(value, /^#[0-9a-f]{6}$/, `${name} must resolve to a 6-digit hex colour`);
  return value;
}
function luminance(value) {
  const channels = [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
export function contrast(foreground, background) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test('brand palette matches Quiet Precision (D13-A)', () => {
  assert.equal(hex('--tm-midnight'), '#102b34');
  assert.equal(hex('--tm-deep-teal'), '#326e71');
  assert.equal(hex('--tm-teal-glint'), '#1bb5b2');
  assert.equal(hex('--tm-ivory'), '#f4f2ea');
  assert.equal(hex('--tm-canvas'), '#f6f7f4');
  assert.equal(hex('--color-accent'), '#326e71');
  assert.equal(hex('--color-text'), '#102b34');
  assert.equal(hex('--color-bg'), '#f6f7f4');
});

const surfaces = ['--color-bg', '--color-surface', '--color-surface-muted', '--color-accent-soft'];
const textPairs = [
  ...['--color-text', '--color-text-muted', '--color-accent-strong', '--color-accent']
    .flatMap(foreground => surfaces.map(background => [foreground, background])),
  ['--color-on-accent', '--color-accent'],
  ['--color-on-accent', '--color-accent-strong'],
  ['--color-on-accent', '--color-danger'],
  ['--color-on-accent', '--color-danger-strong'],
  ['--color-on-stop', '--color-stop'],
  ['--color-on-stop', '--color-stop-strong'],
  ['--color-success-text', '--color-success-bg'],
  ['--color-warning-text', '--color-warning-bg'],
  ['--color-error-text', '--color-error-bg'],
  ['--color-pending-text', '--color-pending-bg'],
  ['--color-text', '--color-pending-bg'],
];
// Control boundaries, focus indicator and meaningful non-text marks need 3:1 (WCAG 1.4.11).
const nonTextPairs = [
  ['--color-border-control', '--color-surface'],
  ['--color-border-control', '--color-bg'],
  ['--color-focus', '--color-surface'],
  ['--color-focus', '--color-bg'],
  ['--color-focus', '--color-surface-muted'],
  ['--color-focus', '--color-accent-soft'],
  ['--color-accent', '--color-surface'],
  ['--color-accent', '--color-bg'],
  ['--color-stop', '--color-surface'],
  ['--color-stop', '--color-bg'],
  ['--color-pending-border', '--color-pending-bg'],
  ['--color-pending-border', '--color-surface'],
  ['--color-error-text', '--color-error-bg'],
];

test('text token pairs meet WCAG AA 4.5:1', () => {
  const failures = textPairs.map(([fg, bg]) => [fg, bg, contrast(hex(fg), hex(bg))]).filter(([, , ratio]) => ratio < 4.5);
  assert.deepEqual(failures, []);
});

test('control, focus and icon token pairs meet WCAG AA 3:1', () => {
  const failures = nonTextPairs.map(([fg, bg]) => [fg, bg, contrast(hex(fg), hex(bg))]).filter(([, , ratio]) => ratio < 3);
  assert.deepEqual(failures, []);
});

test('report of measured pairs', () => {
  for (const [fg, bg] of [...textPairs, ...nonTextPairs]) {
    console.log(`${fg} on ${bg}: ${contrast(hex(fg), hex(bg)).toFixed(2)}:1`);
  }
});

test('Teal Glint is decoration only, never text', () => {
  assert.ok(contrast(hex('--tm-teal-glint'), hex('--color-surface')) < 4.5, 'Glint is not a text colour on light surfaces');
  for (const css of [appOutsideRoot, withoutComments(miniCss)]) {
    assert.doesNotMatch(css, /(?:^|[;{\s])color\s*:\s*var\(--(?:color-decor|tm-teal-glint)\)/);
  }
});

test('raw colours exist only in the :root token block; the mini timer has no palette of its own', () => {
  assert.deepEqual(appOutsideRoot.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
  const mini = withoutComments(miniCss);
  assert.deepEqual(mini.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
  assert.deepEqual(mini.match(/--[\w-]+\s*:/g) ?? [], [], 'miniTimer.css must not define its own custom properties');
  assert.deepEqual(appOutsideRoot.match(/--[\w-]+\s*:/g) ?? [], [], 'tokens are defined only in :root');
});

test('one offline font family', () => {
  assert.match(resolve('--font-sans'), /^'Segoe UI Variable Text', 'Segoe UI', system-ui/);
  assert.doesNotMatch(appCss + miniCss, /@import|@font-face|fonts\.googleapis|url\(/i, 'no font is loaded from the network or files');
  for (const css of [appOutsideRoot, withoutComments(miniCss)]) {
    for (const [, value] of css.matchAll(/font-family\s*:\s*([^;}]+)/g)) assert.equal(value.trim(), 'var(--font-sans)');
    for (const [, value] of css.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]+)/g)) {
      assert.ok(value.trim() === 'inherit' || value.includes('var(--font-sans)'), `font shorthand must use --font-sans: ${value}`);
    }
  }
});

test('font sizes are at least 12px (helper text) and controls at least 14px', () => {
  const px = value => {
    const tokenValue = value.match(/^var\((--[\w-]+)\)$/);
    const resolved = tokenValue ? resolve(tokenValue[1]) : value;
    const match = resolved.match(/^([\d.]+)(px|rem)$/);
    assert.ok(match, `Unsupported font size ${value}`);
    return Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
  };
  for (const [name, value] of tokens) if (name.startsWith('--text-')) assert.ok(px(value) >= 12, `${name} is below 12px`);
  assert.ok(px('var(--text-sm)') >= 14, 'control and label size must be at least 14px');
  const sizes = [];
  for (const css of [appOutsideRoot, withoutComments(miniCss)]) {
    for (const [, value] of css.matchAll(/font-size\s*:\s*([^;}]+)/g)) sizes.push(value.trim());
    for (const [, value] of css.matchAll(/(?:^|[;{\s])font\s*:\s*(?:\d{3}\s+)?(var\([^)]+\)|[\d.]+(?:px|rem))\//g)) sizes.push(value.trim());
  }
  // `font-size: 0` only hides the decorative pill label on narrow windows; the dot remains.
  const small = sizes.filter(value => value !== '0' && px(value) < 12);
  assert.deepEqual(small, []);
  assert.ok(sizes.length > 20, 'font sizes were found');
});

test('control sizing tokens follow UIQ-05', () => {
  assert.ok(parseFloat(resolve('--control-h')) >= 40);
  assert.ok(parseFloat(resolve('--control-h-sm')) >= 24);
  assert.match(miniCss, /\.qp-toggle \{ width: 48px; height: 48px; border-radius: 50%;/);
  for (const name of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8']) {
    assert.equal(parseFloat(resolve(name)) % 4, 0, `${name} is not on the 4px grid`);
  }
});
