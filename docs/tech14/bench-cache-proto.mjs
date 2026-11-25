// TECH-14: what a persistent day-boundary cache in reportTime.calendarPieces would change.
// The application code is NOT modified: this script copies the report modules into a temporary folder
// next to itself, applies the 5-line change described in docs/TECH-14-HISTORY-SEARCH.md (§3.4), compares the
// results with the unmodified src/ modules (they must be identical) and removes the folder afterwards.
// Usage: node docs/tech14/bench-cache-proto.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildIndex, FIRST_DAY, measure, QUERIES, searchIndexed, synthesize, TODAY } from './searchBench.mjs';
import { makeReportView as current } from '../../src/reportView.ts';
import { allReportClients } from '../../src/reportScope.ts';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'src');
const work = join(here, `.proto-${process.pid}`);
mkdirSync(work);
try {
  for (const name of ['reportTime', 'reportView', 'reportClientFilter', 'sleepTime', 'reportCsv', 'reportScope']) cpSync(join(src, `${name}.ts`), join(work, `${name}.ts`));
  const file = join(work, 'reportTime.ts');
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const before = 'function calendarPieces(zone: string) {\n  type Slice = { until: number; date: string };\n  const cache = new Map<number, Slice[]>();';
  const after = 'type Slice = { until: number; date: string };\nconst persistentBuckets = new Map<string, Map<number, Slice[]>>();\nfunction calendarPieces(zone: string) {\n  let cache = persistentBuckets.get(zone);\n  if (!cache) persistentBuckets.set(zone, cache = new Map<number, Slice[]>());';
  if (!text.includes(before)) {
    if (text.includes('dayBoundaryCache')) {
      console.log('The persistent day-boundary cache is already in src/reportTime.ts (TECH-15). Measure it with docs/tech14/bench-report.mjs.');
      process.exitCode = 0;
    } else throw new Error('reportTime.calendarPieces changed; update the prototype patch.');
  }
  else {
  writeFileSync(file, text.replace(before, after).replace('const stored = cache.get(day);', 'const stored = cache!.get(day);').replace('cache.set(day, slices);', 'cache!.set(day, slices);'));
  const { makeReportView: cached } = await import(pathToFileURL(join(work, 'reportView.ts')).href);

  for (const count of [10_000, 50_000]) {
    const { catalog, data } = synthesize(count);
    const index = buildIndex(data, catalog);
    const t0 = performance.now();
    cached(data, catalog, allReportClients, FIRST_DAY, TODAY);
    const cold = performance.now() - t0;
    const full = measure(() => cached(data, catalog, allReportClients, FIRST_DAY, TODAY), { warmup: 1, runs: 5 });
    console.log(`\n## ${count} wpisów: trwała pamięć granic dnia (prototyp)`);
    console.log(`Pierwszy pełny raport (pamięć pusta): ${cold.toFixed(0)} ms; pełny raport, pamięć ciepła: ${full.median.toFixed(1)} / ${full.p95.toFixed(1)} ms.`);
    console.log('\n| Zapytanie | Wyniki | Suma (makeReportView), pamięć ciepła | Wynik = obecny kod |');
    console.log('|---|---:|---:|---|');
    for (const item of QUERIES) {
      const matched = searchIndexed(index, item.query);
      const input = { ...data, entries: matched };
      const timing = measure(() => cached(input, catalog, allReportClients, FIRST_DAY, TODAY), { warmup: 1, runs: 10 });
      const reference = current(input, catalog, allReportClients, FIRST_DAY, TODAY);
      const same = timing.value.liveSeconds === reference.liveSeconds && timing.value.pendingSeconds === reference.pendingSeconds &&
        JSON.stringify(timing.value.contributions) === JSON.stringify(reference.contributions) && JSON.stringify(timing.value.overlaps) === JSON.stringify(reference.overlaps);
      if (!same) throw new Error(`Prototype differs from the current report for ${item.id}`);
      console.log(`| \`${item.query}\` | ${matched.length} | ${timing.median.toFixed(2)} / ${timing.p95.toFixed(2)} | identyczny |`);
    }
  }
  console.log('\nCzasy: mediana / p95 w ms (Node).');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
