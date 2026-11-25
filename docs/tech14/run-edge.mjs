// TECH-14: bundle bench-browser.mjs with esbuild (already a Vite dependency) and run it in headless Edge.
// Usage: node docs/tech14/run-edge.mjs [outDir]
// Needs Microsoft Edge in the default location (or EDGE_PATH). Prints Markdown tables, writes JSON to outDir.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatJsResult } from './searchBench.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? tmpdir();
const edge = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const work = mkdtempSync(join(tmpdir(), 'tech14-edge-'));
try {
  const bundle = await build({ entryPoints: [join(here, 'bench-browser.mjs')], bundle: true, format: 'iife', write: false, target: 'es2022' });
  const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const page = join(work, 'bench.html');
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>TECH-14</title><pre id="out">running</pre><script>${script}</script>`);
  const dom = execFileSync(edge, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(work, 'profile')}`, '--dump-dom', pathToFileURL(page).href],
    { encoding: 'utf8', timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  const text = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)?.[1];
  if (!text) throw new Error('No result in the page.');
  const result = JSON.parse(text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  if (result.error) throw new Error(result.error);
  writeFileSync(join(outDir, 'tech14-edge.json'), JSON.stringify(result, null, 2));
  console.log('Environment', JSON.stringify(result.environment));
  for (const js of result.results) {
    console.log(`\n## Edge: ${js.count} wpisów`);
    console.log(formatJsResult(js));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
