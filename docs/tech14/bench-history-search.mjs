// DEV-41: timing of the history search model (src/historySearch.ts) for AC3.
// Usage: node docs/tech14/bench-history-search.mjs
// Per keystroke: matchEntries + searchSummary. Per report read: buildSearchIndex. Per read and range: searchBase.
// Synthetic, deterministic data (docs/tech14/searchBench.mjs). Also checks AC2 for every query.
import { FIRST_DAY, LAST_30, measure, QUERIES, synthesize, TODAY } from './searchBench.mjs';
import { buildSearchIndex, matchEntries, searchBase, searchSummary, searchTerms } from '../../src/historySearch.ts';
import { makeReportView } from '../../src/reportView.ts';
import { allReportClients } from '../../src/reportScope.ts';

const fmt = timing => `${timing.median.toFixed(2)} / ${timing.p95.toFixed(2)}`;
for (const count of [10_000, 50_000]) {
  const { catalog, data } = synthesize(count);
  const index = measure(() => buildSearchIndex(data, catalog), { warmup: 1, runs: 5 });
  const firstBaseStart = performance.now();
  searchBase(data, catalog, FIRST_DAY, TODAY);
  const firstBaseMs = performance.now() - firstBaseStart;
  const base = measure(() => searchBase(data, catalog, FIRST_DAY, TODAY), { warmup: 0, runs: 3 });
  const month = measure(() => searchBase(data, catalog, LAST_30.from, LAST_30.through), { warmup: 0, runs: 3 });
  console.log(`\n## ${count} wpisów`);
  console.log(`buildSearchIndex: ${fmt(index)} ms. searchBase, cała historia: 1. wywołanie ${firstBaseMs.toFixed(0)} ms, kolejne ${fmt(base)} ms; ostatnie 30 dni ${fmt(month)} ms.`);
  console.log('\n| Zapytanie | Wyniki | Na znak: matchEntries + searchSummary (mediana / p95 ms) | AC2 |');
  console.log('|---|---:|---:|---|');
  for (const item of [...QUERIES, { id: 'spotkanie-30d', query: 'spotkanie', range: LAST_30 }]) {
    const chosen = item.range ? month.value : base.value;
    const keystroke = measure(() => searchSummary(chosen, matchEntries(index.value, searchTerms(item.query))), { warmup: 3, runs: 15 });
    const summary = keystroke.value;
    const reference = makeReportView({ ...data, entries: summary.entries }, catalog, allReportClients, chosen.from, chosen.through);
    if (reference.liveSeconds !== summary.seconds || reference.pendingSeconds !== summary.pendingSeconds) throw new Error(`AC2 mismatch for ${item.id}`);
    console.log(`| \`${item.query}\`${item.range ? ' (30 dni)' : ''} | ${summary.entries.length} | ${fmt(keystroke)} | równe |`);
  }
}
