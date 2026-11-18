import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
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
const primaryClient = 'Klient Żuraw QA';
const secondClient = 'Klient Beta QA';
const project = 'Projekt kontrolny';
const task = 'Zadanie QA';
const primaryDescription = 'Pomiar klienta Żuraw';
const secondDescription = 'Pomiar wyłącznie klienta Beta';

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
  let lastId = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
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

async function exercisePage(data, restarted) {
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
  const testProfileVisible = () => document.querySelector('[role="note"]')?.textContent.includes('Wersja testowa.');
  await until('test build and current data', () => testProfileVisible() && !pick(`${timer} select`)?.disabled && pick('#new-client'));

  if (!restarted) {
    async function create(kind, name, selectedIndex) {
      const input = `#new-${kind}`;
      await setValue(input, name, 'input');
      await click(`create ${kind}`, () => pick(input)?.form?.querySelector('button'));
      await until(`selected ${kind} ${name}`, () => selected(document.querySelectorAll(`${timer} select`)[selectedIndex]) === name);
    }
    async function measure(client, description, taskName) {
      await create('client', client, 0);
      await create('project', data.project, 1);
      if (taskName) await create('task', taskName, 2);
      await setValue(`${timer} .timer-description input`, description, 'input');
      await click('start timer', () => pick(`${timer} .timer-start button`));
      await until('running timer', () => pick(`${timer} .status.running`));
      await until('at least five measured seconds', () => {
        const digits = pick(`${timer} .clock`).textContent.split(':').map(Number);
        return digits.length === 3 && digits.reduce((seconds, field) => seconds * 60 + field, 0) >= 5;
      });
      await click('stop timer', () => pick(`${timer} .timer-stop button`));
      await until('completed entry in History', () => [...document.querySelectorAll('section.history tbody tr')].some(row => row.textContent.includes(description)));
    }
    await measure(data.primaryClient, data.primaryDescription, data.task);
    await measure(data.secondClient, data.secondDescription);
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
  if (!restarted) {
    await click('prepare CSV', () => textButton(report, 'Przygotuj podgląd CSV'));
    await until('client CSV preview', () => pick('.export-preview tbody')?.textContent.includes(data.primaryDescription));
    if (pick('.export-preview tbody').rows.length !== 1) fail('CSV preview returned a foreign entry');
    await click('confirm CSV download', () => textButton(report, 'Potwierdź i pobierz CSV'));
  }
  return contribution.split(':').reduce((seconds, field) => seconds * 60 + Number(field), 0);
}

async function runWindow(port, restarted) {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: await mkdtemp(join(temp, 'profile-')),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  let cdp;
  try {
    await once(child, 'spawn');
    cdp = await connect(port, child);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: cdp.pageId, flatten: true });
    if (!restarted) await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: csvDirectory });
    const input = { primaryClient, secondClient, project, task, primaryDescription, secondDescription };
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(${exercisePage.toString()})(${JSON.stringify(input)}, ${restarted})`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    const seconds = result.result.value;
    assert.ok(Number.isSafeInteger(seconds) && seconds >= 5);
    await access(testDb);
    if (!restarted) {
      const file = await waitFor('completed CSV file', async () => (await readdir(csvDirectory)).find(name => name.endsWith('.csv')));
      const bytes = await readFile(join(csvDirectory, file));
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const rows = bytes.toString('utf8').trimEnd().split('\r\n');
      assert.equal(rows.length, 2);
      assert.ok(rows[1].includes(primaryClient) && rows[1].includes(primaryDescription));
      assert.ok(!rows[1].includes(secondClient) && !rows[1].includes(secondDescription));
      assert.equal(Number(rows[1].split(';')[10].replaceAll('"', '')), seconds);
    } else {
      assert.equal((await readdir(csvDirectory)).filter(name => name.endsWith('.csv')).length, 1);
    }
    return seconds;
  } finally {
    cdp?.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    }
    await assert.rejects(stat(normalDb), { code: 'ENOENT' });
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
let seconds;
try {
  seconds = await runWindow(port, false);
  assert.equal(await runWindow(port, true), seconds);
} finally {
  registry('delete', ['/f']);
}
const db = new DatabaseSync(testDb, { readOnly: true });
try {
  const rows = db.prepare(`SELECT c.name AS client, p.name AS project, e.duration_seconds AS duration,
    t.name AS task FROM time_entries e JOIN projects p ON p.id=e.project_id
    JOIN clients c ON c.id=p.client_id LEFT JOIN tasks t ON t.id=e.task_id ORDER BY e.id`).all();
  assert.deepEqual(rows.map(row => row.client), [primaryClient, secondClient]);
  assert.deepEqual(rows.map(row => row.task), [task, null]);
  assert.ok(rows.every(row => row.project === project && row.duration >= 5));
  assert.equal(rows[0].duration, seconds);
} finally {
  db.close();
}
console.log('PASS: two clients, project timers, History, isolated report and CSV, restart and SQLite verification');
