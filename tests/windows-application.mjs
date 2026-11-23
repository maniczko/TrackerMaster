import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, openSync, watch, writeSync } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, statfs, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// Registry settings are temporary, scoped to the test executable on a disposable runner.
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.ok(process.env.RUNNER_TEMP && process.env.APPDATA);
const exe = resolve('src-tauri/target/release/tracker-master.exe');
const testDb = join(process.env.APPDATA, 'pl.tracker.personal.testonly', 'tracker.sqlite3');
const normalDb = join(process.env.APPDATA, 'pl.tracker.personal', 'tracker.sqlite3');
await access(exe);
await assert.rejects(stat(testDb), { code: 'ENOENT' });
await assert.rejects(stat(normalDb), { code: 'ENOENT' });

const temp = await mkdtemp(join(process.env.RUNNER_TEMP, 'TrackerMaster-WebView-'));
const csvDirectory = await mkdtemp(join(temp, 'download-'));
const csvEvents = [];
const csvWatcher = watch(csvDirectory, (event, filename) => {
  csvEvents.push({ at: new Date().toISOString(), event, filename: filename?.toString() ?? null });
});
const csvSnapshot = async () => {
  try { return await readdir(csvDirectory); }
  catch (error) { return { error: error.code ?? error.message }; }
};
// UIQ-01/08 layout evidence: screenshots are uploaded as a CI artifact. These helpers only observe the app.
const screenshotDirectory = resolve('test-results', 'ui-screenshots');
await mkdir(screenshotDirectory, { recursive: true });
async function saveScreenshot(cdp, sessionId, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  await writeFile(join(screenshotDirectory, `${name}.png`), Buffer.from(data, 'base64'));
}
const inspectMainLayout = `(() => {
  const root = document.documentElement;
  const timer = document.querySelector('[aria-label="Pomiar czasu"]');
  const action = timer?.querySelector('.timer-stop button') ?? timer?.querySelector('.timer-start button');
  const box = action?.getBoundingClientRect();
  const area = element => { const rect = element?.getBoundingClientRect(); return rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom) } : null; };
  return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, scrollY: window.scrollY,
    card: area(timer), clock: area(timer?.querySelector('.clock')),
    action: box ? { text: action.textContent.trim(), top: Math.round(box.top), bottom: Math.round(box.bottom),
      left: Math.round(box.left), right: Math.round(box.right), height: Math.round(box.height) } : null };
})()`;
// UIQ-05 / WCAG 2.5.8: the project search is a 40 px field and every checkbox in the timer card has a target of
// at least 24×24 (the control or the label that wraps it). Collapsed settings are opened only for the measurement.
const inspectControlSizes = `(() => {
  const timer = document.querySelector('[aria-label="Pomiar czasu"]');
  const closed = [...(timer?.querySelectorAll('details:not([open])') ?? [])];
  closed.forEach(item => { item.open = true; });
  try {
    const size = element => { const rect = element.getBoundingClientRect(); return { width: Math.round(rect.width), height: Math.round(rect.height) }; };
    const frame = timer?.querySelector('.timer-picker .qp-search');
    const field = frame?.querySelector('input');
    const checkboxes = [...(timer?.querySelectorAll('input[type="checkbox"]') ?? [])].filter(item => item.getClientRects().length)
      .map(item => ({ name: (item.getAttribute('aria-label') || item.closest('label')?.textContent || '').trim().slice(0, 40), box: size(item), target: size(item.closest('label') ?? item) }));
    return { search: frame && field ? { frame: size(frame).height, field: size(field).height } : null, checkboxes };
  } finally { closed.forEach(item => { item.open = false; }); }
})()`;
// Detailed report with the saved client filter and reporting time zone (UIQ evidence; observation only).
async function captureReportDetail(cdp, sessionId, state) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  for (const [width, height] of [[1280, 720], [1920, 1080]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    try {
      await waitFor('report ' + state + ' at ' + width + 'x' + height, () => evaluate('window.innerWidth === ' + width + ' && window.innerHeight === ' + height));
      await delay(300);
      const box = await evaluate(`(() => {
        const report = document.querySelector('[aria-label="Raport czasu"]');
        if (!report?.querySelector('.report-detail tbody tr') || !report.querySelector('.report-scope-summary li')) return null;
        report.scrollIntoView({ block: 'start' });
        const rect = report.getBoundingClientRect();
        return { x: Math.max(0, rect.left + window.scrollX), y: Math.max(0, rect.top + window.scrollY),
          width: Math.ceil(rect.width), height: Math.ceil(rect.height),
          scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
      })()`);
      assert.ok(box, state + ': Detailed report with the scope summary is not visible');
      console.log('UI_LAYOUT report-detail-' + state + ' ' + width + 'x' + height + ' ' + JSON.stringify(box));
      assert.ok(box.scrollWidth <= box.clientWidth, 'report ' + state + ' ' + width + 'x' + height + ': the page scrolls horizontally');
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } }, sessionId);
      await writeFile(join(screenshotDirectory, 'report-detail-' + state + '-' + width + 'x' + height + '.png'), Buffer.from(data, 'base64'));
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    }
  }
}
// Reports Summary (DEV-30/31, package R1) on the selected client and the wide fixed range of the first window:
// final KPIs, the SVG chart driven by real keys, the legend and the client → project → task groups all equal
// the Detailed contribution of the single entry. Layout at 1280/1920 and at 125% scaling, with screenshots.
async function verifyReportSummary(cdp, sessionId, seconds) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const hms = value => [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(part => String(part).padStart(2, '0')).join(':');
  const report = '[aria-label="Raport czasu"]';
  const tab = label => `[...document.querySelectorAll(${JSON.stringify(report + ' button')})].find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
  await evaluate(`${tab('Podsumowanie')}.click()`);
  await waitFor('summary KPIs', () => evaluate(`document.querySelector('.report-kpis strong')?.textContent.trim() === ${JSON.stringify(hms(seconds))}`));
  const kpi = await evaluate(`[...document.querySelectorAll('.report-kpis > div')].map(tile => ({
    label: tile.querySelector('small').textContent.trim(), value: tile.querySelector('strong').textContent.trim(), note: tile.querySelectorAll('small')[1]?.textContent.trim() ?? '' }))`);
  console.log(`REPORT_SUMMARY kpi ${JSON.stringify(kpi)}`);
  assert.deepEqual(kpi.map(tile => tile.label), ['Łączny czas', 'Rozliczalny czas', '% rozliczalny', 'Średnio na dzień z pracą']);
  // The fixture project is not billable by default (D12 billable B: false unless the project says otherwise).
  assert.deepEqual([kpi[1].value, kpi[2].value], ['00:00:00', '0%']);
  const workDays = Number(kpi[3].note.match(/^(\d+)/)?.[1]);
  assert.ok(workDays === 1 || workDays === 2, `days with work: ${kpi[3].note}`);
  assert.equal(kpi[3].value, hms(Math.floor(seconds / workDays)), 'average over days with work (D12 variant B)');
  assert.equal(await evaluate(`Boolean(document.querySelector('.report-live'))`), false, 'no running or pending time in this window');

  const chart = await evaluate(`(() => {
    const bars = [...document.querySelectorAll('.report-chart-bar')];
    return { caption: document.querySelector('.report-chart h3')?.textContent, bars: bars.length,
      sum: bars.reduce((total, bar) => total + Number(bar.dataset.seconds), 0), tabbable: bars.filter(bar => bar.getAttribute('tabindex') === '0').length,
      legend: [...document.querySelectorAll('.report-chart-legend li')].map(item => item.textContent) };
  })()`);
  console.log(`REPORT_SUMMARY chart ${JSON.stringify(chart)}`);
  assert.equal(chart.caption, 'Czas według miesięcy', 'the 14-month range is shown by month');
  assert.equal(chart.bars, 14);
  assert.equal(chart.sum, seconds, 'chart buckets add up to the KPI total');
  assert.equal(chart.tabbable, 1, 'one tab stop (roving focus)');
  assert.equal(chart.legend.length, 1);
  assert.ok(chart.legend[0].includes(project) && chart.legend[0].includes(primaryClient) && chart.legend[0].includes(hms(seconds)));
  // Real keys through CDP: focus the bar with data, move left (tooltip follows), back right, Escape hides it.
  await evaluate(`document.querySelector('.report-chart-bar[tabindex="0"]').focus()`);
  const focused = () => evaluate(`({ from: document.activeElement?.dataset?.from ?? null, seconds: Number(document.activeElement?.dataset?.seconds ?? -1),
    tooltip: document.querySelector('[role="tooltip"]')?.textContent ?? null,
    described: Boolean(document.activeElement?.getAttribute('aria-describedby')) })`);
  const start = await focused();
  assert.equal(start.seconds, seconds);
  assert.ok(start.described && start.tooltip.includes(`Łącznie ${hms(seconds)}`) && start.tooltip.includes(project), `tooltip: ${start.tooltip}`);
  const press = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode }, sessionId);
  };
  await press('ArrowLeft', 'ArrowLeft', 37);
  const left = await waitFor('ArrowLeft moves the chart focus', async () => { const state = await focused(); return state.from !== start.from ? state : null; });
  assert.ok(left.tooltip?.includes('Łącznie') && left.described, 'the tooltip follows the keyboard');
  await press('ArrowRight', 'ArrowRight', 39);
  await waitFor('ArrowRight returns to the bar with data', async () => (await focused()).from === start.from);
  await press('Escape', 'Escape', 27);
  await waitFor('Escape hides the tooltip', async () => (await focused()).tooltip === null);

  const groupRows = () => evaluate(`[...document.querySelectorAll('.report-groups tbody tr')].map(row => ({ level: row.dataset.level,
    name: row.querySelector('th').textContent.replace(/^[▾▸]/, '').trim(), time: row.cells[1].textContent.trim(), share: row.cells[2].textContent.trim() }))`);
  const initial = await groupRows();
  assert.deepEqual(initial, [{ level: 'client', name: primaryClient, time: hms(seconds), share: '100%' }, { level: 'project', name: project, time: hms(seconds), share: '100%' }]);
  await evaluate(`[...document.querySelectorAll('.report-groups tbody tr[data-level="project"] button')][0].click()`);
  await waitFor('task level expands', async () => (await groupRows()).length === 3);
  assert.deepEqual((await groupRows())[2], { level: 'task', name: task, time: hms(seconds), share: '100%' });
  assert.equal(await evaluate(`document.querySelector('.report-groups tbody tr[data-level="project"] button').getAttribute('aria-expanded')`), 'true');
  assert.equal(await evaluate(`document.querySelector('.report-groups tfoot td').textContent.trim()`), hms(seconds));
  console.log('PASS: Reports Summary KPIs, chart (keyboard tooltip), legend and client → project → task groups equal the Detailed entry');

  await captureSection(cdp, sessionId, report, `Boolean(document.querySelector('.report-chart-bar'))`, 'report-summary');
  // 125% Windows scaling of a 1280×720 window: 1024×576 CSS px at device scale 1.25.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 576, deviceScaleFactor: 1.25, mobile: false }, sessionId);
  try {
    await waitFor('125% scaling applied', () => evaluate('window.innerWidth === 1024 && window.devicePixelRatio === 1.25'));
    await delay(300);
    const box = await evaluate(`(() => {
      const section = document.querySelector(${JSON.stringify(report)});
      section.scrollIntoView({ block: 'start' });
      const rect = section.getBoundingClientRect();
      const kpis = [...document.querySelectorAll('.report-kpis > div')].map(tile => tile.getBoundingClientRect());
      const overflowing = [...section.querySelectorAll('.report-kpis strong, .report-chart-legend li, .report-groups th')]
        .filter(element => element.scrollWidth > element.clientWidth + 1).length;
      return { x: Math.max(0, rect.left + window.scrollX), y: Math.max(0, rect.top + window.scrollY), width: Math.ceil(rect.width), height: Math.ceil(rect.height),
        scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, kpiTop: kpis.map(item => Math.round(item.top)), overflowing };
    })()`);
    console.log(`UI_LAYOUT report-summary-125pct 1024x576@1.25 ${JSON.stringify(box)}`);
    assert.ok(box.scrollWidth <= box.clientWidth, 'report summary at 125%: the page scrolls horizontally');
    assert.equal(box.overflowing, 0, 'report summary at 125%: text is clipped');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } }, sessionId);
    await writeFile(join(screenshotDirectory, 'report-summary-125pct-1024x576.png'), Buffer.from(data, 'base64'));
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  }
  await evaluate(`${tab('Szczegóły')}.click()`);
  await waitFor('Detailed shown after the summary check', () => evaluate(`Boolean(document.querySelector('.report-detail tbody tr'))`));
}
// Mini timer bar: 48×48 Start/Stop in a fixed place, title/clock/action not overlapping or covered, no page overflow.
const inspectCompactLayout = `(() => {
  const box = selector => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top),
      bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
  };
  const uncovered = selector => {
    const element = document.querySelector(selector);
    const rect = element?.getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === element || element.contains(hit)));
  };
  const title = document.querySelector('.qp-context strong');
  return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    context: box('.qp-context'), clock: box('.qp-clock'), action: box('.qp-toggle'),
    clockUncovered: uncovered('.qp-clock'), actionUncovered: uncovered('.qp-toggle'),
    title: title?.textContent ?? null, titleTruncated: title ? title.scrollWidth > title.clientWidth : null };
})()`;
function assertCompactLayout(layout, label, reference) {
  console.log(`UI_LAYOUT widget-${label.replace(' ', '-')} ${JSON.stringify(layout)}`);
  assert.ok(layout.scrollWidth <= layout.clientWidth, `${label}: the mini timer scrolls horizontally`);
  assert.ok(layout.action && layout.action.width === 48 && layout.action.height === 48, `${label}: Start/Stop is not 48×48`);
  assert.ok(layout.context && layout.clock && layout.context.right <= layout.clock.left && layout.clock.right <= layout.action.left,
    `${label}: the title overlaps the clock or the clock overlaps Start/Stop`);
  assert.ok(layout.clockUncovered && layout.actionUncovered, `${label}: the clock or Start/Stop is covered`);
  if (reference) {
    assert.equal(layout.action.left, reference.action.left, `${label}: Start/Stop moved horizontally`);
    assert.equal(layout.action.top, reference.action.top, `${label}: Start/Stop moved vertically`);
  }
}
// UIQ evidence for a whole page section (beyond the viewport); observation plus layout checks.
async function captureSection(cdp, sessionId, selector, ready, name) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await waitFor(`${name} ready`, () => evaluate(ready));
  for (const [width, height] of [[1280, 720], [1920, 1080]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    try {
      await waitFor(`${name} at ${width}x${height}`, () => evaluate(`window.innerWidth === ${width} && window.innerHeight === ${height}`));
      await delay(300);
      const box = await evaluate(`(() => {
        const section = document.querySelector(${JSON.stringify(selector)});
        if (!section) return null;
        section.scrollIntoView({ block: 'start' });
        const rect = section.getBoundingClientRect();
        return { x: Math.max(0, rect.left + window.scrollX), y: Math.max(0, rect.top + window.scrollY), width: Math.ceil(rect.width), height: Math.ceil(rect.height),
          scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
      })()`);
      assert.ok(box, `${name}: section is missing`);
      console.log(`UI_LAYOUT ${name} ${width}x${height} ${JSON.stringify(box)}`);
      assert.ok(box.scrollWidth <= box.clientWidth, `${name} ${width}x${height}: the page scrolls horizontally`);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } }, sessionId);
      await writeFile(join(screenshotDirectory, `${name}-${width}x${height}.png`), Buffer.from(data, 'base64'));
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    }
  }
}
const historyByDayReady = `Boolean(document.querySelector('section.history tr.history-day .history-day-total'))`;
const reportCardReady = `(() => { const values = [...document.querySelectorAll('.report-glance dd')]; return values.length === 3 && values.every(node => /^\\d{2,}:\\d{2}:\\d{2}$/.test(node.textContent.trim())); })()`;
async function captureMainLayout(cdp, sessionId, state, { requireTimerAction = true, requireTimerCard = false } = {}) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  for (const [width, height] of [[1280, 720], [1920, 1080]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    try {
      await waitFor(`${state} layout at ${width}x${height}`, () => evaluate(`window.innerWidth === ${width} && window.innerHeight === ${height}`));
      await evaluate('window.scrollTo(0, 0)');
      await delay(300);
      const layout = await evaluate(inspectMainLayout);
      console.log(`UI_LAYOUT main-${state} ${width}x${height} ${JSON.stringify(layout)}`);
      assert.ok(layout.scrollWidth <= layout.clientWidth,
        `${state} ${width}x${height}: the page scrolls horizontally (${layout.scrollWidth} > ${layout.clientWidth})`);
      if (requireTimerAction) {
        assert.ok(layout.action, `${state}: Start/Stop button is missing`);
        assert.equal(layout.scrollY, 0);
        assert.ok(layout.action.top >= 0 && layout.action.bottom <= height && layout.action.left >= 0 && layout.action.right <= width,
          `${state} ${width}x${height}: Start/Stop is not visible without scrolling`);
        assert.ok(layout.action.height >= 40, `${state}: Start/Stop is lower than 40px`);
      }
      if (requireTimerCard) {
        // Package 3: the review banner is compact, so the timer card and its clock stay in view without scrolling.
        assert.equal(layout.scrollY, 0);
        assert.ok(layout.card && layout.clock, `${state}: the timer card or its clock is missing`);
        assert.ok(layout.card.top >= 0 && layout.card.top < height && layout.clock.top >= layout.card.top && layout.clock.bottom <= height,
          `${state} ${width}x${height}: the timer card and its clock are not visible without scrolling (${JSON.stringify(layout)})`);
      }
      await saveScreenshot(cdp, sessionId, `main-${state}-${width}x${height}`);
      if (width === 1280) {
        const controls = await evaluate(inspectControlSizes);
        console.log(`UI_LAYOUT controls-${state} ${width}x${height} ${JSON.stringify(controls)}`);
        assert.ok(controls.search, `${state}: the project search is missing`);
        assert.ok(controls.search.frame >= 40 && controls.search.field >= 40, `${state}: the project search is lower than 40px (${JSON.stringify(controls.search)})`);
        assert.ok(controls.checkboxes.length > 0, `${state}: no checkbox measured in the timer card`);
        for (const item of controls.checkboxes) {
          assert.ok(item.target.width >= 24 && item.target.height >= 24, `${state}: checkbox "${item.name}" has a target below 24×24 (${JSON.stringify(item)})`);
        }
      }
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    }
  }
}
const primaryClient = 'Klient Żuraw QA';
const secondClient = 'Klient Beta QA';
const project = 'Projekt kontrolny';
const task = 'Zadanie QA';
const primaryDescription = 'Pomiar klienta Żuraw';
const secondDescription = 'Pomiar wyłącznie klienta Beta';
const interruptedDescription = 'Pomiar przerwany przez zakończenie procesu';

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(label, operation) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}

async function connect(port, child) {
  let lastObservation = 'No response received';
  const endpoints = await waitFor('TrackerMaster WebView2 endpoints', async () => {
    assert.equal(child.exitCode ?? child.signalCode, null, 'TrackerMaster exited before its window was available');
    try {
      const base = `http://127.0.0.1:${port}/json`;
      const json = name => fetch(`${base}/${name}`, { signal: AbortSignal.timeout(1_000), redirect: 'error' }).then(r => r.json());
      const [browser, pages] = await Promise.all([json('version'), json('list')]);
      const page = pages.find(target => target.type === 'page' && /^https?:\/\/tauri\.localhost(?::\d+)?(?:\/|$)/.test(target.url));
      lastObservation = `${browser.Browser ?? 'WebView2'} responded with ${pages.length} targets, isolated page found: ${Boolean(page)}`;
      return browser.webSocketDebuggerUrl && page ? { browser: browser.webSocketDebuggerUrl, id: page.id } : null;
    } catch (error) {
      lastObservation = `${error.name}: ${error.cause?.code ?? error.message}`;
      return null;
    }
  }).catch(error => { throw new Error(`${error.message}. Last observation: ${lastObservation}`); });
  const endpoint = new URL(endpoints.browser);
  assert.equal(endpoint.protocol, 'ws:');
  assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname));
  assert.equal(endpoint.port, String(port));
  endpoint.hostname = '127.0.0.1';
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const downloadEvents = [];
  let lastId = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Browser.downloadWillBegin' || message.method === 'Browser.downloadProgress') {
      const { guid, state, receivedBytes, totalBytes, suggestedFilename } = message.params;
      downloadEvents.push({ at: new Date().toISOString(), method: message.method, guid, state, receivedBytes, totalBytes, suggestedFilename });
    }
    pending.get(message.id)?.(message);
  });
  const opened = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 10_000);
    const complete = result => { clearTimeout(timer); resolve(result); };
    socket.addEventListener('open', () => complete(true), { once: true });
    socket.addEventListener('error', () => complete(false), { once: true });
  });
  if (!opened) {
    socket.close();
    throw new Error('Could not connect to the isolated WebView2 instance');
  }
  return {
    pageId: endpoints.id,
    downloadEvents,
    close: () => socket.close(),
    async send(method, params = {}, sessionId) {
      const id = ++lastId;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`WebView2 did not respond to ${method}`)), 90_000);
          pending.set(id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        });
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
  };
}

async function exercisePage(data, phase) {
  const fail = message => { throw new Error(message); };
  async function until(label, read) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const found = read();
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    fail(`Window did not reach: ${label}`);
  }
  const pick = selector => document.querySelector(selector);
  const normalizedText = element => element.textContent.trim();
  const report = '[aria-label="Raport czasu"]';
  const timer = '[aria-label="Pomiar czasu"]';
  const textButton = (parent, label) => [...document.querySelectorAll(`${parent} button`)].find(button => normalizedText(button) === label);
  const enabled = element => element && !element.disabled && element.getClientRects().length > 0 && element;
  async function click(label, read) {
    const button = await until(label, () => enabled(read()));
    button.click();
  }
  async function setValue(selector, value, event, index = 0) {
    const element = await until(selector, () => enabled(document.querySelectorAll(selector)[index]));
    const prototype = event === 'change' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(event, { bubbles: true }));
  }
  const selected = select => select?.selectedOptions[0]?.textContent;
  const reportClient = () => pick('#report-client');
  const historyRow = description => [...document.querySelectorAll('section.history tbody tr')].find(row => row.textContent.includes(description));
  const recoveryMessage = () => [...document.querySelectorAll('[role="alert"] strong')].find(node => node.textContent === 'Pomiar wymaga weryfikacji.');
  async function waitForMeasurement() {
    await until('running timer', () => pick(`${timer} .status.running`));
    await until('at least five measured seconds', () => {
      const digits = pick(`${timer} .clock`).textContent.split(':').map(Number);
      return digits.length === 3 && digits.reduce((seconds, field) => seconds * 60 + field, 0) >= 5;
    });
  }
  const testProfileVisible = () => document.querySelector('[role="note"]')?.textContent.includes('Wersja testowa.');
  // Current data: the lists are enabled and the quick-start picker exists. The picker is disabled on
  // purpose only while a recovered timer awaits its end time (Start is blocked then), so it must be
  // enabled exactly when the "Pomiar wymaga weryfikacji." alert is absent.
  const pickerReady = () => {
    const search = pick(`${timer} .timer-picker [role="combobox"]`);
    return Boolean(search) && search.disabled === Boolean(recoveryMessage());
  };
  await until('test build and current data', () => testProfileVisible() && !pick(`${timer} select`)?.disabled &&
    pickerReady() && pick('#new-client'));

  if (phase === 'hotkey-restart' || phase === 'write-failure' || phase === 'write-failure-reopen' || phase === 'disk-full' || phase === 'short-sleep') return null;

  if (phase === 'recover' || phase === 'verify-recovery' || phase === 'draft-reopen') {
    if (phase === 'recover') {
      await until('interrupted timer requires verification', recoveryMessage);
      if (!pick(`${timer} .active-info`)?.textContent.includes(data.interruptedDescription) ||
          pick(`${timer} .clock`)?.textContent !== '—:—:—' || historyRow(data.interruptedDescription)) {
        fail('Restart presented the interrupted entry as confirmed work');
      }
      async function submitEnd(utc) {
        const date = new Date(utc);
        const pad = value => String(value).padStart(2, '0');
        const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
        const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':');
        await setValue('[role="alert"] input[type="datetime-local"]', `${day}T${time}`, 'input');
        await click('submit recovery end', () => textButton('.app-shell', 'Zapisz zakończenie'));
      }
      await submitEnd(data.recovery.invalidEnd);
      await until('end before start rejected', () => [...document.querySelectorAll('[role="alert"]')]
        .some(node => node.textContent.includes('Zakończenie nie może być przed rozpoczęciem pomiaru.')));
      if (!recoveryMessage() || historyRow(data.interruptedDescription)) fail('Rejected recovery changed the interrupted entry');
      await submitEnd(data.recovery.end);
    }
    const row = await until('resolved entry visible in History', () => historyRow(data.interruptedDescription));
    if (recoveryMessage() || !row.textContent.includes('wskazane ręcznie') ||
        row.querySelector('.duration')?.textContent !== data.recovery.displayDuration) {
      fail('History did not retain the manual recovery and its duration');
    }
    return null;
  }

  const restarted = phase !== 'initial';
  if (!restarted) {
    async function create(kind, name, selectedIndex) {
      const input = `#new-${kind}`;
      await setValue(input, name, 'input');
      await click(`create ${kind}`, () => pick(input)?.form?.querySelector('button'));
      await until(`selected ${kind} ${name}`, () => selected(document.querySelectorAll(`${timer} select`)[selectedIndex]) === name);
    }
    async function measure(client, description, taskName, first = false) {
      await create('client', client, 0);
      await create('project', data.project, 1);
      if (taskName) await create('task', taskName, 2);
      if (first) {
        // The quick-start picker reflects the same selection as the lists (no recent items yet).
        await until('picker shows the created target', () => pick(`${timer} .timer-picker [role="option"][aria-selected="true"]`)
          ?.getAttribute('aria-label') === `${taskName ?? 'Bez zadania'} — ${client} / ${data.project}`);
      }
      await setValue(`${timer} .timer-description input`, description, 'input');
      // Package 3: one main action under the clock; Start (idle) and Stop (running) share its place and size.
      const mainBox = () => {
        const card = pick(timer)?.getBoundingClientRect();
        const box = pick(`${timer} .timer-main button`)?.getBoundingClientRect();
        return card && box ? [box.left - card.left, box.top - card.top, box.width, box.height].map(Math.round).join(',') : null;
      };
      const idleBox = first ? mainBox() : null;
      if (first && (!idleBox || !pick(`${timer} .timer-main.timer-start button`))) fail('The main Start action is missing under the clock');
      if (first) {
        // A fast double click must send one start: the second click finds the request gate closed.
        const start = await until('start enabled', () => enabled(pick(`${timer} .timer-start button`)));
        start.click(); start.click();
      } else await click('start timer', () => pick(`${timer} .timer-start button`));
      await waitForMeasurement();
      if (first) {
        const runningBox = mainBox();
        if (!pick(`${timer} .timer-main.timer-stop button`) || runningBox !== idleBox) fail(`The main action moved or changed size between idle and running: ${idleBox} -> ${runningBox}`);
        console.log(`UI_LAYOUT main-action idle=${idleBox} running=${runningBox}`);
      }
      if ([...document.querySelectorAll('[role="alert"]')].some(node => node.textContent.includes('Nie udało się potwierdzić operacji'))) fail('A double click sent a second start');
      if (first) {
        // Package 3: Start and Stop are one button. A double click on Stop must not start a new timer: the second
        // click lands right after the button turned back into Start (quiet period from the end of the write).
        const stop = await until('stop enabled', () => enabled(pick(`${timer} .timer-main.timer-stop button`)));
        stop.click();
        const restart = await until('main action back to Start', () => enabled(pick(`${timer} .timer-main.timer-start button`)));
        restart.click();
        await new Promise(resolve => setTimeout(resolve, 1500));
        const entryRows = () => [...document.querySelectorAll('section.history tbody tr')].filter(row => row.textContent.includes(description) && row.querySelector('.entry-menu-trigger'));
        await until('completed entry in History', () => historyRow(description));
        if (pick(`${timer} .status.running`) || pick(`${timer} .timer-main.timer-stop button`) || entryRows().length !== 1) {
          fail(`A double click on Stop started a new timer (running: ${Boolean(pick(`${timer} .status.running`))}, entries: ${entryRows().length})`);
        }
      } else await click('stop timer', () => pick(`${timer} .timer-stop button`));
      await until('completed entry in History', () => historyRow(description));
      if (first) {
        await until('day and week totals next to the timer', () => /^Dziś \d+ (h \d+ )?min · Tydzień \d+ (h \d+ )?min/.test(pick(`${timer} .timer-totals`)?.textContent ?? ''));
        await until('History grouped by day', () => historyRow(description)?.closest('tbody')?.querySelector('tr.history-day th .history-day-total'));
      }
    }
    await measure(data.primaryClient, data.primaryDescription, data.task, true);
    await measure(data.secondClient, data.secondDescription);
    const archiveToggle = await until('show archived records', () =>
      [...document.querySelectorAll(`${timer} label`)].find(label => label.textContent.includes('Pokaż archiwum'))?.querySelector('input'));
    archiveToggle.click();
    await click('archive the second client project', () => textButton(timer, 'Archiwizuj projekt'));
    await until('project is archived', () => enabled(textButton(timer, 'Przywróć projekt')));
    if (!historyRow(data.primaryDescription) || !historyRow(data.secondDescription)) fail('Archiving the project removed history');
    await click('restore the second client project', () => textButton(timer, 'Przywróć projekt'));
    await until('project is restored', () => enabled(textButton(timer, 'Archiwizuj projekt')));
    await click('archive project before its client', () => textButton(timer, 'Archiwizuj projekt'));
    await until('project is archived before its client', () => enabled(textButton(timer, 'Przywróć projekt')));
    await click('archive the second client', () => textButton(timer, 'Archiwizuj klienta'));
    await until('client is archived', () => enabled(textButton(timer, 'Przywróć klienta')));
    if (!historyRow(data.primaryDescription) || !historyRow(data.secondDescription)) fail('Archiving the client removed history');
    await click('restore the second client', () => textButton(timer, 'Przywróć klienta'));
    await until('client is restored', () => enabled(textButton(timer, 'Archiwizuj klienta')));
    await until('client project remains archived', () => enabled(textButton(timer, 'Przywróć projekt')));
    await click('restore project after client', () => textButton(timer, 'Przywróć projekt'));
    await until('project restored after its client', () => enabled(textButton(timer, 'Archiwizuj projekt')));
    if (!historyRow(data.primaryDescription) || !historyRow(data.secondDescription)) fail('Restoring the client or project changed history');
    archiveToggle.click();
    console.log('PASS: archived and restored a project and client without removing either client history');
  }

  await click('open report', () => textButton(report, 'Otwórz raport'));
  await until('initial report', () => pick(`${report} .report-summary`));
  if (!restarted) {
    if (!textButton(report, 'Przygotuj podgląd CSV').disabled) fail('CSV was available without choosing a client');
    const option = [...reportClient().options].find(item => item.textContent === data.primaryClient);
    if (!option) fail('Created client missing from the report');
    await setValue('#report-client', option.value, 'change');
    // Fix a range around the test instant so crossing local midnight cannot hide the fixture.
    const year = new Date().getUTCFullYear();
    await setValue(`${report} input[type="date"]`, `${year - 1}-12-01`, 'input');
    await setValue(`${report} input[type="date"]`, `${year + 1}-01-31`, 'input', 1);
  }
  await until('selected client report', () => selected(reportClient()) === data.primaryClient &&
    pick(`${report} .report-scope-summary`)?.textContent.includes(data.primaryClient));
  await click('open detailed report', () => textButton(report, 'Szczegóły'));
  await until('client A entry in Detailed', () => pick('.report-detail tbody')?.textContent.includes(data.primaryDescription));
  const detailed = pick('.report-detail tbody');
  if (detailed.rows.length !== 1 || detailed.textContent.includes(data.secondDescription)) fail('Detailed report returned a foreign entry');
  const contribution = detailed.querySelectorAll('.duration')[1]?.textContent.trim();
  if (!/^\d{2,}:\d{2}:\d{2}$/.test(contribution)) fail('Missing detailed duration');
  // Kept from main: the client total must match the single exported entry (Detailed and CSV preview).
  await click('open report summary', () => textButton(report, 'Podsumowanie'));
  await until('report total matches Detailed', () => pick(report + ' .report-summary strong')?.textContent.trim() === contribution);
  await click('reopen detailed report', () => textButton(report, 'Szczegóły'));
  await until('Detailed shown again', () => pick('.report-detail tbody')?.textContent.includes(data.primaryDescription));
  if (!restarted) {
    await click('prepare CSV', () => textButton(report, 'Przygotuj podgląd CSV'));
    await until('client CSV preview', () => pick('.export-preview tbody')?.textContent.includes(data.primaryDescription));
    const previewRows = pick('.export-preview tbody').rows;
    if (previewRows.length !== 1 || previewRows[0].textContent.includes(data.secondDescription)) fail('CSV preview returned a foreign entry');
    const previewContribution = previewRows[0].cells[8]?.textContent.match(/^(\d{2,}:\d{2}:\d{2}) \(\d+ s\)$/)?.[1];
    if (previewContribution !== contribution) fail('CSV preview duration differs from Detailed');
  } else {
    const settings = '[aria-label="Skrót klawiaturowy"]';
    await setValue(`${settings} select`, 'Alt', 'change');
    await setValue(`${settings} select`, 'F11', 'change', 1);
    await click('save custom mini timer shortcut', () => textButton(settings, 'Zapisz skrót'));
    await until('custom shortcut saved', () => pick(`${settings} [role="status"]`)?.textContent.includes('Ctrl + Alt + F11'));
  }
  return contribution.split(':').reduce((seconds, field) => seconds * 60 + Number(field), 0);
}

function inspectWindow(action, primaryPid, windowHandle = '0') {
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', 'tests/windows-window.ps1', action, String(primaryPid), windowHandle,
  ], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
}

async function verifySecondLaunch(primary, env) {
  const original = readInterruptedTimer();
  const window = await waitFor('native main window', () => inspectWindow('Find', primary.pid) || null);
  assert.equal(inspectWindow('Close', primary.pid, window), 'posted');
  await waitFor('X hides the existing window', () => inspectWindow('Visibility', primary.pid, window) === 'hidden');
  assert.deepEqual(readInterruptedTimer(), original);

  const secondary = spawn(exe, [], { env, stdio: 'ignore', windowsHide: true });
  try {
    const exit = await once(secondary, 'exit', { signal: AbortSignal.timeout(12_000) });
    assert.deepEqual(exit, [0, null], 'The second launch should activate the first process and exit');
  } finally {
    if (secondary.pid && secondary.exitCode === null && secondary.signalCode === null) {
      const stopped = once(secondary, 'exit');
      secondary.kill();
      await stopped;
    }
  }
  await waitFor('second launch restores the original window', () =>
    inspectWindow('Visibility', primary.pid, window) === 'visible');
  assert.equal(primary.exitCode, null);
  assert.deepEqual(readInterruptedTimer(), original);
  console.log(`PASS: X hid the original window, second launch restored it, and active entry #${original.id} was unchanged`);
}

async function verifyOccupiedShortcut(cdp, session) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'tests/windows-occupy-hotkey.ps1'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  helper.stdout.on('data', chunk => { output += chunk.toString(); });
  helper.stderr.on('data', chunk => { errors += chunk.toString(); });
  const exited = once(helper, 'exit');
  const selectAndSave = async key => {
    await evaluate(`(() => {
    const section = document.querySelector('[aria-label="Skrót klawiaturowy"]');
    const select = section.querySelectorAll('select')[1];
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(key)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await evaluate(`document.querySelector('[aria-label="Skrót klawiaturowy"] button').click()`);
  };
  try {
    await waitFor('another process reserves Ctrl+Alt+F10', () => {
      assert.equal(helper.exitCode, null, `Shortcut reservation failed: ${errors}`);
      return output.includes('reserved');
    });
    await selectAndSave('F10');
    await waitFor('occupied shortcut is rejected', () => evaluate(`document.querySelector('[aria-label="Skrót klawiaturowy"] [role="alert"]')?.textContent.includes('niedostępny lub zajęty')`));
    assert.equal(await evaluate(`document.querySelector('[aria-label="Skrót klawiaturowy"] strong')?.textContent`), 'Ctrl + Alt + F11');
    assert.equal(await readFile(join(process.env.APPDATA, 'pl.tracker.personal.testonly', 'shortcut.txt'), 'utf8'), 'Ctrl+Alt+F11');
    assert.equal(helper.exitCode, null, 'The other process must still own the shortcut during rejection');
    await verifyMiniTimer(cdp, session);
    assert.equal(helper.exitCode, null, 'The conflicting shortcut must still be reserved while testing the previous one');
    helper.stdin.end('\n');
    assert.deepEqual(await exited, [0, null], errors);
    await selectAndSave('F10');
    await waitFor('released shortcut can be saved', () => evaluate(`document.querySelector('[aria-label="Skrót klawiaturowy"] strong')?.textContent === 'Ctrl + Alt + F10'`));
    await selectAndSave('F11');
    await waitFor('original shortcut restored', () => evaluate(`document.querySelector('[aria-label="Skrót klawiaturowy"] strong')?.textContent === 'Ctrl + Alt + F11'`));
    assert.equal(await readFile(join(process.env.APPDATA, 'pl.tracker.personal.testonly', 'shortcut.txt'), 'utf8'), 'Ctrl+Alt+F11');
    console.log('PASS: an actual shortcut conflict preserved the working old shortcut; releasing and retrying succeeded');
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) {
      helper.stdin.end('\n');
      await exited;
    }
  }
}

async function verifyMiniTimer(cdp, mainSession) {
  const evaluate = async (session, expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, session);
    if (result.exceptionDetails) {
      const cause = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`${cause} while checking ${expression.slice(0, 120)}`);
    }
    return result.result.value;
  };
  const findOtherWindow = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find(target => target.type === 'page' && target.targetId !== cdp.pageId &&
      /^https?:\/\/tauri\.localhost(?::\d+)?\//.test(target.url));
  };
  const openWidget = async () => {
    await evaluate(mainSession, 'document.querySelector(".widget-open").click()');
    const target = await waitFor('native mini timer WebView2', findOtherWindow);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await waitFor('mini timer reads the configured shortcut', () => evaluate(sessionId,
      'document.querySelector(".qp-toggle")?.title.includes("Ctrl + Alt + F11") ?? false'
    ).catch(error => {
      if (!/Execution context was destroyed|Cannot find context/i.test(error.message)) throw error;
      return false;
    }));
    return sessionId;
  };
  const widget = await openWidget();
  const inspectTimerBar = () => evaluate(widget, `(() => {
    const clock = document.querySelector('.qp-clock').getBoundingClientRect();
    const action = document.querySelector('.qp-toggle').getBoundingClientRect();
    const bar = document.querySelector('.qp-bar').getBoundingClientRect();
    return { clockRight: clock.right, actionLeft: action.left, actionRight: action.right,
      actionWidth: action.width, actionHeight: action.height, barRight: bar.right };
  })()`);
  const idleBar = await inspectTimerBar();
  assert.ok(idleBar.actionWidth >= 44 && idleBar.actionHeight >= 44, 'Timer action should have a 44px target');
  assert.ok(idleBar.clockRight <= idleBar.actionLeft && idleBar.actionRight <= idleBar.barRight,
    'Timer action should follow the clock and fit inside the bar');
  const compactIdle = await evaluate(widget, inspectCompactLayout);
  assertCompactLayout(compactIdle, 'compact idle');
  await saveScreenshot(cdp, widget, 'widget-compact-idle');
  await evaluate(widget, `document.querySelector('[aria-label="Rozwiń panel"]').click()`);
  await waitFor('mini timer opens the focused project search', () => evaluate(widget,
    `document.activeElement === document.querySelector('[role="combobox"]')`));
  // UIQ-05: the same 40 px search field in the expanded mini timer (440×390).
  const widgetSearch = await evaluate(widget, `(() => { const size = element => Math.round(element.getBoundingClientRect().height); return { frame: size(document.querySelector('.qp-search')), field: size(document.querySelector('.qp-search input')) }; })()`);
  console.log(`UI_LAYOUT widget-search ${JSON.stringify(widgetSearch)}`);
  assert.ok(widgetSearch.frame >= 40 && widgetSearch.field >= 40, `mini timer search is lower than 40px: ${JSON.stringify(widgetSearch)}`);
  await evaluate(widget, `(() => {
    const input = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(secondClient)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor('search returns the second client project only', () => evaluate(widget, `(() => {
    const options = [...document.querySelectorAll('[role="option"]')];
    return options.length === 1 && options[0].getAttribute('aria-label') === ${JSON.stringify(`Bez zadania — ${secondClient} / ${project}`)};
  })()`));
  await saveScreenshot(cdp, widget, 'widget-expanded-search');
  const press = key => evaluate(widget, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);
  await press('ArrowDown');
  await waitFor('keyboard highlights the search result', () => evaluate(widget,
    `Boolean(document.querySelector('[role="combobox"]')?.getAttribute('aria-activedescendant'))`));
  await press('Enter');
  await waitFor('keyboard selection focuses the description', () => evaluate(widget, 'document.activeElement.id === "qp-description"'));
  await evaluate(widget, `(() => {
    const input = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(interruptedDescription)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const pin = '[aria-label="Przypięcie na wierzchu"]';
  await waitFor('native pin preference is loaded', () => evaluate(widget,
    `document.querySelector(${JSON.stringify(pin)})?.getAttribute('aria-disabled') === 'false'`));
  await evaluate(widget, `document.querySelector(${JSON.stringify(pin)}).click()`);
  await waitFor('pinning succeeds', () => evaluate(widget,
    `document.querySelector(${JSON.stringify(pin)})?.getAttribute('aria-pressed') === 'true'`));
  assert.equal(await readFile(join(process.env.APPDATA, 'pl.tracker.personal.testonly', 'widget-on-top.txt'), 'utf8'), 'true');
  await evaluate(widget, 'document.querySelector(".qp-toggle").focus()');
  const oldShortcut = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 2 | 8 }; // CDP: Control and Shift
  await cdp.send('Input.dispatchKeyEvent', { ...oldShortcut, type: 'keyDown' }, widget);
  await cdp.send('Input.dispatchKeyEvent', { ...oldShortcut, type: 'keyUp' }, widget);
  await delay(250);
  assert.equal(await evaluate(widget, 'document.querySelector(".qp-mini").dataset.mode'), 'idle',
    'The old shortcut must not activate a focused Start button');
  const focusTest = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'tests/windows-hotkey.ps1'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let focusOutput = '', focusErrors = '';
  focusTest.stdout.on('data', chunk => { focusOutput += chunk.toString(); });
  focusTest.stderr.on('data', chunk => { focusErrors += chunk.toString(); });
  const focusExit = once(focusTest, 'exit');
  try {
    await waitFor('hotkey sent with independent window focused', () => {
      assert.equal(focusTest.exitCode, null, `Focus helper stopped early: ${focusErrors}`);
      return focusOutput.includes('hotkey-sent');
    });
    await waitFor('timer starts while independent window remains open', async () => {
      assert.equal(focusTest.exitCode, null, `Focus helper stopped before timer started: ${focusErrors}`);
      return evaluate(widget, `document.querySelector('.qp-mini')?.dataset.mode === 'running'`);
    });
    assert.deepEqual(await focusExit, [0, null], focusErrors);
    assert.ok(focusOutput.includes('independent-window-focused'));
  } finally {
    if (focusTest.exitCode === null && focusTest.signalCode === null) {
      focusTest.kill();
      await focusExit;
    }
  }
  await waitFor('mini timer starts native measurement', () => evaluate(widget, `(() => {
    const clock = document.querySelector('.qp-clock');
    const elapsed = clock?.textContent.split(':').reduce((seconds, field) => seconds * 60 + Number(field), 0);
    return document.querySelector('.qp-mini')?.dataset.mode === 'running' && elapsed >= 5;
  })()`));
  const runningBar = await inspectTimerBar();
  assert.equal(runningBar.actionWidth, idleBar.actionWidth, 'Timer action width changes when running');
  assert.equal(runningBar.actionHeight, idleBar.actionHeight, 'Timer action height changes when running');
  assert.equal(runningBar.actionLeft, idleBar.actionLeft, 'Timer action moves when running');
  await saveScreenshot(cdp, widget, 'widget-expanded-running');
  const started = readInterruptedTimer();
  const close = session => evaluate(session, `document.querySelector('[aria-label="Zamknij mini timer"]').click()`)
    .catch(error => { if (!/Execution context was destroyed|Target closed|Session with given id not found/i.test(error.message)) throw error; });
  await close(widget);
  await waitFor('mini timer closes without stopping the timer', async () => !(await findOtherWindow()));
  const reopened = await openWidget();
  await waitFor('native pin and running timer restore in the reopened mini timer', () => evaluate(reopened, `(
    document.querySelector(${JSON.stringify(pin)})?.getAttribute('aria-pressed') === 'true'
    && document.querySelector('.qp-mini')?.dataset.mode === 'running'
  )`));
  assert.deepEqual(readInterruptedTimer(), started);
  const compactRunning = await evaluate(reopened, inspectCompactLayout);
  assertCompactLayout(compactRunning, 'compact running', compactIdle);
  assert.equal(compactRunning.title, interruptedDescription, 'The bar title should show the measurement description');
  await saveScreenshot(cdp, reopened, 'widget-compact-running');
  await close(reopened);
  await waitFor('reopened mini timer closes', async () => !(await findOtherWindow()));
  console.log('PASS: repeated key-downs in another focused window started exactly one timer; keyboard project search and restored pin also passed');
}

async function verifyShortcutAfterRestart(cdp, mainSession) {
  const evaluate = async (session, expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await waitFor('saved shortcut registered after restart', () => evaluate(mainSession, `(() => {
    const section = document.querySelector('[aria-label="Skrót klawiaturowy"]');
    return section?.querySelector('strong')?.textContent === 'Ctrl + Alt + F11' && section.textContent.includes('aktywny globalnie');
  })()`));
  await evaluate(mainSession, 'document.querySelector(".widget-open").click()');
  const target = await waitFor('mini timer after restart', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find(item => item.type === 'page' && item.targetId !== cdp.pageId && /^https?:\/\/tauri\.localhost(?::\d+)?\//.test(item.url));
  });
  const { sessionId: widget } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await waitFor('mini timer ready after restart', () => evaluate(widget, `document.querySelector('.qp-toggle')?.title.includes('Ctrl + Alt + F11') ?? false`));
  await evaluate(widget, `document.querySelector('[aria-label="Rozwiń panel"]').click()`);
  await waitFor('project search after restart', () => evaluate(widget, `document.activeElement === document.querySelector('[role="combobox"]')`));
  await evaluate(widget, `(() => {
    const input = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(secondClient)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor('project available after restart', () => evaluate(widget, `(() => {
    const options = [...document.querySelectorAll('[role="option"]')];
    return options.length === 1 && options[0].getAttribute('aria-label') === ${JSON.stringify(`Bez zadania — ${secondClient} / ${project}`)};
  })()`));
  for (const key of ['ArrowDown', 'Enter']) {
    await evaluate(widget, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);
  }
  await waitFor('description focused after restart', () => evaluate(widget, 'document.activeElement.id === "qp-description"'));
  const description = 'Dwa naciśnięcia po restarcie';
  await evaluate(widget, `(() => {
    const input = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(description)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const pressShortcut = () => {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'tests/windows-hotkey.ps1'], {
      timeout: 20_000, windowsHide: true, encoding: 'utf8',
    });
    assert.ok(output.includes('independent-window-focused'));
  };
  pressShortcut();
  await waitFor('first press starts measurement after restart', () => evaluate(widget, `document.querySelector('.qp-mini')?.dataset.mode === 'running'`));
  const activeDb = new DatabaseSync(testDb, { readOnly: true });
  let entryId;
  try {
    const rows = activeDb.prepare(`SELECT e.id, e.ended_at, d.description FROM time_entries e JOIN entry_descriptions d ON d.entry_id=e.id ORDER BY e.id`).all();
    assert.equal(rows.length, 4);
    assert.equal(rows[3].description, description);
    assert.equal(rows[3].ended_at, null);
    entryId = rows[3].id;
  } finally { activeDb.close(); }
  await waitFor('main window shows the active timer', () => evaluate(mainSession, `Boolean(document.querySelector('[aria-label="Pomiar czasu"] .timer-stop button:not(:disabled)'))`));
  await captureMainLayout(cdp, mainSession, 'running');
  await evaluate(mainSession, `(() => {
    const input = document.querySelector('[aria-label="Pomiar czasu"] .timer-picker [role="combobox"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(`${project} ${primaryClient}`)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const switchTarget = `Bez zadania — ${primaryClient} / ${project}`;
  const switchOption = `[...document.querySelectorAll('[aria-label="Pomiar czasu"] .timer-picker [role="option"]')].find(item => item.getAttribute('aria-label') === ${JSON.stringify(switchTarget)})`;
  await waitFor('other client project found by the picker', () => evaluate(mainSession, `Boolean(${switchOption})`));
  await evaluate(mainSession, `${switchOption}.click()`);
  await waitFor('picker choice is the same client and project in the lists', () => evaluate(mainSession, `(() => {
    const lists = document.querySelectorAll('[aria-label="Pomiar czasu"] select');
    return lists[0].selectedOptions[0]?.textContent === ${JSON.stringify(primaryClient)} && lists[1].selectedOptions[0]?.textContent === ${JSON.stringify(project)} && lists[2].value === '';
  })()`));
  await waitFor('switch enabled', () => evaluate(mainSession, `Boolean(document.querySelector('[aria-label="Pomiar czasu"] .timer-start button:not(:disabled)'))`));
  const replacementDescription = 'Przełączenie po błędzie zapisu';
  await evaluate(mainSession, `(() => {
    const input = document.querySelector('[aria-label="Pomiar czasu"] .timer-description input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(replacementDescription)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const switchDb = new DatabaseSync(testDb);
  try {
    switchDb.exec("CREATE TRIGGER test_reject_timer_switch AFTER INSERT ON entry_descriptions BEGIN SELECT RAISE(FAIL, 'test switch write failure'); END");
    await evaluate(mainSession, `document.querySelector('[aria-label="Pomiar czasu"] .timer-start button').click()`);
    await waitFor('failed switch shows the write error', () => evaluate(mainSession, `[...document.querySelectorAll('[role="alert"]')].some(item => item.textContent.includes('Nie udało się potwierdzić operacji') && item.textContent.includes('Nie udało się zapisać lub odczytać danych lokalnych'))`));
    assert.equal(await evaluate(mainSession, `document.body.textContent.includes('Przełączono zadanie.')`), false);
    const unchanged = switchDb.prepare('SELECT id, ended_at, duration_seconds FROM time_entries ORDER BY id').all();
    assert.equal(unchanged.length, 4);
    assert.equal(unchanged[3].id, entryId);
    assert.equal(unchanged[3].ended_at, null);
    assert.equal(unchanged[3].duration_seconds, null);
    assert.equal(await evaluate(mainSession, `document.querySelector('[aria-label="Pomiar czasu"] .timer-description input').value`), replacementDescription);
  } finally {
    switchDb.exec('DROP TRIGGER IF EXISTS test_reject_timer_switch');
    switchDb.close();
  }
  await waitFor('switch retry enabled', () => evaluate(mainSession, `Boolean(document.querySelector('[aria-label="Pomiar czasu"] .timer-start button:not(:disabled)'))`));
  await evaluate(mainSession, `document.querySelector('[aria-label="Pomiar czasu"] .timer-start button').click()`);
  await waitFor('switch retry succeeds', () => evaluate(mainSession, `document.body.textContent.includes('Przełączono zadanie.')`));
  const switchedDb = new DatabaseSync(testDb, { readOnly: true });
  try {
    const rows = switchedDb.prepare(`SELECT e.id, e.started_at, e.ended_at, d.description FROM time_entries e JOIN entry_descriptions d ON d.entry_id=e.id ORDER BY e.id`).all();
    assert.equal(rows.length, 5);
    assert.equal(rows[3].id, entryId);
    assert.equal(rows[3].ended_at, rows[4].started_at);
    assert.equal(rows[4].description, replacementDescription);
    assert.equal(rows[4].ended_at, null);
    entryId = rows[4].id;
  } finally { switchedDb.close(); }
  await waitFor('widget reflects the switched timer', () => evaluate(widget, `document.querySelector('.qp-mini')?.dataset.mode === 'running' && document.querySelector('.qp-context')?.textContent.includes(${JSON.stringify(primaryClient)})`));
  const failureDb = new DatabaseSync(testDb);
  try {
    failureDb.exec("CREATE TRIGGER test_reject_timer_stop BEFORE UPDATE OF ended_at ON time_entries BEGIN SELECT RAISE(FAIL, 'test timer write failure'); END");
    await evaluate(mainSession, `document.querySelector('[aria-label="Pomiar czasu"] .timer-stop button').click()`);
    await waitFor('write failure is shown to the user', () => evaluate(mainSession, `[...document.querySelectorAll('[role="alert"]')].some(item => item.textContent.includes('Nie udało się potwierdzić operacji') && item.textContent.includes('Nie udało się zapisać lub odczytać danych lokalnych'))`));
    await waitFor('timer still shown as running after the failed stop', () => evaluate(mainSession, `Boolean(document.querySelector('[aria-label="Pomiar czasu"] .status.running'))`));
    assert.equal(await evaluate(mainSession, `document.body.textContent.includes('Pomiar zatrzymany.')`), false);
    const unchanged = failureDb.prepare('SELECT id, ended_at, duration_seconds FROM time_entries ORDER BY id').all();
    assert.equal(unchanged.length, 5);
    assert.equal(unchanged[4].id, entryId);
    assert.equal(unchanged[4].ended_at, null);
    assert.equal(unchanged[4].duration_seconds, null);
  } finally {
    failureDb.exec('DROP TRIGGER IF EXISTS test_reject_timer_stop');
    failureDb.close();
  }
  await waitFor('switched timer runs for at least six seconds', () => evaluate(widget, `(() => {
    const clock = document.querySelector('.qp-clock');
    const elapsed = clock?.textContent.split(':').reduce((seconds, field) => seconds * 60 + Number(field), 0);
    return document.querySelector('.qp-mini')?.dataset.mode === 'running' && elapsed >= 6;
  })()`));
  pressShortcut();
  await waitFor('second press stops measurement after restart', () => evaluate(widget, `document.querySelector('.qp-mini')?.dataset.mode === 'idle'`));
  const stoppedDb = new DatabaseSync(testDb, { readOnly: true });
  try {
    const rows = stoppedDb.prepare('SELECT id, ended_at, duration_seconds FROM time_entries ORDER BY id').all();
    assert.equal(rows.length, 5);
    assert.equal(rows[4].id, entryId);
    assert.ok(rows[4].ended_at && rows[4].duration_seconds >= 5);
  } finally { stoppedDb.close(); }
  console.log('PASS: failed Switch and Stop showed errors, preserved the running entry, and succeeded once on retry');
}

async function verifyRestoreRetry(cdp, sessionId) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const section = '[aria-label="Bezpieczeństwo danych"]';
  const click = label => evaluate(`[...document.querySelectorAll(${JSON.stringify(section)} + ' button')].find(button => button.textContent.trim() === ${JSON.stringify(label)} && !button.disabled)?.click()`);
  await click('Utwórz kopię');
  const backupPath = await waitFor('verified backup created in the test profile', () =>
    evaluate(`document.querySelector(${JSON.stringify(section)} + ' [role="status"] code')?.textContent || null`));
  const backupDir = join(process.env.APPDATA, 'pl.tracker.personal.testonly', 'backups');
  const backupFiles = await readdir(backupDir);
  assert.equal(backupFiles.length, 1);
  assert.equal(backupPath, join(backupDir, backupFiles[0]));
  const savedBackupDir = join(process.env.APPDATA, 'pl.tracker.personal.testonly', 'saved-backups-test');
  await rename(backupDir, savedBackupDir);
  const source = join(savedBackupDir, backupFiles[0]);
  await writeFile(backupDir, 'forced backup creation failure', { flag: 'wx' });
  try {
    await evaluate(`(() => {
      const details = document.querySelector(${JSON.stringify(section)} + ' details');
      details.open = true;
      const input = details.querySelector('input[type="text"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(source)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor('backup check enabled', () => evaluate(`[...document.querySelectorAll(${JSON.stringify(section)} + ' button')].some(button => button.textContent.trim() === 'Sprawdź kopię' && !button.disabled)`));
    await click('Sprawdź kopię');
    await waitFor('restore preview', () => evaluate(`Boolean(document.querySelector(${JSON.stringify(section)} + ' input[type="checkbox"]'))`));
    await evaluate(`document.querySelector(${JSON.stringify(section)} + ' input[type="checkbox"]').click()`);
    await click('Przywróć kopię');
    await waitFor('restore failure displayed', () => evaluate(`document.body.textContent.includes('Nie udało się przywrócić kopii. Sprawdź dane i kopie bezpieczeństwa przed ponowieniem.')`));
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(section)} + ' input[type="checkbox"]')?.checked`), false);
    const db = new DatabaseSync(testDb, { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM time_entries').get().count, 3); }
    finally { db.close(); }
    await unlink(backupDir);
    await evaluate(`document.querySelector(${JSON.stringify(section)} + ' input[type="checkbox"]').click()`);
    await click('Przywróć kopię');
    await waitFor('restore succeeds after retry', () => evaluate(`document.body.textContent.includes('Kopia została przywrócona')`));
    assert.equal((await readdir(backupDir)).filter(name => name.endsWith('.sqlite3')).length, 1);
    console.log('PASS: real restore failure kept the preview and data; retry created a safety backup and succeeded');
  } finally {
    const obstacle = await stat(backupDir).catch(() => null);
    if (obstacle?.isFile()) await unlink(backupDir);
  }
}

// History row actions live in the "⋯" menu (EntryMenu). Open it like a person would (mouse, or
// Enter/Space and the arrow keys), check that the item is visible and enabled, then choose it.
// Returns false when the row or its menu is not ready yet, so callers can retry.
async function chooseFromEntryMenu(cdp, sessionId, evaluate, description, labelPrefix, mode) {
  const row = `[...document.querySelectorAll('section.history tbody tr')].find(row => row.textContent.includes(${JSON.stringify(description)}) && row.querySelector('.entry-menu-trigger'))`;
  const trigger = `${row}?.querySelector('.entry-menu-trigger')`;
  const item = `${row}?.querySelector(${JSON.stringify(`[role="menu"] [role="menuitem"][aria-label^="${labelPrefix}"]`)})`;
  const shown = element => `(el => Boolean(el && !el.disabled && !el.closest('[hidden]') && el.getClientRects().length > 0))(${element})`;
  if (!await evaluate(shown(trigger))) return false;
  if (await evaluate(`${trigger}.getAttribute('aria-expanded') === 'true'`)) {
    await evaluate(`${trigger}.click()`); // close a menu left open by an earlier attempt
  }
  const press = async (key, code, keyCode, text) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }, sessionId);
  };
  if (mode === 'mouse') await evaluate(`${trigger}.click()`);
  else {
    await evaluate(`${trigger}.focus()`);
    if (mode === 'enter') await press('Enter', 'Enter', 13, '\r');
    else await press(' ', 'Space', 32, ' ');
  }
  await waitFor('entry menu opens with a visible item', () => evaluate(`${trigger}.getAttribute('aria-expanded') === 'true' && ${shown(item)}`));
  if (mode === 'mouse') await evaluate(`${item}.click()`);
  else {
    // Keyboard: focus starts on the first item; walk with the arrows (Space mode wraps upwards from it).
    const [key, keyCode] = mode === 'enter' ? ['ArrowDown', 40] : ['ArrowUp', 38];
    for (let step = 0; step < 6 && !await evaluate(`document.activeElement === ${item}`); step++) await press(key, key, keyCode);
    assert.ok(await evaluate(`document.activeElement === ${item} && ${shown(item)}`), `keyboard focus did not reach ${labelPrefix}`);
    await press('Enter', 'Enter', 13, '\r');
  }
  await waitFor('entry menu closes after the choice', () => evaluate(`${trigger}?.getAttribute('aria-expanded') !== 'true'`));
  return true;
}

// "⋯" menu of a History entry as a person uses it: keyboard opening, arrows, Home/End, Escape returning
// focus to the button, and a mouse click outside. Also captures History with the menu open.
async function verifyEntryMenu(cdp, sessionId) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const press = async (key, keyCode) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode }, sessionId);
  };
  const row = `[...document.querySelectorAll('section.history tbody tr')].find(row => row.textContent.includes(${JSON.stringify(primaryDescription)}) && row.querySelector('.entry-menu-trigger'))`;
  const trigger = `${row}?.querySelector('.entry-menu-trigger')`;
  const state = `(() => {
    const trigger = ${trigger};
    const menu = trigger && document.getElementById(trigger.getAttribute('aria-controls'));
    const items = menu ? [...menu.querySelectorAll('[role="menuitem"]')] : [];
    const enabled = items.filter(item => !item.disabled);
    const focused = items.indexOf(document.activeElement);
    return { expanded: trigger?.getAttribute('aria-expanded'), hidden: menu ? menu.hidden : null,
      visible: Boolean(menu && !menu.hidden && menu.getClientRects().length), focused, first: items.indexOf(enabled[0]),
      last: items.indexOf(enabled[enabled.length - 1]), focusedVisible: focused >= 0 && items[focused].getClientRects().length > 0,
      triggerFocused: document.activeElement === trigger, labels: items.map(item => item.getAttribute('aria-label')) };
  })()`;
  await waitFor('History entry menu button', () => evaluate(`Boolean(${trigger} && !${trigger}.disabled)`));
  assert.equal((await evaluate(state)).expanded, 'false');
  // Keyboard: ArrowDown on the button opens the menu with focus on the first enabled item.
  await evaluate(`${trigger}.focus()`);
  await press('ArrowDown', 40);
  let menu = await waitFor('entry menu opened from the keyboard', async () => { const s = await evaluate(state); return s.expanded === 'true' && s.visible && s.focused >= 0 ? s : null; });
  assert.equal(menu.focused, menu.first, 'focus starts on the first enabled item');
  assert.ok(menu.focusedVisible);
  assert.ok(menu.labels.every(label => label && label.includes(':')), 'every item names the entry it acts on');
  await press('ArrowDown', 40);
  menu = await evaluate(state);
  assert.ok(menu.focused > menu.first && menu.focusedVisible, 'ArrowDown moves to the next enabled item');
  await press('End', 35);
  assert.equal((await evaluate(state)).focused, menu.last);
  await press('Home', 36);
  assert.equal((await evaluate(state)).focused, menu.first);
  await captureSection(cdp, sessionId, 'section.history', `(${state}).visible`, 'history-entry-menu');
  // Escape closes the menu and returns focus to its button (the screenshot keeps the menu state).
  await evaluate(`[...${trigger}.closest('.entry-menu').querySelectorAll('[role="menuitem"]')].find(item => !item.disabled).focus()`);
  await press('Escape', 27);
  menu = await waitFor('Escape closes the entry menu', async () => { const s = await evaluate(state); return s.expanded === 'false' ? s : null; });
  assert.equal(menu.hidden, true);
  assert.equal(menu.triggerFocused, true, 'focus returns to the menu button');
  // Mouse: opening by click and closing by a pointer press outside the menu.
  await evaluate(`${trigger}.click()`);
  await waitFor('entry menu opened by click', async () => (await evaluate(state)).visible);
  await evaluate(`document.querySelector('section.history h2').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await waitFor('click outside closes the entry menu', async () => (await evaluate(state)).expanded === 'false');
  console.log('PASS: History entry menu opens from the keyboard and by click, moves with arrows/Home/End, and closes with Escape (focus back) or a click outside');
}

async function verifyDraft(cdp, sessionId, phase, primary) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const text = 'Szkic po przerwaniu aplikacji';
  if (phase === 'verify-recovery') {
    await waitFor('editor action for the first client is ready', () => evaluate(`(() => {
      const row = [...document.querySelectorAll('section.history tbody tr')].find(item => item.textContent.includes(${JSON.stringify(primaryDescription)}) && item.querySelector('.entry-menu-trigger'));
      const trigger = row?.querySelector('.entry-menu-trigger');
      const action = row?.querySelector('[role="menuitem"][aria-label^="Popraw wpis:"]');
      return Boolean(trigger && !trigger.disabled && action && !action.disabled);
    })()`));
    await waitFor('entry editor opens', async () => {
      if (await evaluate(`Boolean(document.querySelector('#entry-draft-description'))`)) return true;
      await chooseFromEntryMenu(cdp, sessionId, evaluate, primaryDescription, 'Popraw wpis:', 'mouse');
      return false;
    }).catch(async error => {
      const alerts = await evaluate(`[...document.querySelectorAll('[role="alert"]')].map(node => node.textContent.trim())`);
      throw new Error(`${error.message}; application alerts: ${JSON.stringify(alerts)}`);
    });
    // The entry card (editor) as opened from the History menu (UIQ evidence).
    await captureSection(cdp, sessionId, '.entry-draft-panel[aria-label="Edycja wpisu"]', `Boolean(document.querySelector('.entry-draft-panel #entry-draft-description'))`, 'entry-editor');
    await evaluate(`(() => {
      const field = document.querySelector('#entry-draft-description');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const path = join(process.env.APPDATA, 'pl.tracker.personal.testonly', 'entry-drafts', 'entry-1.json');
    await waitFor('draft snapshot saved to test profile', async () => {
      try { return JSON.parse(await readFile(path, 'utf8')).fields.description === text; }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    });
    const db = new DatabaseSync(testDb, { readOnly: true });
    try { assert.equal(db.prepare('SELECT description FROM entry_descriptions WHERE entry_id=1').get().description, primaryDescription); }
    finally { db.close(); }
    const window = await waitFor('main window while editing', () => inspectWindow('Find', primary.pid) || null);
    assert.equal(inspectWindow('Close', primary.pid, window), 'posted');
    await waitFor('unsaved edit close confirmation', () => evaluate(`Boolean(document.querySelector('dialog.entry-draft-dialog[open]'))`));
    assert.equal(inspectWindow('Visibility', primary.pid, window), 'visible');
    const labels = await evaluate(`[...document.querySelectorAll('dialog.entry-draft-dialog[open] button')].map(button => button.textContent.trim())`);
    assert.deepEqual(labels, ['Zapisz', 'Odrzuć zmiany', 'Pozostań']);
    await evaluate(`[...document.querySelectorAll('dialog.entry-draft-dialog[open] button')].find(button => button.textContent.trim() === 'Pozostań').click()`);
    await waitFor('close confirmation dismissed', () => evaluate(`!document.querySelector('dialog.entry-draft-dialog[open]')`));
    assert.equal(await evaluate(`document.querySelector('#entry-draft-description')?.value`), text);
    assert.equal(inspectWindow('Visibility', primary.pid, window), 'visible');
    await writeFile(join(process.env.APPDATA, 'pl.tracker.personal.testonly', 'draft-sort.txt'), 'newest', { flag: 'wx' });
    console.log('draft: uncommitted snapshot saved while original entry remained unchanged');
    console.log('PASS: closing the window asked about the draft and Stay preserved it');
    return;
  }
  const button = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Przejdź do szkiców')`;
  await waitFor('draft reminder after process restart', () => evaluate(`Boolean(${button})`));
  await evaluate(`${button}.click()`);
  await waitFor('restore draft button', () => evaluate(`Boolean([...document.querySelectorAll('[aria-label="Szkice wpisów"] button')].find(button => button.textContent.trim() === 'Przywróć szkic' && !button.disabled))`));
  const profileDir = join(process.env.APPDATA, 'pl.tracker.personal.testonly');
  const preference = join(profileDir, 'draft-sort.txt');
  const preservedPreference = join(profileDir, 'draft-sort-before-fault-test.txt');
  const draftPath = join(profileDir, 'entry-drafts', 'entry-1.json');
  const draftBefore = await readFile(draftPath);
  assert.equal(await readFile(preference, 'utf8'), 'newest');
  await rename(preference, preservedPreference);
  let restoredPreference = false;
  const sortWrites = new Set();
  const sortWatcher = watch(profileDir, (_event, filename) => {
    const name = filename?.toString();
    if (name?.startsWith('.draft-sort.txt-') && name.endsWith('.tmp')) sortWrites.add(name);
  });
  try {
    await mkdir(preference);
    await evaluate(`(() => {
      const select = document.querySelector('[aria-label="Szkice wpisów"] select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'oldest');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const sortAlert = `[aria-label="Szkice wpisów"] [role="alert"]`;
    await waitFor('sort preference failure is visible', () => evaluate(`document.querySelector(${JSON.stringify(sortAlert)})?.textContent.includes('Nie udało się zapamiętać sortowania')`));
    await waitFor('initial sort write observed', () => sortWrites.size === 1);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Szkice wpisów"] select').value`), 'oldest');
    for (let attempt = 0; attempt < 2; attempt++) {
      await waitFor('manual sort retry enabled', () => evaluate(`Boolean([...document.querySelectorAll(${JSON.stringify(sortAlert)} + ' button')].find(item => item.textContent.trim() === 'Spróbuj ponownie' && !item.disabled))`));
      await evaluate(`[...document.querySelectorAll(${JSON.stringify(sortAlert)} + ' button')].find(item => item.textContent.trim() === 'Spróbuj ponownie').click()`);
      await waitFor('failed manual sort retry completes', async () => sortWrites.size === attempt + 2 && await evaluate(`Boolean([...document.querySelectorAll(${JSON.stringify(sortAlert)} + ' button')].find(item => item.textContent.trim() === 'Spróbuj ponownie' && !item.disabled))`));
      assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(sortAlert)}).length`), 1);
      assert.equal(await readFile(preservedPreference, 'utf8'), 'newest');
      assert.deepEqual(await readFile(draftPath), draftBefore);
    }
    const closeDrafts = `[...document.querySelectorAll('[aria-label="Szkice wpisów"] button')].find(item => item.textContent.trim() === 'Zamknij listę')`;
    const openDrafts = `[...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Szkice (1)')`;
    await evaluate(`${closeDrafts}.click()`);
    await waitFor('draft list closed', () => evaluate(`!document.querySelector('[aria-label="Szkice wpisów"]')`));
    await evaluate(`${openDrafts}.click()`);
    await waitFor('one automatic retry after entering list', async () => sortWrites.size === 4 && await evaluate(`Boolean([...document.querySelectorAll(${JSON.stringify(sortAlert)} + ' button')].find(item => item.textContent.trim() === 'Spróbuj ponownie' && !item.disabled))`));
    await evaluate(`${closeDrafts}.click()`);
    await waitFor('draft list closed again', () => evaluate(`!document.querySelector('[aria-label="Szkice wpisów"]')`));
    await evaluate(`${openDrafts}.click()`);
    await waitFor('draft list reopened within retry interval', () => evaluate(`Boolean(document.querySelector(${JSON.stringify(sortAlert)}))`));
    await delay(750);
    assert.equal(sortWrites.size, 4, 'Reopening before the retry interval must not write again');
    await rmdir(preference);
    await rename(preservedPreference, preference);
    restoredPreference = true;
    await evaluate(`[...document.querySelectorAll(${JSON.stringify(sortAlert)} + ' button')].find(item => item.textContent.trim() === 'Spróbuj ponownie').click()`);
    await waitFor('successful retry clears sort warning', () => evaluate(`!document.querySelector(${JSON.stringify(sortAlert)})`));
    await waitFor('successful sort retry observed', () => sortWrites.size === 5);
    assert.equal(await readFile(preference, 'utf8'), 'oldest');
    assert.deepEqual(await readFile(draftPath), draftBefore);
    assert.equal((await readdir(profileDir)).some(name => name.startsWith('.draft-sort.txt-') && name.endsWith('.tmp')), false);
    console.log('PASS: manual and automatic sort retries were counted, rate-limited, and preserved the draft until successful save');
  } finally {
    sortWatcher.close();
    if (!restoredPreference) {
      const obstacle = await stat(preference).catch(() => null);
      if (obstacle?.isDirectory()) await rmdir(preference);
      await rename(preservedPreference, preference);
    }
  }
  await evaluate(`[...document.querySelectorAll('[aria-label="Szkice wpisów"] button')].find(button => button.textContent.trim() === 'Przywróć szkic').click()`);
  await waitFor('draft content restored', () => evaluate(`document.querySelector('#entry-draft-description')?.value === ${JSON.stringify(text)}`));
  await evaluate(`[...document.querySelectorAll('[aria-label="Edycja wpisu"] button')].find(button => button.textContent.trim() === 'Zachowaj szkic').click()`);
  await waitFor('restored draft put aside', () => evaluate(`!document.querySelector('[aria-label="Edycja wpisu"]')`));
  const beforeConflict = new DatabaseSync(testDb, { readOnly: true });
  let originalTimes;
  try {
    originalTimes = beforeConflict.prepare('SELECT started_at,ended_at,duration_seconds FROM time_entries WHERE id=1').get();
    assert.equal(beforeConflict.prepare('SELECT COUNT(*) AS count FROM billable_entries WHERE entry_id=1').get().count, 0);
  } finally { beforeConflict.close(); }
  const concurrentChange = await cdp.send('Runtime.evaluate', {
    expression: `window.__TAURI_INTERNALS__.invoke('set_entry_billable', { entryId: 1, expected: false, billable: true })`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (concurrentChange.exceptionDetails) throw new Error(concurrentChange.exceptionDetails.exception?.description ?? concurrentChange.exceptionDetails.text);
  await waitFor('draft can be reviewed after concurrent change', () => evaluate(`Boolean([...document.querySelectorAll('[aria-label="Szkice wpisów"] button')].find(button => button.textContent.trim() === 'Przywróć szkic' && !button.disabled))`));
  await evaluate(`[...document.querySelectorAll('[aria-label="Szkice wpisów"] button')].find(button => button.textContent.trim() === 'Przywróć szkic').click()`);
  await waitFor('conflicting draft comparison', () => evaluate(`document.querySelector('.entry-draft-review')?.textContent.includes('Wpis zmienił się od utworzenia szkicu')`));
  const review = await evaluate(`(() => {
    const panel = document.querySelector('.entry-draft-review');
    return { text: panel.textContent, checked: [...panel.querySelectorAll('input[type="checkbox"]')].filter(item => item.checked).length,
      transferDisabled: [...panel.querySelectorAll('button')].find(item => item.textContent.trim() === 'Przenieś wybrane pola').disabled };
  })()`);
  assert.ok(review.text.includes(primaryDescription) && review.text.includes(text));
  assert.equal(review.checked, 0);
  assert.equal(review.transferDisabled, true);
  // UIQ-05 / WCAG 2.5.8: the field checkboxes have no visible text; the label around each one is a 32×32 target.
  const reviewTargets = await evaluate(`[...document.querySelectorAll('.entry-draft-review input[type="checkbox"]')].map(item => { const rect = (item.closest('label') ?? item).getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)]; })`);
  console.log(`UI_LAYOUT draft-review-checkboxes ${JSON.stringify(reviewTargets)}`);
  assert.ok(reviewTargets.length > 0 && reviewTargets.every(([width, height]) => width >= 24 && height >= 24), `draft review checkbox targets below 24×24: ${JSON.stringify(reviewTargets)}`);
  await evaluate(`document.querySelector('.entry-draft-review input[aria-label="Przenieś pole Opis"]').click()`);
  await evaluate(`[...document.querySelectorAll('.entry-draft-review button')].find(item => item.textContent.trim() === 'Przenieś wybrane pola').click()`);
  await waitFor('selected draft field restored', () => evaluate(`document.querySelector('#entry-draft-description')?.value === ${JSON.stringify(text)}`));
  await evaluate(`document.querySelector('[aria-label="Edycja wpisu"] button[type="submit"]').click()`);
  await waitFor('draft applied once to history', () => evaluate(`[...document.querySelectorAll('section.history tbody tr')].some(row => row.textContent.includes(${JSON.stringify(text)}))`));
  const db = new DatabaseSync(testDb, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT description FROM entry_descriptions WHERE entry_id=1').get().description, text);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM description_revisions WHERE entry_id=1').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billable_entries WHERE entry_id=1').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_revisions WHERE entry_id=1').get().count, 1);
    assert.deepEqual(db.prepare('SELECT started_at,ended_at,duration_seconds FROM time_entries WHERE id=1').get(), originalTimes);
  } finally { db.close(); }
  console.log('PASS: draft survived interruption, identified a concurrent change, and applied only the selected field');

  await waitFor('second entry editor opens', async () => {
    if (await evaluate(`Boolean(document.querySelector('#entry-draft-description'))`)) return true;
    await chooseFromEntryMenu(cdp, sessionId, evaluate, secondDescription, 'Popraw wpis:', 'enter');
    return false;
  });
  const discardedText = 'Niezapisana edycja do odrzucenia';
  await evaluate(`(() => {
    const field = document.querySelector('#entry-draft-description');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(discardedText)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const window = await waitFor('main window before discarding draft', () => inspectWindow('Find', primary.pid) || null);
  assert.equal(inspectWindow('Close', primary.pid, window), 'posted');
  await waitFor('draft discard confirmation', () => evaluate(`Boolean(document.querySelector('dialog.entry-draft-dialog[open]'))`));
  await evaluate(`[...document.querySelectorAll('dialog.entry-draft-dialog[open] button')].find(button => button.textContent.trim() === 'Odrzuć zmiany').click()`);
  await waitFor('discard hides the main window', () => inspectWindow('Visibility', primary.pid, window) === 'hidden');
  const unchanged = new DatabaseSync(testDb, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('SELECT description FROM entry_descriptions WHERE entry_id=2').get().description, secondDescription);
    assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM description_revisions WHERE entry_id=2').get().count, 0);
  } finally { unchanged.close(); }
  const relaunch = spawn(exe, [], { env: process.env, stdio: 'ignore', windowsHide: true });
  try {
    assert.deepEqual(await once(relaunch, 'exit', { signal: AbortSignal.timeout(12_000) }), [0, null]);
  } finally {
    if (relaunch.pid && relaunch.exitCode === null && relaunch.signalCode === null) {
      const exited = once(relaunch, 'exit');
      relaunch.kill();
      await exited;
    }
  }
  await waitFor('second launch restores the window after discard', () => inspectWindow('Visibility', primary.pid, window) === 'visible');
  assert.equal(await evaluate(`Boolean(document.querySelector('#entry-draft-description'))`), false);
  console.log('PASS: discard left the original entry unchanged and reopened the same window');

  await waitFor('second entry reopens after discard', async () => {
    if (await evaluate(`Boolean(document.querySelector('#entry-draft-description'))`)) return true;
    await chooseFromEntryMenu(cdp, sessionId, evaluate, secondDescription, 'Popraw wpis:', 'space');
    return false;
  });
  const savedText = 'Korekta zapisana przy zamknięciu';
  await evaluate(`(() => {
    const field = document.querySelector('#entry-draft-description');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(savedText)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const originalEnd = await evaluate(`document.querySelectorAll('[aria-label="Edycja wpisu"] input[type="datetime-local"]')[1].value`);
  await evaluate(`(() => {
    const field = document.querySelectorAll('[aria-label="Edycja wpisu"] input[type="datetime-local"]')[1];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(inspectWindow('Close', primary.pid, window), 'posted');
  await waitFor('draft save confirmation', () => evaluate(`Boolean(document.querySelector('dialog.entry-draft-dialog[open]'))`));
  await evaluate(`[...document.querySelectorAll('dialog.entry-draft-dialog[open] button')].find(button => button.textContent.trim() === 'Zapisz').click()`);
  await waitFor('invalid edit stays open', () => evaluate(`document.querySelector('dialog.entry-draft-dialog[open] [role="alert"]')?.textContent.includes('Sprawdź daty i godziny')`));
  assert.equal(inspectWindow('Visibility', primary.pid, window), 'visible');
  assert.equal(await evaluate(`document.querySelector('#entry-draft-description')?.value`), savedText);
  const rejected = new DatabaseSync(testDb, { readOnly: true });
  try {
    assert.equal(rejected.prepare('SELECT description FROM entry_descriptions WHERE entry_id=2').get().description, secondDescription);
    assert.equal(rejected.prepare('SELECT COUNT(*) AS count FROM description_revisions WHERE entry_id=2').get().count, 0);
  } finally { rejected.close(); }
  await evaluate(`[...document.querySelectorAll('dialog.entry-draft-dialog[open] button')].find(button => button.textContent.trim() === 'Pozostań').click()`);
  await waitFor('invalid edit dialog dismissed', () => evaluate(`!document.querySelector('dialog.entry-draft-dialog[open]')`));
  await evaluate(`(() => {
    const field = document.querySelectorAll('[aria-label="Edycja wpisu"] input[type="datetime-local"]')[1];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(originalEnd)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const injectedFailure = new DatabaseSync(testDb);
  try {
    injectedFailure.exec("CREATE TRIGGER test_reject_revision BEFORE INSERT ON description_revisions BEGIN SELECT RAISE(FAIL, 'test write failure'); END");
  } finally { injectedFailure.close(); }
  assert.equal(inspectWindow('Close', primary.pid, window), 'posted');
  await waitFor('corrected draft save confirmation', () => evaluate(`Boolean(document.querySelector('dialog.entry-draft-dialog[open]'))`));
  await evaluate(`[...document.querySelectorAll('dialog.entry-draft-dialog[open] button')].find(button => button.textContent.trim() === 'Zapisz').click()`);
  await waitFor('SQLite error keeps the editor open', () => evaluate(`document.querySelector('dialog.entry-draft-dialog[open] [role="alert"]')?.textContent.includes('Nie udało się zapisać lub odczytać danych lokalnych')`));
  assert.equal(inspectWindow('Visibility', primary.pid, window), 'visible');
  assert.equal(await evaluate(`document.querySelector('#entry-draft-description')?.value`), savedText);
  const blocked = new DatabaseSync(testDb);
  try {
    assert.equal(blocked.prepare('SELECT description FROM entry_descriptions WHERE entry_id=2').get().description, secondDescription);
    assert.equal(blocked.prepare('SELECT COUNT(*) AS count FROM description_revisions WHERE entry_id=2').get().count, 0);
    blocked.exec('DROP TRIGGER test_reject_revision');
  } finally { blocked.close(); }
  await evaluate(`[...document.querySelectorAll('dialog.entry-draft-dialog[open] button')].find(button => button.textContent.trim() === 'Zapisz').click()`);
  await waitFor('save hides the main window', () => inspectWindow('Visibility', primary.pid, window) === 'hidden');
  const saved = new DatabaseSync(testDb, { readOnly: true });
  try {
    assert.equal(saved.prepare('SELECT description FROM entry_descriptions WHERE entry_id=2').get().description, savedText);
    assert.equal(saved.prepare('SELECT COUNT(*) AS count FROM description_revisions WHERE entry_id=2').get().count, 1);
  } finally { saved.close(); }
  const reopen = spawn(exe, [], { env: process.env, stdio: 'ignore', windowsHide: true });
  try {
    assert.deepEqual(await once(reopen, 'exit', { signal: AbortSignal.timeout(12_000) }), [0, null]);
  } finally {
    if (reopen.pid && reopen.exitCode === null && reopen.signalCode === null) {
      const exited = once(reopen, 'exit');
      reopen.kill();
      await exited;
    }
  }
  await waitFor('second launch restores the window after save', () => inspectWindow('Visibility', primary.pid, window) === 'visible');
  await waitFor('saved correction appears in history', () => evaluate(`[...document.querySelectorAll('section.history tbody tr')].some(row => row.textContent.includes(${JSON.stringify(savedText)}))`));
  console.log('PASS: validation and SQLite failures preserved the edit; retry saved exactly one revision');
}

// PTT-36 (T20/T26): write failures in the running app, on the synthetic CI test profile only.
// A second SQLite connection holds a RESERVED lock (BEGIN IMMEDIATE), so every write of the
// app fails with SQLITE_BUSY after its busy timeout while reads still work, which is the
// application-level form of a database that cannot be written. A trigger variant fails the
// switch inside its transaction, after the previous entry was already updated.
const writeFailure = {
  firstDescription: 'PTT-36 pomiar przy awarii zapisu',
  secondDescription: 'PTT-36 przełączenie po awarii',
  editDescription: 'PTT-36 korekta przy awarii zapisu',
  // The corrected entry is the one started by the switch: its start is the exact
  // millisecond end of the previous entry, so a correction of only its end must not
  // move that shared boundary (CI run 45062958698 hit this by chance on an older entry).
  editEntryDescription: 'PTT-36 przełączenie po awarii',
};

function writeFailureState() {
  const db = new DatabaseSync(testDb, { readOnly: true });
  try {
    return {
      entries: db.prepare(`SELECT e.id, e.project_id, e.task_id, e.started_at, e.ended_at, e.duration_seconds, e.manually_resolved,
        COALESCE(d.description, '') AS description FROM time_entries e LEFT JOIN entry_descriptions d ON d.entry_id=e.id ORDER BY e.id`).all().map(row => ({ ...row })),
      revisions: db.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get().count,
      descriptionRevisions: db.prepare('SELECT COUNT(*) AS count FROM description_revisions').get().count,
      billable: db.prepare('SELECT COUNT(*) AS count FROM billable_entries').get().count,
    };
  } finally { db.close(); }
}

function holdWriteLock() {
  const lock = new DatabaseSync(testDb);
  lock.exec('BEGIN IMMEDIATE');
  return { release() { try { lock.exec('ROLLBACK'); } finally { lock.close(); } } };
}

async function verifyWriteFailure(cdp, sessionId) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const timer = '[aria-label="Pomiar czasu"]';
  // Only alerts rendered after a click count: alerts already on screen are marked first.
  const markStale = `document.querySelectorAll('[role="alert"]').forEach(node => { node.dataset.ptt36Stale = '1'; })`;
  const failureShown = `[...document.querySelectorAll('[role="alert"]')].some(node => !node.dataset.ptt36Stale && node.textContent.includes('Nie udało się potwierdzić operacji') && node.textContent.includes('Nie udało się zapisać lub odczytać danych lokalnych'))`;
  const successShown = message => `[...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes(${JSON.stringify(message)}))`;
  const activeId = () => evaluate(`window.__TAURI_INTERNALS__.invoke('get_snapshot').then(s => s.active ? { id: s.active.id, recovered: s.active.recovered, uncertain: s.active.uncertain, description: s.active.description } : null)`);
  const running = `Boolean(document.querySelector(${JSON.stringify(`${timer} .status.running`)}))`;
  const idle = `!document.querySelector(${JSON.stringify(`${timer} .timer-stop button`)}) && !document.querySelector(${JSON.stringify(`${timer} .status.running`)})`;
  const enabledButton = selector => `(el => Boolean(el && !el.disabled))(document.querySelector(${JSON.stringify(selector)}))`;
  const projects = (() => {
    const db = new DatabaseSync(testDb, { readOnly: true });
    try {
      return db.prepare(`SELECT p.id, p.client_id AS clientId, c.name AS client FROM projects p JOIN clients c ON c.id=p.client_id ORDER BY p.id`).all().map(row => ({ ...row }));
    } finally { db.close(); }
  })();
  const first = projects.find(item => item.client === primaryClient);
  const second = projects.find(item => item.client === secondClient);
  assert.ok(first && second && first.id !== second.id);

  // A synthetic running entry for this scenario; the operations under test go through the UI.
  const before = writeFailureState();
  assert.ok(before.entries.every(entry => entry.ended_at), 'no timer may run before the write-failure scenario');
  await evaluate(`window.__TAURI_INTERNALS__.invoke('start_project_timer', { projectId: ${first.id}, taskId: null, expectedActiveId: null, description: ${JSON.stringify(writeFailure.firstDescription)} })`);
  await waitFor('write-failure timer is running', () => evaluate(running));
  const started = await activeId();
  assert.ok(started && !started.recovered && !started.uncertain && started.description === writeFailure.firstDescription);
  await delay(3_000);
  const runningState = writeFailureState();

  // Stop while the database cannot be written.
  let lock = holdWriteLock();
  try {
    await waitFor('Stop is enabled', () => evaluate(enabledButton(`${timer} .timer-stop button`)));
    await evaluate(markStale);
    await evaluate(`document.querySelector(${JSON.stringify(`${timer} .timer-stop button`)}).click()`);
    await waitFor('Stop failure is reported', () => evaluate(failureShown));
    assert.equal(await evaluate(successShown('Pomiar zatrzymany.')), false, 'Stop reported success although nothing was saved');
    await waitFor('timer still running after failed Stop', () => evaluate(running));
    assert.deepEqual(await activeId(), started);
    assert.deepEqual(writeFailureState(), runningState, 'failed Stop changed the database');
    console.log('PASS: T20 Stop with an unwritable database reported the error, kept the same timer and changed nothing');

    // Switch to another client's project while the database cannot be written.
    await evaluate(`(() => {
      document.querySelector(${JSON.stringify(`${timer} details.timer-lists`)}).open = true;
      const [client, project] = document.querySelectorAll(${JSON.stringify(`${timer} .timer-lists select`)});
      const set = (select, value) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value); select.dispatchEvent(new Event('change', { bubbles: true })); };
      set(client, ${JSON.stringify(String(second.clientId))});
    })()`);
    await waitFor('second client projects listed', () => evaluate(`[...document.querySelectorAll(${JSON.stringify(`${timer} .timer-lists select`)})[1].options].some(option => option.value === ${JSON.stringify(String(second.id))})`));
    await evaluate(`(() => {
      const project = document.querySelectorAll(${JSON.stringify(`${timer} .timer-lists select`)})[1];
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(project, ${JSON.stringify(String(second.id))});
      project.dispatchEvent(new Event('change', { bubbles: true }));
      const description = document.querySelector(${JSON.stringify(`${timer} .timer-description input`)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(description, ${JSON.stringify(writeFailure.secondDescription)});
      description.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor('Switch is enabled', () => evaluate(enabledButton(`${timer} .timer-start button`)));
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${timer} .timer-start button`)}).textContent.includes('Przełącz zadanie')`), true);
    await evaluate(markStale);
    await evaluate(`document.querySelector(${JSON.stringify(`${timer} .timer-start button`)}).click()`);
    await waitFor('Switch failure is reported', () => evaluate(failureShown));
    assert.equal(await evaluate(successShown('Przełączono zadanie.')), false, 'Switch reported success although nothing was saved');
    await waitFor('timer still running after failed Switch', () => evaluate(running));
    assert.deepEqual(await activeId(), started);
    assert.deepEqual(writeFailureState(), runningState, 'failed Switch changed the database');
    console.log('PASS: T20 Switch with an unwritable database reported the error, kept the same timer and changed nothing');
  } finally { lock.release(); }

  // Switch failing inside its transaction: the previous entry is updated first, then the
  // insert of the new entry fails. The update must be rolled back with it.
  const trigger = new DatabaseSync(testDb);
  try { trigger.exec("CREATE TRIGGER test_reject_switch BEFORE INSERT ON time_entries BEGIN SELECT RAISE(FAIL, 'test write failure'); END"); }
  finally { trigger.close(); }
  try {
    await waitFor('Switch is enabled for the in-transaction failure', () => evaluate(enabledButton(`${timer} .timer-start button`)));
    await evaluate(markStale);
    await evaluate(`document.querySelector(${JSON.stringify(`${timer} .timer-start button`)}).click()`);
    await waitFor('in-transaction Switch failure is reported', () => evaluate(failureShown));
    assert.equal(await evaluate(successShown('Przełączono zadanie.')), false);
    await waitFor('timer still running after in-transaction failure', () => evaluate(running));
    assert.deepEqual(await activeId(), started);
    assert.deepEqual(writeFailureState(), runningState, 'a failed insert left the previous entry closed (partial switch)');
    console.log('PASS: T20 Switch failing after the previous entry was closed rolled back completely');
  } finally {
    const cleanup = new DatabaseSync(testDb);
    try { cleanup.exec('DROP TRIGGER test_reject_switch'); } finally { cleanup.close(); }
  }

  // Retry once with writes possible again: one switch, then one stop.
  await waitFor('Switch enabled for retry', () => evaluate(enabledButton(`${timer} .timer-start button`)));
  const retryAt = Date.now();
  await evaluate(`document.querySelector(${JSON.stringify(`${timer} .timer-start button`)}).click()`);
  await waitFor('Switch retry succeeded', () => evaluate(successShown('Przełączono zadanie.')));
  const switched = await activeId();
  assert.ok(switched && switched.id !== started.id && switched.description === writeFailure.secondDescription);
  // Long enough that the later correction (end minus one second) stays after its start.
  await delay(3_000);
  await waitFor('Stop enabled for retry', () => evaluate(enabledButton(`${timer} .timer-stop button`)));
  await evaluate(`document.querySelector(${JSON.stringify(`${timer} .timer-stop button`)}).click()`);
  await waitFor('Stop retry succeeded', () => evaluate(successShown('Pomiar zatrzymany.')));
  await waitFor('timer stopped after retry', () => evaluate(idle));
  assert.equal(await activeId(), null);
  const after = writeFailureState();
  assert.equal(after.entries.length, before.entries.length + 2, 'retry created a duplicate or lost an entry');
  assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries, 'retry changed earlier entries');
  const [firstEntry, secondEntry] = after.entries.slice(before.entries.length);
  assert.equal(firstEntry.id, started.id);
  assert.equal(secondEntry.id, switched.id);
  assert.equal(after.entries.filter(entry => entry.description === writeFailure.firstDescription).length, 1);
  assert.equal(after.entries.filter(entry => entry.description === writeFailure.secondDescription).length, 1);
  assert.equal(firstEntry.started_at, runningState.entries.at(-1).started_at);
  assert.equal(firstEntry.project_id, first.id);
  assert.equal(secondEntry.project_id, second.id);
  // The switch boundary is shared, so time is neither lost nor counted twice.
  assert.equal(secondEntry.started_at, firstEntry.ended_at);
  for (const entry of [firstEntry, secondEntry]) {
    const wall = Math.floor((Date.parse(entry.ended_at) - Date.parse(entry.started_at)) / 1000);
    assert.ok(entry.ended_at && entry.manually_resolved === 0 && Math.abs(wall - entry.duration_seconds) <= 2, `entry #${entry.id} duration matches its interval`);
  }
  // The time spent on the failed attempts stays working time of the first entry (none is lost).
  const untilRetry = Math.floor((retryAt - Date.parse(firstEntry.started_at)) / 1000);
  assert.ok(untilRetry >= 10 && firstEntry.duration_seconds >= untilRetry - 2, `first entry kept the time of the failed attempts (${firstEntry.duration_seconds} s, ${untilRetry} s until retry)`);
  assert.equal(after.revisions, before.revisions);
  console.log(`PASS: T20 retry after restoring writes saved one switch and one stop (#${firstEntry.id} ${firstEntry.duration_seconds} s, #${secondEntry.id} ${secondEntry.duration_seconds} s) without duplicates`);

  // Entry correction while the database cannot be written; the app is then closed with the
  // edit unsaved, and the next phase restarts it (T26).
  await waitFor('entry editor opens for the write-failure correction', async () => {
    if (await evaluate(`Boolean(document.querySelector('#entry-draft-description'))`)) return true;
    await chooseFromEntryMenu(cdp, sessionId, evaluate, writeFailure.editEntryDescription, 'Popraw wpis:', 'mouse');
    return false;
  });
  const editId = after.entries.find(entry => entry.description === writeFailure.editEntryDescription)?.id;
  assert.ok(editId);
  const original = after.entries.find(entry => entry.id === editId);
  const targetEnd = await evaluate(`(() => {
    const field = document.querySelectorAll('[aria-label="Edycja wpisu"] input[type="datetime-local"]')[1];
    const date = new Date(field.value);
    date.setSeconds(date.getSeconds() - 1);
    const pad = value => String(value).padStart(2, '0');
    const value = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') + 'T' + [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const description = document.querySelector('#entry-draft-description');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(description, ${JSON.stringify(writeFailure.editDescription)});
    description.dispatchEvent(new Event('input', { bubbles: true }));
    return date.toISOString();
  })()`);
  const draftPath = join(process.env.APPDATA, 'pl.tracker.personal.testonly', 'entry-drafts', `entry-${editId}.json`);
  await waitFor('correction draft saved locally', async () => {
    try { return JSON.parse(await readFile(draftPath, 'utf8')).fields.description === writeFailure.editDescription; }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  });
  lock = holdWriteLock();
  try {
    await evaluate(markStale);
    await evaluate(`document.querySelector('[aria-label="Edycja wpisu"] button[type="submit"]').click()`);
    await waitFor('correction failure is reported in the editor', () => evaluate(`[...document.querySelectorAll('[role="alert"]')].some(node => !node.dataset.ptt36Stale && node.textContent.includes('Nie udało się zapisać lub odczytać danych lokalnych'))`));
    assert.equal(await evaluate(successShown('Zmiany wpisu zostały zapisane.')), false, 'correction reported success although nothing was saved');
    assert.equal(await evaluate(`document.querySelector('#entry-draft-description')?.value`), writeFailure.editDescription);
    assert.deepEqual(writeFailureState(), after, 'failed correction changed the database');
    assert.equal(JSON.parse(await readFile(draftPath, 'utf8')).fields.description, writeFailure.editDescription);
    console.log('PASS: T20 correction with an unwritable database reported the error, kept the editor and the local draft, and changed nothing');
  } finally { lock.release(); }
  return { editId, original, targetEnd, after };
}

async function verifyDraftAfterWriteFailure(cdp, sessionId, pending) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const profileDir = join(process.env.APPDATA, 'pl.tracker.personal.testonly');
  const draftPath = join(profileDir, 'entry-drafts', `entry-${pending.editId}.json`);
  // The original entry is unchanged after the failed write and the restart.
  assert.deepEqual(writeFailureState(), pending.after, 'restart after the failed correction changed the database');
  const button = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Przejdź do szkiców')`;
  await waitFor('draft reminder after restart following a failed write', () => evaluate(`Boolean(${button})`));
  await evaluate(`${button}.click()`);
  const drafts = '[aria-label="Szkice wpisów"]';
  await waitFor('draft list after restart', () => evaluate(`Boolean([...document.querySelectorAll(${JSON.stringify(`${drafts} button`)})].find(item => item.textContent.trim() === 'Przywróć szkic' && !item.disabled))`));
  // The sort preference saved earlier survived both the failure and the restart.
  assert.equal(await readFile(join(profileDir, 'draft-sort.txt'), 'utf8'), 'oldest');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${drafts} select`)}).value`), 'oldest');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${drafts} h3`)})?.textContent.trim()`), 'Szkice (1)');
  await evaluate(`[...document.querySelectorAll(${JSON.stringify(`${drafts} button`)})].find(item => item.textContent.trim() === 'Przywróć szkic').click()`);
  await waitFor('draft restored after restart', () => evaluate(`document.querySelector('#entry-draft-description')?.value === ${JSON.stringify(writeFailure.editDescription)}`));
  assert.equal(writeFailureState().entries.find(entry => entry.id === pending.editId).description, writeFailure.editEntryDescription, 'the draft silently overwrote the original');
  console.log('PASS: T26 the local draft survived the failed write and the restart, the original stayed unchanged, and the draft sort preference persisted');

  // Retry once with writes possible: exactly one correction is saved. The restored editor
  // renders before the restore operation finishes; Save is disabled until then, and a click
  // on a disabled button is ignored, so wait until Save can actually be pressed.
  const submit = `document.querySelector('[aria-label="Edycja wpisu"] button[type="submit"]')`;
  const editorState = `(() => ({
    editor: Boolean(document.querySelector('[aria-label="Edycja wpisu"]')),
    submitDisabled: ${submit}?.disabled ?? null,
    description: document.querySelector('#entry-draft-description')?.value ?? null,
    alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent.trim()),
    status: [...document.querySelectorAll('[role="status"]')].map(node => node.textContent.trim()),
    historyHasCorrection: [...document.querySelectorAll('section.history tbody tr')].some(row => row.textContent.includes(${JSON.stringify(writeFailure.editDescription)})),
  }))()`;
  const diagnose = async error => {
    const draft = await readFile(draftPath, 'utf8').then(() => 'present', problem => problem.code ?? problem.message);
    const state = writeFailureState();
    const edited = state.entries.find(item => item.id === pending.editId);
    throw new Error(`${error.message}; editor: ${JSON.stringify(await evaluate(editorState))}; draft file: ${draft}; entry: ${JSON.stringify(edited)}; revisions: ${state.revisions}/${state.descriptionRevisions}`);
  };
  await waitFor('restored correction can be saved', () => evaluate(`(el => Boolean(el && !el.disabled))(${submit})`)).catch(diagnose);
  await evaluate(`${submit}.click()`);
  await waitFor('correction retry saved', () => evaluate(`!document.querySelector('[aria-label="Edycja wpisu"]') && [...document.querySelectorAll('section.history tbody tr')].some(row => row.textContent.includes(${JSON.stringify(writeFailure.editDescription)}))`)).catch(diagnose);
  const saved = writeFailureState();
  const entry = saved.entries.find(item => item.id === pending.editId);
  assert.equal(saved.entries.length, pending.after.entries.length);
  assert.equal(entry.description, writeFailure.editDescription);
  assert.equal(Date.parse(entry.ended_at), Date.parse(pending.targetEnd));
  // The start was not edited: it keeps its exact stored instant, still shared with the
  // previous entry's end, so no time moved between the two entries.
  assert.equal(entry.started_at, pending.original.started_at);
  const previous = saved.entries.find(item => item.ended_at === pending.original.started_at);
  assert.ok(previous && previous.id !== entry.id, 'the corrected entry no longer shares its start with the previous entry');
  assert.deepEqual(previous, pending.after.entries.find(item => item.id === previous.id));
  assert.equal(entry.duration_seconds, Math.floor((Date.parse(entry.ended_at) - Date.parse(entry.started_at)) / 1000));
  assert.equal(saved.revisions, pending.after.revisions + 1, 'retry saved the time correction more than once');
  assert.equal(saved.descriptionRevisions, pending.after.descriptionRevisions + 1, 'retry saved the description more than once');
  await assert.rejects(stat(draftPath), { code: 'ENOENT' });
  console.log(`PASS: T26 retry saved exactly one correction of entry #${pending.editId} and removed its draft`);
}

// PTT-36 / T27: a full disk under the database, on the synthetic CI test profile only.
// A small fixed VHD is attached for this phase; the test profile directory becomes a
// junction to a folder on it (the app resolves its data directory through Windows, so it
// cannot be redirected by an environment variable). `pl.tracker.personal` is never used.
const testProfile = join(process.env.APPDATA, 'pl.tracker.personal.testonly');
const diskFull = {
  sizeMb: 32,
  firstDescription: 'PTT-36 T27 pomiar przy pełnym dysku',
  secondDescription: 'PTT-36 T27 przełączenie po zwolnieniu miejsca',
  editDescription: 'PTT-36 T27 korekta przy pełnym dysku',
};
let testDisk;

function diskpart(lines) {
  const script = join(temp, `diskpart-${Date.now()}.txt`);
  return writeFile(script, lines.join('\r\n') + '\r\n', 'ascii').then(() =>
    execFileSync('diskpart.exe', ['/s', script], { stdio: 'pipe', windowsHide: true }).toString());
}

async function mountTestDisk() {
  const letter = ['T', 'R', 'Q', 'P', 'O', 'N'].find(candidate => !existsSync(`${candidate}:\\`));
  assert.ok(letter, 'no free drive letter for the test disk');
  const file = join(process.env.RUNNER_TEMP, `trackermaster-disk-full-${Date.now()}.vhdx`);
  const disk = { file, letter, root: `${letter}:\\`, attached: false, profileMoved: false };
  try {
    await diskpart([
      `create vdisk file="${file}" maximum=${diskFull.sizeMb} type=fixed`,
      `select vdisk file="${file}"`, 'attach vdisk',
    ]);
    disk.attached = true;
    await diskpart([
      `select vdisk file="${file}"`, 'create partition primary',
      'format fs=ntfs quick label=TMFULL', `assign letter=${letter}`,
    ]);
    await waitFor('test disk is mounted', () => existsSync(disk.root));
  } catch (error) {
    await releaseTestDisk(disk).catch(cleanup => console.log(`T27 cleanup after mount failure: ${cleanup.message}`));
    throw new Error(`BLOCKED: could not attach a test VHD on this runner (${error.stderr?.toString() || error.stdout?.toString() || error.message})`);
  }
  console.log(`T27: attached a ${diskFull.sizeMb} MB test VHD as ${disk.root}`);
  return disk;
}

// Copy the test profile onto the disk (without old backups, which the app does not need
// to run) and replace the profile directory with a junction to it.
async function moveProfileToDisk(disk) {
  const target = join(disk.root, 'profile');
  await cp(testProfile, target, { recursive: true, filter: source => !source.startsWith(join(testProfile, 'backups')) });
  await rename(testProfile, `${testProfile}.before-disk-full`);
  disk.profileMoved = true;
  await symlink(target, testProfile, 'junction');
  assert.ok((await lstat(testProfile)).isSymbolicLink(), 'test profile is not a junction to the test disk');
  await access(testDb);
}

async function releaseTestDisk(disk) {
  if (!disk) return;
  if (disk.profileMoved) {
    const link = await lstat(testProfile).catch(() => null);
    if (link?.isSymbolicLink()) await rmdir(testProfile); // removes the junction only
    if (!existsSync(testProfile)) await rename(`${testProfile}.before-disk-full`, testProfile);
    disk.profileMoved = false;
  }
  await rm(join(disk.root, 'filler.bin'), { force: true }).catch(() => {});
  if (disk.attached) {
    await diskpart([`select vdisk file="${disk.file}"`, 'detach vdisk']);
    disk.attached = false;
  }
  await rm(disk.file, { force: true });
  assert.equal(existsSync(disk.file), false, 'test VHD file was not removed');
  console.log('T27: detached and removed the test VHD and restored the test profile directory');
}

async function freeBytes(disk) {
  const info = await statfs(disk.root);
  return Number(info.bavail) * Number(info.bsize);
}

// Fill the volume until even a 512-byte write fails with ENOSPC.
async function fillTestDisk(disk) {
  const handle = openSync(join(disk.root, 'filler.bin'), 'a');
  try {
    for (const size of [1024 * 1024, 64 * 1024, 4096, 512]) {
      const chunk = Buffer.alloc(size);
      for (;;) {
        try { writeSync(handle, chunk); }
        catch (error) { if (error.code === 'ENOSPC') break; throw error; }
      }
    }
  } finally { closeSync(handle); }
  const free = await freeBytes(disk);
  assert.ok(free < 4096, `test disk still has ${free} free bytes`);
  return free;
}

async function emptyTestDisk(disk) {
  await rm(join(disk.root, 'filler.bin'), { force: true });
  const free = await freeBytes(disk);
  assert.ok(free > 1024 * 1024, `test disk did not regain space (${free} bytes)`);
}

async function verifyDiskFull(cdp, sessionId, disk) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  assert.ok((await lstat(testProfile)).isSymbolicLink(), 'the app must run with its test profile on the test disk');
  const timer = '[aria-label="Pomiar czasu"]';
  const markStale = `document.querySelectorAll('[role="alert"]').forEach(node => { node.dataset.ptt36Stale = '1'; })`;
  const failureShown = `[...document.querySelectorAll('[role="alert"]')].some(node => !node.dataset.ptt36Stale && node.textContent.includes('Nie udało się potwierdzić operacji') && node.textContent.includes('Nie udało się zapisać lub odczytać danych lokalnych'))`;
  const successShown = message => `[...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes(${JSON.stringify(message)}))`;
  const activeId = () => evaluate(`window.__TAURI_INTERNALS__.invoke('get_snapshot').then(s => s.active ? { id: s.active.id, recovered: s.active.recovered, uncertain: s.active.uncertain, description: s.active.description } : null)`);
  const running = `Boolean(document.querySelector(${JSON.stringify(`${timer} .status.running`)}))`;
  const idle = `!document.querySelector(${JSON.stringify(`${timer} .timer-stop button`)}) && !document.querySelector(${JSON.stringify(`${timer} .status.running`)})`;
  const enabledButton = selector => `(el => Boolean(el && !el.disabled))(document.querySelector(${JSON.stringify(selector)}))`;
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const projects = (() => {
    const db = new DatabaseSync(testDb, { readOnly: true });
    try { return db.prepare(`SELECT p.id, p.client_id AS clientId, c.name AS client FROM projects p JOIN clients c ON c.id=p.client_id ORDER BY p.id`).all().map(row => ({ ...row })); }
    finally { db.close(); }
  })();
  const first = projects.find(item => item.client === primaryClient);
  const second = projects.find(item => item.client === secondClient);
  assert.ok(first && second && first.id !== second.id);

  const before = writeFailureState();
  assert.ok(before.entries.every(entry => entry.ended_at), 'no timer may run before T27');
  await evaluate(`window.__TAURI_INTERNALS__.invoke('start_project_timer', { projectId: ${first.id}, taskId: null, expectedActiveId: null, description: ${JSON.stringify(diskFull.firstDescription)} })`);
  await waitFor('T27 timer is running', () => evaluate(running));
  const started = await activeId();
  assert.ok(started && !started.recovered && !started.uncertain && started.description === diskFull.firstDescription);
  await delay(3_000);
  const runningState = writeFailureState();

  // Stop and Switch with no free space on the database volume.
  let free = await fillTestDisk(disk);
  try {
    console.log(`T27: database volume filled (${free} bytes free)`);
    await waitFor('Stop is enabled on a full disk', () => evaluate(enabledButton(`${timer} .timer-stop button`)));
    await evaluate(markStale);
    await click(`${timer} .timer-stop button`);
    await waitFor('Stop failure on a full disk is reported', () => evaluate(failureShown));
    assert.equal(await evaluate(successShown('Pomiar zatrzymany.')), false, 'Stop reported success on a full disk');
    await waitFor('timer still running after Stop on a full disk', () => evaluate(running));
    assert.deepEqual(await activeId(), started);
    assert.deepEqual(writeFailureState(), runningState, 'Stop on a full disk changed the database');
    console.log('PASS: T27 Stop on a full disk reported the error, kept the same timer and changed nothing');

    await evaluate(`(() => {
      document.querySelector(${JSON.stringify(`${timer} details.timer-lists`)}).open = true;
      const client = document.querySelectorAll(${JSON.stringify(`${timer} .timer-lists select`)})[0];
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(client, ${JSON.stringify(String(second.clientId))});
      client.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor('second client projects listed', () => evaluate(`[...document.querySelectorAll(${JSON.stringify(`${timer} .timer-lists select`)})[1].options].some(option => option.value === ${JSON.stringify(String(second.id))})`));
    await evaluate(`(() => {
      const project = document.querySelectorAll(${JSON.stringify(`${timer} .timer-lists select`)})[1];
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(project, ${JSON.stringify(String(second.id))});
      project.dispatchEvent(new Event('change', { bubbles: true }));
      const description = document.querySelector(${JSON.stringify(`${timer} .timer-description input`)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(description, ${JSON.stringify(diskFull.secondDescription)});
      description.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor('Switch is enabled on a full disk', () => evaluate(enabledButton(`${timer} .timer-start button`)));
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${timer} .timer-start button`)}).textContent.includes('Przełącz zadanie')`), true);
    await evaluate(markStale);
    await click(`${timer} .timer-start button`);
    await waitFor('Switch failure on a full disk is reported', () => evaluate(failureShown));
    assert.equal(await evaluate(successShown('Przełączono zadanie.')), false, 'Switch reported success on a full disk');
    await waitFor('timer still running after Switch on a full disk', () => evaluate(running));
    assert.deepEqual(await activeId(), started);
    assert.deepEqual(writeFailureState(), runningState, 'Switch on a full disk changed the database');
    console.log('PASS: T27 Switch on a full disk reported the error, kept the same timer and changed nothing');
  } finally { await emptyTestDisk(disk); }

  // One retry of each with space available again.
  await waitFor('Switch enabled for retry after freeing space', () => evaluate(enabledButton(`${timer} .timer-start button`)));
  await click(`${timer} .timer-start button`);
  await waitFor('Switch retry succeeded', () => evaluate(successShown('Przełączono zadanie.')));
  const switched = await activeId();
  assert.ok(switched && switched.id !== started.id && switched.description === diskFull.secondDescription);
  await delay(2_000);
  await waitFor('Stop enabled for retry after freeing space', () => evaluate(enabledButton(`${timer} .timer-stop button`)));
  await click(`${timer} .timer-stop button`);
  await waitFor('Stop retry succeeded', () => evaluate(successShown('Pomiar zatrzymany.')));
  await waitFor('timer stopped after retry', () => evaluate(idle));
  assert.equal(await activeId(), null);
  const after = writeFailureState();
  assert.equal(after.entries.length, before.entries.length + 2, 'retry created a duplicate or lost an entry');
  assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries, 'retry changed earlier entries');
  const [firstEntry, secondEntry] = after.entries.slice(before.entries.length);
  assert.equal(firstEntry.id, started.id);
  assert.equal(secondEntry.id, switched.id);
  assert.equal(after.entries.filter(entry => entry.description === diskFull.firstDescription).length, 1);
  assert.equal(after.entries.filter(entry => entry.description === diskFull.secondDescription).length, 1);
  // Exact to the millisecond: the start is unchanged and the switch boundary is shared.
  assert.equal(firstEntry.started_at, runningState.entries.at(-1).started_at);
  assert.equal(secondEntry.started_at, firstEntry.ended_at);
  assert.equal(firstEntry.project_id, first.id);
  assert.equal(secondEntry.project_id, second.id);
  for (const entry of [firstEntry, secondEntry]) {
    assert.equal(entry.duration_seconds, Math.floor((Date.parse(entry.ended_at) - Date.parse(entry.started_at)) / 1000), `entry #${entry.id} duration matches its interval`);
    assert.equal(entry.manually_resolved, 0);
  }
  assert.equal(after.revisions, before.revisions);
  console.log(`PASS: T27 one retry after freeing space saved one switch and one stop (#${firstEntry.id} ${firstEntry.duration_seconds} s, #${secondEntry.id} ${secondEntry.duration_seconds} s) without duplicates`);

  // Correction of an entry's end. The local draft is written before the disk is filled,
  // so the failure is the database write, not the draft file.
  const target = after.entries[0];
  await waitFor('entry editor opens for the T27 correction', async () => {
    if (await evaluate(`Boolean(document.querySelector('#entry-draft-description'))`)) return true;
    await chooseFromEntryMenu(cdp, sessionId, evaluate, target.description, 'Popraw wpis:', 'mouse');
    return false;
  });
  assert.equal(await evaluate(`document.querySelector('#entry-draft-description')?.value`), target.description, 'the editor opened a different entry');
  const targetEnd = await evaluate(`(() => {
    const field = document.querySelectorAll('[aria-label="Edycja wpisu"] input[type="datetime-local"]')[1];
    const date = new Date(field.value);
    date.setSeconds(date.getSeconds() - 1);
    const pad = value => String(value).padStart(2, '0');
    const value = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') + 'T' + [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const description = document.querySelector('#entry-draft-description');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(description, ${JSON.stringify(diskFull.editDescription)});
    description.dispatchEvent(new Event('input', { bubbles: true }));
    return date.toISOString();
  })()`);
  assert.ok(Date.parse(targetEnd) > Date.parse(target.started_at), 'the corrected end must stay after the start');
  const draftPath = join(testProfile, 'entry-drafts', `entry-${target.id}.json`);
  await waitFor('T27 correction draft saved locally', async () => {
    try { return JSON.parse(await readFile(draftPath, 'utf8')).fields.description === diskFull.editDescription; }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  });
  const submit = `document.querySelector('[aria-label="Edycja wpisu"] button[type="submit"]')`;
  await waitFor('correction can be saved', () => evaluate(`(el => Boolean(el && !el.disabled))(${submit})`));
  free = await fillTestDisk(disk);
  try {
    console.log(`T27: database volume filled again (${free} bytes free)`);
    await evaluate(markStale);
    await evaluate(`${submit}.click()`);
    await waitFor('correction failure on a full disk is reported', () => evaluate(`[...document.querySelectorAll('[role="alert"]')].some(node => !node.dataset.ptt36Stale && node.textContent.includes('Nie udało się zapisać lub odczytać danych lokalnych'))`));
    assert.equal(await evaluate(successShown('Zmiany wpisu zostały zapisane.')), false, 'correction reported success on a full disk');
    assert.equal(await evaluate(`document.querySelector('#entry-draft-description')?.value`), diskFull.editDescription);
    assert.deepEqual(writeFailureState(), after, 'correction on a full disk changed the database');
    assert.equal(JSON.parse(await readFile(draftPath, 'utf8')).fields.description, diskFull.editDescription);
    console.log('PASS: T27 correction on a full disk reported the error, kept the editor and its draft, and changed nothing');
  } finally { await emptyTestDisk(disk); }

  await waitFor('correction can be saved after freeing space', () => evaluate(`(el => Boolean(el && !el.disabled))(${submit})`));
  await evaluate(`${submit}.click()`);
  await waitFor('correction retry saved', () => evaluate(`!document.querySelector('[aria-label="Edycja wpisu"]') && [...document.querySelectorAll('section.history tbody tr')].some(row => row.textContent.includes(${JSON.stringify(diskFull.editDescription)}))`))
    .catch(async error => {
      const alerts = await evaluate(`[...document.querySelectorAll('[role="alert"]')].map(node => node.textContent.trim())`);
      throw new Error(`${error.message}; alerts: ${JSON.stringify(alerts)}`);
    });
  const saved = writeFailureState();
  const entry = saved.entries.find(item => item.id === target.id);
  assert.equal(saved.entries.length, after.entries.length, 'the correction retry created or lost an entry');
  assert.deepEqual(saved.entries.filter(item => item.id !== target.id), after.entries.filter(item => item.id !== target.id), 'the correction changed another entry');
  assert.equal(entry.description, diskFull.editDescription);
  assert.equal(entry.started_at, target.started_at, 'the unchanged start moved (it keeps its exact milliseconds)');
  assert.equal(Date.parse(entry.ended_at), Date.parse(targetEnd));
  assert.equal(entry.duration_seconds, Math.floor((Date.parse(entry.ended_at) - Date.parse(entry.started_at)) / 1000));
  assert.equal(saved.revisions, after.revisions + 1, 'retry saved the time correction more than once');
  assert.equal(saved.descriptionRevisions, after.descriptionRevisions + 1, 'retry saved the description more than once');
  await assert.rejects(stat(draftPath), { code: 'ENOENT' });
  console.log(`PASS: T27 one retry after freeing space saved exactly one correction of entry #${target.id}`);
}

async function verifyDuplicateClientChoices(cdp, sessionId) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const db = new DatabaseSync(testDb, { readOnly: true });
  let primaryId, secondId, primaryMarker, secondMarker;
  try {
    primaryId = db.prepare('SELECT id FROM clients WHERE name=?').get(primaryClient).id;
    secondId = db.prepare('SELECT id FROM clients WHERE name=?').get(secondClient).id;
    primaryMarker = db.prepare('SELECT description FROM entry_descriptions WHERE entry_id=1').get().description;
    secondMarker = db.prepare('SELECT description FROM entry_descriptions WHERE entry_id=2').get().description;
    assert.notEqual(primaryMarker, secondMarker);
  } finally { db.close(); }
  const rename = (expected, name) => evaluate(`window.__TAURI_INTERNALS__.invoke('rename_item', ${JSON.stringify({ kind: 'client', id: primaryId, expectedName: expected, name })})`);
  await rename(primaryClient, secondClient);
  try {
    await waitFor('duplicate names are distinct in the timer selector', () => evaluate(`(() => {
      const options = [...document.querySelectorAll('[aria-label="Pomiar czasu"] select')[0].options];
      return [${primaryId}, ${secondId}].every(id => options.some(option => option.value === String(id) && option.textContent.startsWith('ID ' + id + ' · ')));
    })()`));
    await evaluate(`(() => {
      const section = document.querySelector('[aria-label="Raport czasu"]');
      const button = [...section.querySelectorAll('button')].find(item => item.textContent.trim() === 'Otwórz raport');
      button?.click();
    })()`);
    await waitFor('duplicate client report selector', () => evaluate(`(() => {
      const select = document.querySelector('#report-client');
      return select && [${primaryId}, ${secondId}].every(id => [...select.options].some(option => option.value === String(id) && option.textContent.startsWith('ID ' + id + ' · ')));
    })()`));
    for (const [id, included, excluded] of [[primaryId, primaryMarker, secondMarker], [secondId, secondMarker, primaryMarker]]) {
      await evaluate(`(() => {
        const select = document.querySelector('#report-client');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(String(id))});
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(`selected duplicate client ${id} in report`, () => evaluate(`document.querySelector('.report-scope-summary')?.textContent.includes(${JSON.stringify(`ID ${id} · `)})`));
      await waitFor(`CSV preview button for client ${id}`, () => evaluate(`(() => {
        const button = [...document.querySelectorAll('[aria-label="Raport czasu"] button')].find(item => item.textContent.trim() === 'Przygotuj podgląd CSV');
        return button && !button.disabled;
      })()`));
      await evaluate(`[...document.querySelectorAll('[aria-label="Raport czasu"] button')].find(item => item.textContent.trim() === 'Przygotuj podgląd CSV').click()`);
      await waitFor(`CSV preview isolates client ${id}`, () => evaluate(`(() => {
        const preview = document.querySelector('.export-preview');
        return preview?.textContent.includes(${JSON.stringify(`ID ${id} · `)}) && preview.textContent.includes(${JSON.stringify(included)}) && !preview.textContent.includes(${JSON.stringify(excluded)});
      })()`));
    }
    console.log('PASS: identical client names are distinguishable and each CSV preview contains only its own entries');
  } finally {
    await rename(secondClient, primaryClient);
  }
}

// D4 short sleep (schema v14, owner decision 23.11.2026, as in Toggl): a sleep shorter than 5 minutes is
// work without a question; 5 minutes or more still asks. A real suspend cannot run on the CI runner, and a
// sleep recorded on a running timer would disagree with the power counters, so the periods are recorded on
// a completed entry on a fixed past day with the app's own resume statement and threshold (sleep_periods.rs).
async function verifyShortSleep(cdp, sessionId) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const invoke = (command, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  const main = await readFile(join('src-tauri', 'src', 'main.rs'), 'utf8');
  const rust = await readFile(join('src-tauri', 'src', 'sleep_periods.rs'), 'utf8');
  const latest = Number(main.match(/const LATEST_SCHEMA_VERSION: i64 = (\d+);/)[1]);
  const threshold = rust.match(/pub const SHORT_SLEEP_AUTO_INCLUDE_MS: i64 = ([\d_ *]+);/)[1].replace(/_/g, '').split('*').reduce((product, factor) => product * Number(factor), 1);
  const resumeSql = rust.match(/"(UPDATE sleep_periods SET ended_ms=\?1, decision=CASE[^"]+)"/)[1];
  assert.equal(threshold, 300_000);
  const description = 'D4 krótkie uśpienie';
  const start = Date.parse('2026-01-05T08:00:00.000Z');
  const minute = 60_000;
  let db = new DatabaseSync(testDb, { readOnly: true });
  let project;
  try {
    // The packaged app migrated the test database to the current schema with 'auto_included'.
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, latest);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='sleep_periods'").get().sql, /'auto_included'/);
    project = db.prepare(`SELECT p.id AS projectId, p.client_id AS clientId FROM projects p WHERE p.archived=0
      AND NOT EXISTS (SELECT 1 FROM client_archives a WHERE a.client_id=p.client_id) ORDER BY p.id LIMIT 1`).get();
    assert.ok(project, 'an active project for the short-sleep entry');
  } finally { db.close(); }
  await invoke('create_project_manual_entry', { projectId: project.projectId, taskId: null, startedAt: new Date(start).toISOString(), endedAt: new Date(start + 60 * minute).toISOString(), description });
  db = new DatabaseSync(testDb);
  let entryId, ids;
  try {
    entryId = db.prepare('SELECT e.id FROM time_entries e JOIN entry_descriptions d ON d.entry_id=e.id WHERE d.description=?').get(description).id;
    const record = (offset, length) => {
      const id = Number(db.prepare('INSERT INTO sleep_periods(entry_id,started_ms) VALUES(?,?)').run(entryId, start + offset).lastInsertRowid);
      assert.equal(db.prepare(resumeSql).run(start + offset + length, id, entryId, threshold).changes, 1);
      return id;
    };
    // 2 min, exactly 5 min, 10 min: only the first is counted without a question.
    ids = { short: record(10 * minute, 2 * minute), boundary: record(20 * minute, threshold), long: record(30 * minute, 10 * minute) };
    const rows = db.prepare('SELECT id, decision, decided_ms, ended_ms FROM sleep_periods WHERE entry_id=? ORDER BY started_ms').all(entryId).map(row => ({ ...row }));
    assert.deepEqual(rows.map(row => row.decision), ['auto_included', 'pending', 'pending']);
    assert.equal(rows[0].decided_ms, rows[0].ended_ms, 'the automatic decision is recorded at the observed resume');
    assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='auto_included', decided_ms=ended_ms WHERE id=?").run(ids.boundary), /CHECK/);
    assert.throws(() => db.prepare("UPDATE sleep_periods SET decision='excluded', decided_ms=1 WHERE id=?").run(ids.short), /immutable/);
  } finally { db.close(); }

  // One note above the timer for the two questions; the short sleep is not among them.
  const note = () => evaluate(`document.querySelector('.sleep-note')?.textContent ?? ''`);
  await waitFor('sleep note lists only the 5 and 10 minute periods', async () => (await note()).includes('2 okresy · 00:15:00'));
  const pending = await invoke('get_pending_sleep');
  assert.deepEqual(pending.filter(item => item.entryId === entryId).map(item => item.id), [ids.boundary, ids.long]);
  // History, report and CSV count the same seconds: 60 min minus the 15 undecided minutes, the 2 min are work.
  const counted = async () => {
    const snapshot = await invoke('get_snapshot');
    const report = await invoke('get_report_data', { scope: { clientId: null, projectId: null, taskId: null } });
    const csv = await invoke('get_client_export_data', { scope: { clientId: project.clientId, projectId: null, taskId: null } });
    const seconds = list => list.find(item => item.id === entryId)?.duration_seconds;
    return [seconds(snapshot.entries), seconds(report.entries), seconds(csv.entries)];
  };
  assert.deepEqual(await counted(), [2700, 2700, 2700]);
  // The 5-minute sleep is included and the 10-minute one rejected through the list, as before.
  await evaluate(`document.querySelector('.sleep-note button').click()`);
  const list = '#pending-sleep-list';
  // Rows are told apart by entry and duration (the dates follow the app's locale and time zone).
  const row = duration => `[...document.querySelectorAll(${JSON.stringify(`${list} tbody tr`)})].find(row => row.textContent.includes(${JSON.stringify(`#${entryId}`)}) && row.cells[2]?.textContent.startsWith(${JSON.stringify(duration)}))`;
  const button = (duration, label) => `[...(${row(duration)}?.querySelectorAll('button') ?? [])].find(item => item.textContent.trim() === ${JSON.stringify(label)})`;
  await waitFor('pending list shows both questions', () => evaluate(`Boolean(${row('00:05:00')}) && Boolean(${row('00:10:00')})`));
  assert.equal(await evaluate(`Boolean(${row('00:02:00')})`), false, 'the short sleep is not offered for a decision');
  await evaluate(`${button('00:05:00', 'Dolicz')}.click()`);
  await waitFor('5-minute sleep included', async () => (await invoke('get_pending_sleep')).filter(item => item.entryId === entryId).length === 1);
  await waitFor('10-minute sleep button ready', () => evaluate(`(button => Boolean(button && !button.disabled))(${button('00:10:00', 'Odrzuć')})`));
  await evaluate(`${button('00:10:00', 'Odrzuć')}.click()`);
  await waitFor('no question left for the entry', async () => (await invoke('get_pending_sleep')).every(item => item.entryId !== entryId));
  await waitFor('sleep note gone', async () => !(await note()));
  assert.deepEqual(await counted(), [3000, 3000, 3000]);
  console.log(`PASS: D4 short sleep — under ${threshold} ms counted as work without a question; ${threshold} ms and longer asked as before; History, report and CSV agree (2700 s, then 3000 s)`);
}

async function runWindow(port, phase, recovery) {
  const env = {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: await mkdtemp(join(temp, 'profile-')),
  };
  const child = spawn(exe, [], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  let cdp;
  try {
    await once(child, 'spawn');
    cdp = await connect(port, child);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: cdp.pageId, flatten: true });
    await waitFor(`${phase}: rendered and ready`, async () => {
      const ready = await cdp.send('Runtime.evaluate', {
        expression: `document.readyState === 'complete'
          && !!document.querySelector('[role="note"]')?.textContent.includes('Wersja testowa.')
          && document.querySelector('#new-client')?.disabled === false`,
        returnByValue: true,
      }, sessionId).catch(error => {
        if (!/Execution context was destroyed|Cannot find context/i.test(error.message)) throw error;
        return null;
      });
      return ready?.result.value === true;
    });
    console.log(`${phase}: connected to the test app`);
    if (phase === 'initial') {
      const evalIn = async (id, expression) => {
        const value = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, id);
        if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
        return value.result.value;
      };
      await evalIn(sessionId, 'document.querySelector(".widget-open").click()');
      const target = await waitFor('empty mini timer window', async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos.find(item => item.type === 'page' && item.targetId !== cdp.pageId && /^https?:\/\/tauri\.localhost(?::\d+)?\//.test(item.url));
      });
      const { sessionId: emptyWidget } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await waitFor('empty mini timer is ready', () => evalIn(emptyWidget,
        `document.querySelector('.qp-mini')?.dataset.mode === 'idle' && document.querySelector('.qp-toggle')?.getAttribute('aria-disabled') === 'false'`).catch(() => false));
      await evalIn(emptyWidget, `document.querySelector('.qp-toggle').click()`);
      await waitFor('start without project opens the picker', () => evalIn(emptyWidget,
        `Boolean(document.querySelector('.qp-panel')) && document.activeElement === document.querySelector('[role="combobox"]')`));
      assert.equal(await evalIn(emptyWidget, `document.querySelector('.qp-mini').dataset.mode`), 'idle');
      await evalIn(emptyWidget, `document.querySelector('[aria-label="Zamknij mini timer"]').click()`);
      await waitFor('empty mini timer closes', async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return !targetInfos.some(item => item.targetId === target.targetId);
      });
      console.log('PASS: Start without a project opens the picker and leaves the timer stopped');
    }
    if (phase === 'initial') await captureMainLayout(cdp, sessionId, 'empty');
    if (phase === 'recover') await captureMainLayout(cdp, sessionId, 'recovered', { requireTimerAction: false, requireTimerCard: true });
    if (phase === 'initial') await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: csvDirectory, eventsEnabled: true });
    const input = { primaryClient, secondClient, project, task, primaryDescription, secondDescription, interruptedDescription, recovery };
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(${exercisePage.toString()})(${JSON.stringify(input)}, ${JSON.stringify(phase)})`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    const seconds = result.result.value;
    if (phase === 'initial' || phase === 'interrupt') {
      assert.ok(Number.isSafeInteger(seconds) && seconds >= 5);
      console.log(`${phase}: report matched the selected client (${seconds} s)`);
      await captureReportDetail(cdp, sessionId, phase === 'initial' ? 'selected-client' : 'restored-scope');
      if (phase === 'initial') await verifyReportSummary(cdp, sessionId, seconds);
    } else {
      assert.equal(seconds, null);
      if (!['hotkey-restart', 'write-failure', 'write-failure-reopen', 'disk-full', 'short-sleep'].includes(phase)) console.log(`${phase}: history showed the manually recovered entry`);
    }
    await access(testDb);
    if (phase === 'initial') {
      const download = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const button = [...document.querySelectorAll('.export-preview button')].find(item => item.textContent === 'Potwierdź i pobierz CSV');
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })()`,
        userGesture: true,
        returnByValue: true,
      }, sessionId).catch(error => {
        // A download can dispose of the page context. Check the file, without clicking again.
        if (!/Execution context was destroyed/i.test(error.message)) throw error;
        return null;
      });
      if (download) assert.equal(download.result.value, true, 'CSV confirmation disappeared before download');
      const file = await waitFor('completed CSV file', async () => (await readdir(csvDirectory)).find(name => name.endsWith('.csv')));
      const bytes = await readFile(join(csvDirectory, file));
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const rows = bytes.toString('utf8').trimEnd().split('\r\n');
      assert.equal(rows.length, 2);
      assert.ok(rows[1].includes(primaryClient) && rows[1].includes(primaryDescription));
      assert.ok(!rows[1].includes(secondClient) && !rows[1].includes(secondDescription));
      assert.equal(Number(rows[1].split(';')[10].replaceAll('"', '')), seconds);
      console.log('First window: downloaded CSV matched Report Details');
      await captureMainLayout(cdp, sessionId, 'idle-with-history');
      console.log(`CSV_DIAGNOSTIC phase=after-read protocol=${JSON.stringify(cdp.downloadEvents)} directory=${JSON.stringify(await csvSnapshot())}`);
    } else {
      const files = await readdir(csvDirectory);
      if (files.filter(name => name.endsWith('.csv')).length !== 1) {
        console.log(`CSV_DIAGNOSTIC phase=${phase}-unexpected directory=${JSON.stringify(files)} changes=${JSON.stringify(csvEvents)}`);
      }
      assert.equal(files.filter(name => name.endsWith('.csv')).length, 1);
    }
    if (phase === 'interrupt') {
      await verifyOccupiedShortcut(cdp, sessionId);
      await verifySecondLaunch(child, env);
    }
    if (phase === 'verify-recovery') {
      // History by day and the closed-report card fed by the shared all-clients read (package 2).
      await captureSection(cdp, sessionId, 'section.history', historyByDayReady, 'history-by-day');
      await captureSection(cdp, sessionId, '[aria-label="Raport czasu"]', reportCardReady, 'report-card');
      await verifyEntryMenu(cdp, sessionId);
    }
    if (phase === 'verify-recovery' || phase === 'draft-reopen') await verifyDraft(cdp, sessionId, phase, child);
    if (phase === 'draft-reopen') await verifyRestoreRetry(cdp, sessionId);
    if (phase === 'hotkey-restart') {
      await verifyShortcutAfterRestart(cdp, sessionId);
      await verifyDuplicateClientChoices(cdp, sessionId);
    }
    if (phase === 'write-failure') pendingWriteFailure = await verifyWriteFailure(cdp, sessionId);
    if (phase === 'write-failure-reopen') await verifyDraftAfterWriteFailure(cdp, sessionId, pendingWriteFailure);
    if (phase === 'disk-full') await verifyDiskFull(cdp, sessionId, testDisk);
    if (phase === 'short-sleep') await verifyShortSleep(cdp, sessionId);
    return seconds;
  } finally {
    if (phase === 'initial') {
      console.log(`CSV_DIAGNOSTIC phase=before-exit protocol=${JSON.stringify(cdp?.downloadEvents ?? [])} directory=${JSON.stringify(await csvSnapshot())}`);
    }
    cdp?.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    }
    if (phase === 'initial') {
      console.log(`CSV_DIAGNOSTIC phase=after-exit directory=${JSON.stringify(await csvSnapshot())} changes=${JSON.stringify(csvEvents)}`);
    }
    await assert.rejects(stat(normalDb), { code: 'ENOENT' });
  }
}

async function waitForWindowClosed(port) {
  await waitFor('previous WebView2 instance stopped', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
      const pages = await response.json();
      return Array.isArray(pages) && pages.every(page => page.type !== 'page');
    } catch (error) {
      return error.cause?.code === 'ECONNREFUSED';
    }
  });
}

function readInterruptedTimer() {
  const db = new DatabaseSync(testDb, { readOnly: true });
  try {
    const active = db.prepare(`SELECT e.id, e.started_at, e.duration_seconds, e.manually_resolved, d.description
      FROM time_entries e JOIN entry_descriptions d ON d.entry_id=e.id WHERE e.ended_at IS NULL`).all();
    assert.equal(active.length, 1);
    assert.equal(active[0].description, interruptedDescription);
    assert.equal(active[0].duration_seconds, null);
    assert.equal(active[0].manually_resolved, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM time_entries').get().count, 3);
    return active[0];
  } finally {
    db.close();
  }
}

function registry(action, extra = []) {
  const key = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
  return execFileSync('reg.exe', [action, key, '/v', 'tracker-master.exe', ...extra], { stdio: 'pipe', windowsHide: true });
}

let existingPolicy = false;
try {
  registry('query');
  existingPolicy = true;
} catch (error) {
  if (error.status !== 1) throw error;
}
assert.equal(existingPolicy, false, 'Expected a fresh runner without a TrackerMaster WebView2 policy');
const port = await availablePort();
// Elevated WebView2 hosts ignore the environment variable for additional browser arguments.
registry('add', ['/t', 'REG_SZ', '/d', `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`, '/f']);
let seconds, interrupted, recovery, pendingWriteFailure;
// The history built by the phases above, checked before PTT-36 adds its own synthetic entries.
function assertBaselineHistory() {
  const db = new DatabaseSync(testDb, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT c.name AS client, p.name AS project, e.duration_seconds AS duration,
      t.name AS task, e.id, e.started_at, e.ended_at, e.manually_resolved FROM time_entries e JOIN projects p ON p.id=e.project_id
      JOIN clients c ON c.id=p.client_id LEFT JOIN tasks t ON t.id=e.task_id ORDER BY e.id`).all();
    assert.deepEqual(rows.map(row => row.client), [primaryClient, secondClient, secondClient, secondClient, primaryClient]);
    assert.deepEqual(rows.map(row => row.task), [task, null, null, null, null]);
    assert.ok(rows.every(row => row.project === project));
    assert.ok(rows.slice(0, 2).every(row => row.duration >= 5 && row.manually_resolved === 0));
    assert.equal(rows[0].duration, seconds);
    assert.equal(rows[2].id, interrupted.id);
    assert.equal(rows[2].started_at, interrupted.started_at);
    assert.equal(rows[2].ended_at, recovery.end);
    assert.equal(rows[2].duration, recovery.duration);
    assert.equal(rows[2].manually_resolved, 1);
    assert.ok(rows[3].ended_at && rows[3].duration >= 5 && rows[3].manually_resolved === 0);
    assert.ok(rows[4].ended_at && rows[4].duration >= 5 && rows[4].manually_resolved === 0);
  } finally {
    db.close();
  }
  console.log('PASS: two clients, project timers, History, isolated report and CSV, and explicit recovery of the original entry after a forced exit');
}
try {
  seconds = await runWindow(port, 'initial');
  await waitForWindowClosed(port);
  assert.equal(await runWindow(port, 'interrupt'), seconds);
  interrupted = readInterruptedTimer();
  const start = Date.parse(interrupted.started_at);
  const end = Math.floor(start / 1000) * 1000 + 3_000;
  const duration = Math.floor((end - start) / 1000);
  recovery = {
    invalidEnd: new Date(end - 60_000).toISOString(),
    end: new Date(end).toISOString(),
    duration,
    displayDuration: `00:00:${String(duration).padStart(2, '0')}`,
  };
  console.log(`interrupt: retained open entry #${interrupted.id} without assigning a duration`);
  await waitForWindowClosed(port);
  await runWindow(port, 'recover', recovery);
  await waitForWindowClosed(port);
  await runWindow(port, 'verify-recovery', recovery);
  await waitForWindowClosed(port);
  await runWindow(port, 'draft-reopen', recovery);
  await waitForWindowClosed(port);
  await runWindow(port, 'hotkey-restart', recovery);
  assertBaselineHistory();
  // PTT-36: T20 (Stop, Switch, correction with an unwritable database, then one retry) and
  // T26 (the unsaved correction survives a restart and is saved exactly once).
  await waitForWindowClosed(port);
  await runWindow(port, 'write-failure', recovery);
  await waitForWindowClosed(port);
  await runWindow(port, 'write-failure-reopen', recovery);
  // PTT-36 / T27: Stop, Switch and correction with the database volume full, then one retry.
  await waitForWindowClosed(port);
  testDisk = await mountTestDisk();
  try {
    await moveProfileToDisk(testDisk);
    await runWindow(port, 'disk-full', recovery);
  } finally {
    // runWindow has already ended the app process; the disk is released even after a failure.
    await waitForWindowClosed(port).catch(error => console.log(`T27 cleanup: ${error.message}`));
    await releaseTestDisk(testDisk);
  }
  // D4 short sleep (schema v14): last, after T27 restored the profile, so the entry counts asserted above are unaffected.
  await waitForWindowClosed(port);
  await runWindow(port, 'short-sleep', recovery);
} finally {
  csvWatcher.close();
  registry('delete', ['/f']);
}
console.log('PASS: PTT-36 write failures in the running app kept the timer and data intact, and one retry saved each change once');
