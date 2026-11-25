// TECH-14: the JavaScript variants inside Edge (Chromium, the same engine family as WebView2).
// Bundled and started by run-edge.mjs; writes the JSON result into <pre id="out">.
import { runJsBench } from './searchBench.mjs';

const out = document.getElementById('out');
try {
  const environment = { userAgent: navigator.userAgent, logicalCpus: navigator.hardwareConcurrency, measuredAt: new Date().toISOString() };
  const results = [10_000, 50_000].map(count => runJsBench(count, { warmup: 3, runs: 15, light: true }));
  out.textContent = JSON.stringify({ environment, results });
} catch (error) {
  out.textContent = JSON.stringify({ error: String(error?.stack ?? error) });
}
