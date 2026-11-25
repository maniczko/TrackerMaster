// TECH-15: report timing on the current src/ modules (run before and after a change to compare).
// Usage: node docs/tech14/bench-report.mjs
// Prints, for 10 000 and 50 000 synthetic entries: eight consecutive full-history reports in one process
// (the first one starts with an empty day-boundary cache), the last-30-days report, and makeReportView
// on the TECH-14 query results. Synthetic, deterministic data only.
import { buildIndex, FIRST_DAY, LAST_30, measure, QUERIES, searchIndexed, synthesize, TODAY } from './searchBench.mjs';
import { makeReportView } from '../../src/reportView.ts';
import { allReportClients } from '../../src/reportScope.ts';

for (const count of [10_000, 50_000]) {
  const { catalog, data } = synthesize(count);
  const index = buildIndex(data, catalog);
  const sequence = [];
  for (let i = 0; i < 8; i++) {
    const t0 = performance.now();
    makeReportView(data, catalog, allReportClients, FIRST_DAY, TODAY);
    sequence.push(Math.round(performance.now() - t0));
  }
  const month = measure(() => makeReportView(data, catalog, allReportClients, LAST_30.from, LAST_30.through), { warmup: 1, runs: 5 });
  console.log(`\n## ${count} wpisów`);
  console.log(`Cała historia, 8 kolejnych wywołań (ms): ${sequence.join(' / ')}`);
  console.log(`Ostatnie 30 dni: ${month.median.toFixed(1)} / ${month.p95.toFixed(1)} ms`);
  console.log('\n| Zapytanie | Wyniki | makeReportView na wynikach (mediana / p95 ms) |');
  console.log('|---|---:|---:|');
  for (const item of QUERIES) {
    const matched = searchIndexed(index, item.query);
    const input = { ...data, entries: matched };
    const timing = measure(() => makeReportView(input, catalog, allReportClients, FIRST_DAY, TODAY), { warmup: 1, runs: matched.length > 5000 ? 3 : 10 });
    console.log(`| \`${item.query}\` | ${matched.length} | ${timing.median.toFixed(2)} / ${timing.p95.toFixed(2)} |`);
  }
}
