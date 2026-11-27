import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function readPngSize(bytes: Buffer): { width: number; height: number } {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'invalid PNG signature');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('TECH-11: vector favicon and BrandMark match Quiet Precision Deep Teal geometry without raster fallbacks', () => {
  const svg = readFileSync('public/favicon.svg', 'utf8');
  assert.match(svg, /<svg[^>]+viewBox="0 0 32 32"/);
  assert.ok(!svg.includes('<image'), 'Master brand SVG must remain purely vector');
  assert.ok(svg.includes('#102b34') && svg.includes('#326e71') && svg.includes('#1bb5b2') && svg.includes('#f4f2ea'));

  const comp = readFileSync('src/BrandMark.tsx', 'utf8');
  assert.match(comp, /viewBox="0 0 32 32"/);
  assert.match(comp, /aria-hidden="true"/);

  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /favicon\.svg/);
});

test('TECH-11: icon.ico contains all 6 RGBA resolutions (16..256 px) and MSIX Store PNG assets match dimensions', () => {
  const ico = readFileSync('src-tauri/icons/icon.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  assert.equal(count, 6);

  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const width = ico[entry] || 256;
    const height = ico[entry + 1] || 256;
    const bpp = ico.readUInt16LE(entry + 6);
    const bytesInRes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(width, height, `ICO frame ${i} must be square`);
    assert.equal(bpp, 32, `ICO frame ${width}px must be 32-bit RGBA`);
    assert.ok(bytesInRes > 0 && offset + bytesInRes <= ico.length, `ICO frame ${width}px out of bounds`);
    sizes.push(width);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 256]);

  const expectedPngs: Array<[string, number]> = [
    ['src-tauri/icons/32x32.png', 32],
    ['src-tauri/icons/64x64.png', 64],
    ['src-tauri/icons/128x128.png', 128],
    ['src-tauri/icons/icon.png', 512],
    ['src-tauri/icons/Square44x44Logo.png', 44],
    ['src-tauri/icons/Square150x150Logo.png', 150],
    ['src-tauri/icons/StoreLogo.png', 50],
  ];
  for (const [path, dim] of expectedPngs) {
    const size = readPngSize(readFileSync(path));
    assert.deepEqual(size, { width: dim, height: dim }, `${path} must match ${dim}x${dim}`);
  }
});
