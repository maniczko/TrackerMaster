import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
  await until('test build and current data', () => testProfileVisible() && !pick(`${timer} select`)?.disabled && pick('#new-client'));

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
    async function measure(client, description, taskName) {
      await create('client', client, 0);
      await create('project', data.project, 1);
      if (taskName) await create('task', taskName, 2);
      await setValue(`${timer} .timer-description input`, description, 'input');
      await click('start timer', () => pick(`${timer} .timer-start button`));
      await waitForMeasurement();
      await click('stop timer', () => pick(`${timer} .timer-stop button`));
      await until('completed entry in History', () => historyRow(description));
    }
    await measure(data.primaryClient, data.primaryDescription, data.task);
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
  if (!restarted) {
    await click('prepare CSV', () => textButton(report, 'Przygotuj podgląd CSV'));
    await until('client CSV preview', () => pick('.export-preview tbody')?.textContent.includes(data.primaryDescription));
    if (pick('.export-preview tbody').rows.length !== 1) fail('CSV preview returned a foreign entry');
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
  await evaluate(widget, `document.querySelector('[aria-label="Rozwiń panel"]').click()`);
  await waitFor('mini timer opens the focused project search', () => evaluate(widget,
    `document.activeElement === document.querySelector('[role="combobox"]')`));
  await evaluate(widget, `(() => {
    const input = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(secondClient)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor('search returns the second client project only', () => evaluate(widget, `(() => {
    const options = [...document.querySelectorAll('[role="option"]')];
    return options.length === 1 && options[0].getAttribute('aria-label') === ${JSON.stringify(`Bez zadania — ${secondClient} / ${project}`)};
  })()`));
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
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'tests/windows-hotkey.ps1'], {
    timeout: 10_000, windowsHide: true, stdio: 'pipe',
  });
  await waitFor('mini timer starts native measurement', () => evaluate(widget, `(() => {
    const clock = document.querySelector('.qp-clock');
    const elapsed = clock?.textContent.split(':').reduce((seconds, field) => seconds * 60 + Number(field), 0);
    return document.querySelector('.qp-mini')?.dataset.mode === 'running' && elapsed >= 5;
  })()`));
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
  await close(reopened);
  await waitFor('reopened mini timer closes', async () => !(await findOtherWindow()));
  console.log('PASS: native mini timer used the custom shortcut label, found the second client by keyboard, started its timer and restored the pin on reopening');
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

async function verifyDraft(cdp, sessionId, phase, primary) {
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const text = 'Szkic po przerwaniu aplikacji';
  if (phase === 'verify-recovery') {
    await waitFor('editor action for the first client is ready', () => evaluate(`(() => {
      const row = [...document.querySelectorAll('section.history tbody tr')].find(item => item.textContent.includes(${JSON.stringify(primaryDescription)}));
      const action = row?.querySelector('button[aria-label^="Popraw wpis:"]');
      return Boolean(action && !action.disabled);
    })()`));
    await waitFor('entry editor opens', () => evaluate(`(() => {
      if (document.querySelector('#entry-draft-description')) return true;
      const action = [...document.querySelectorAll('section.history tbody tr')].find(row => row.textContent.includes(${JSON.stringify(primaryDescription)}))?.querySelector('button[aria-label^="Popraw wpis:"]');
      if (action && !action.disabled) action.click();
      return false;
    })()`)).catch(async error => {
      const alerts = await evaluate(`[...document.querySelectorAll('[role="alert"]')].map(node => node.textContent.trim())`);
      throw new Error(`${error.message}; application alerts: ${JSON.stringify(alerts)}`);
    });
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
    console.log('draft: uncommitted snapshot saved while original entry remained unchanged');
    console.log('PASS: closing the window asked about the draft and Stay preserved it');
    return;
  }
  const button = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Przejdź do szkiców')`;
  await waitFor('draft reminder after process restart', () => evaluate(`Boolean(${button})`));
  await evaluate(`${button}.click()`);
  await waitFor('restore draft button', () => evaluate(`Boolean([...document.querySelectorAll('[aria-label="Szkice wpisów"] button')].find(button => button.textContent.trim() === 'Przywróć szkic' && !button.disabled))`));
  await evaluate(`[...document.querySelectorAll('[aria-label="Szkice wpisów"] button')].find(button => button.textContent.trim() === 'Przywróć szkic').click()`);
  await waitFor('draft content restored', () => evaluate(`document.querySelector('#entry-draft-description')?.value === ${JSON.stringify(text)}`));
  await evaluate(`document.querySelector('[aria-label="Edycja wpisu"] button[type="submit"]').click()`);
  await waitFor('draft applied once to history', () => evaluate(`[...document.querySelectorAll('section.history tbody tr')].some(row => row.textContent.includes(${JSON.stringify(text)}))`));
  const db = new DatabaseSync(testDb, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT description FROM entry_descriptions WHERE entry_id=1').get().description, text);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM description_revisions WHERE entry_id=1').get().count, 1);
  } finally { db.close(); }
  console.log('PASS: draft survived process interruption and applied once to the original entry');

  await waitFor('second entry editor opens', () => evaluate(`(() => {
    if (document.querySelector('#entry-draft-description')) return true;
    const action = [...document.querySelectorAll('section.history tbody tr')].find(row => row.textContent.includes(${JSON.stringify(secondDescription)}))?.querySelector('button[aria-label^="Popraw wpis:"]');
    if (action && !action.disabled) action.click();
    return false;
  })()`));
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

  await waitFor('second entry reopens after discard', () => evaluate(`(() => {
    if (document.querySelector('#entry-draft-description')) return true;
    const action = [...document.querySelectorAll('section.history tbody tr')].find(row => row.textContent.includes(${JSON.stringify(secondDescription)}))?.querySelector('button[aria-label^="Popraw wpis:"]');
    if (action && !action.disabled) action.click();
    return false;
  })()`));
  const savedText = 'Korekta zapisana przy zamknięciu';
  await evaluate(`(() => {
    const field = document.querySelector('#entry-draft-description');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(savedText)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(inspectWindow('Close', primary.pid, window), 'posted');
  await waitFor('draft save confirmation', () => evaluate(`Boolean(document.querySelector('dialog.entry-draft-dialog[open]'))`));
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
  console.log('PASS: save on close recorded exactly one correction and restored the same window');
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
    if (phase === 'initial') await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: csvDirectory });
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
    } else {
      assert.equal(seconds, null);
      console.log(`${phase}: history showed the manually recovered entry`);
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
    } else {
      assert.equal((await readdir(csvDirectory)).filter(name => name.endsWith('.csv')).length, 1);
    }
    if (phase === 'interrupt') {
      await verifyMiniTimer(cdp, sessionId);
      await verifySecondLaunch(child, env);
    }
    if (phase === 'verify-recovery' || phase === 'draft-reopen') await verifyDraft(cdp, sessionId, phase, child);
    if (phase === 'draft-reopen') await verifyRestoreRetry(cdp, sessionId);
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
let seconds, interrupted, recovery;
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
} finally {
  registry('delete', ['/f']);
}
const db = new DatabaseSync(testDb, { readOnly: true });
try {
  const rows = db.prepare(`SELECT c.name AS client, p.name AS project, e.duration_seconds AS duration,
    t.name AS task, e.id, e.started_at, e.ended_at, e.manually_resolved FROM time_entries e JOIN projects p ON p.id=e.project_id
    JOIN clients c ON c.id=p.client_id LEFT JOIN tasks t ON t.id=e.task_id ORDER BY e.id`).all();
  assert.deepEqual(rows.map(row => row.client), [primaryClient, secondClient, secondClient]);
  assert.deepEqual(rows.map(row => row.task), [task, null, null]);
  assert.ok(rows.every(row => row.project === project));
  assert.ok(rows.slice(0, 2).every(row => row.duration >= 5 && row.manually_resolved === 0));
  assert.equal(rows[0].duration, seconds);
  assert.equal(rows[2].id, interrupted.id);
  assert.equal(rows[2].started_at, interrupted.started_at);
  assert.equal(rows[2].ended_at, recovery.end);
  assert.equal(rows[2].duration, recovery.duration);
  assert.equal(rows[2].manually_resolved, 1);
} finally {
  db.close();
}
console.log('PASS: two clients, project timers, History, isolated report and CSV, and explicit recovery of the original entry after a forced exit');
