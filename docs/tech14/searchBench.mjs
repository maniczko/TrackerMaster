// TECH-14 measurement core: synthetic history and the JavaScript search variants.
// Not part of the application bundle (Vite builds from src/index.html only). Shared by
// bench-node.mjs (Node 24) and bench-browser.mjs (Edge / Chromium, the WebView2 engine).
// Everything here is deterministic: a seeded PRNG and a fixed reference "now".
import { makeReportView } from '../../src/reportView.ts';
import { historyDays } from '../../src/reportDayModel.ts';
import { allReportClients } from '../../src/reportScope.ts';
import { splitSleepTime } from '../../src/sleepTime.ts';

export const ZONE = 'Europe/Warsaw';
/** Fixed reference time (Tuesday 24.11.2026 12:00 Warsaw), so every run builds identical data. */
export const NOW_MS = Date.UTC(2026, 10, 24, 11, 0, 0);
const DAY = 86_400_000;
const MIN = 60_000;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLIENTS = ['Kancelaria Żuraw', 'Studio Łąka', 'Fundacja Źródło', 'Ślusarnia Gęś', 'Acme Polska', 'Biuro Ćma', 'Szkoła Jaźń', 'Klinika Ołówek'];
const PROJECT_WORDS = ['Wdrożenie', 'Utrzymanie', 'Audyt', 'Migracja', 'Strona www', 'Aplikacja', 'Szkolenia', 'Raporty'];
const TASK_WORDS = ['Analiza', 'Spotkanie', 'Programowanie', 'Testy', 'Dokumentacja', 'Konsultacje', 'Przegląd kodu', 'Wsparcie', 'Planowanie', 'Projekt UI', 'Faktury', 'Telefon', 'Poprawki', 'Wycena', 'Odbiór', 'Szkic', 'Konfiguracja', 'Raport', 'Badanie', 'Prezentacja', 'Logistyka', 'Zakupy', 'Rekrutacja', 'Notatki', 'Sprzątanie'];
// Polish description vocabulary; "żółć" and "Łódź" are rare on purpose (AC1 and the "ł" case).
const COMMON = ['spotkanie', 'z', 'klientem', 'poprawki', 'w', 'raporcie', 'przegląd', 'umowy', 'telefon', 'do', 'księgowości', 'wdrożenie', 'modułu', 'płatności', 'testy', 'na', 'produkcji', 'naprawa', 'błędu', 'logowania', 'dokumentacja', 'API', 'migracja', 'bazy', 'danych', 'zmiana', 'hasła', 'wycena', 'zlecenia', 'przygotowanie', 'oferty', 'szkolenie', 'zespołu', 'rozmowa', 'o', 'budżecie', 'analiza', 'wymagań', 'gęślą', 'jaźń', 'źródło', 'ćwiczenie', 'łączenie', 'kont', 'nowy', 'formularz', 'kwiecień', 'sierpień', 'wrzesień', 'październik', 'faktura', 'korekta', 'zgłoszenie', 'serwis', 'UI', 'ekran', 'mobilny', 'Warszawa', 'Kraków', 'Gdańsk', 'Poznań', 'Wrocław'];
const RARE = ['żółć', 'Łódź', 'ŻÓŁTY', 'Zażółć'];

/**
 * A synthetic history of `count` completed entries (one user, roughly 8 per working day, newest last).
 * About 2% cross local midnight, 1% carry sleep periods (pending / included / excluded / auto_included),
 * 25% have no description, 40% have no task. Durations satisfy the report's own consistency rules.
 */
export function synthesize(count, seed = 14) {
  const random = mulberry32(seed);
  const pick = list => list[Math.floor(random() * list.length)];
  const clients = CLIENTS.map((name, index) => ({ id: index + 1, name }));
  const projects = [];
  const tasks = [];
  for (const client of clients) for (let p = 0; p < 5; p++) {
    const project = { id: projects.length + 1, client_id: client.id, name: `${pick(PROJECT_WORDS)} ${client.id}.${p + 1}` };
    projects.push(project);
    for (let t = 0; t < 5; t++) tasks.push({ id: tasks.length + 1, project_id: project.id, name: TASK_WORDS[(project.id * 5 + t) % TASK_WORDS.length] });
  }
  const entries = [];
  let cursor = NOW_MS - DAY; // build backwards from yesterday, then reverse so ids grow with time
  for (let index = 0; index < count; index++) {
    const crossesMidnight = random() < 0.02;
    const minutes = crossesMidnight ? 60 + Math.floor(random() * 120) : 5 + Math.floor(random() * 115);
    const gap = 10 + Math.floor(random() * 50);
    let end = cursor - gap * MIN;
    if (crossesMidnight) {
      // End shortly after a local midnight (Warsaw is UTC+1/+2; 00:30 UTC is after local midnight).
      const day = Math.floor(end / DAY) * DAY;
      end = day + 30 * MIN;
    } else if (index % 8 === 0) {
      end -= 14 * 60 * MIN; // overnight gap between working days
    }
    const start = end - minutes * MIN;
    cursor = start;
    const project = pick(projects);
    const projectTasks = tasks.filter(task => task.project_id === project.id);
    const task = random() < 0.4 ? null : pick(projectTasks);
    let description = '';
    if (random() >= 0.25) {
      const words = 2 + Math.floor(random() * 8);
      const parts = [];
      for (let w = 0; w < words; w++) parts.push(random() < 0.01 ? pick(RARE) : pick(COMMON));
      description = parts.join(' ');
      description = description.charAt(0).toUpperCase() + description.slice(1);
    }
    entries.push({ start, end, project_id: project.id, task_id: task?.id ?? null, billable: random() < 0.6, description, sleep: random() < 0.01 ? pick(['pending', 'included', 'excluded', 'auto_included']) : null });
  }
  entries.reverse();
  const data = {
    time_zone: ZONE,
    active: null,
    entries: entries.map((item, index) => {
      const id = index + 1;
      const started_at = new Date(item.start).toISOString(); // the stored format: UTC with milliseconds (main.rs now())
      const ended_at = new Date(item.end).toISOString();
      const entry = { id, task_id: item.task_id, project_id: item.project_id, started_at, ended_at, duration_seconds: Math.floor((item.end - item.start) / 1000), billable: item.billable, description: item.description };
      if (item.sleep) {
        const third = Math.floor((item.end - item.start) / 3);
        const sleep_periods = [{ id, entryId: id, startedMs: item.start + third, endedMs: item.start + 2 * third, decision: item.sleep }];
        entry.sleep_periods = sleep_periods;
        entry.duration_seconds = Math.floor(splitSleepTime(id, item.start, item.end, sleep_periods).workMs / 1000);
      }
      return entry;
    }),
  };
  return { catalog: { clients, projects, tasks }, data };
}

/**
 * Case- and Polish-diacritic-insensitive form: lower case (pl), NFD, combining marks removed, then the
 * letters that have no Unicode decomposition. "ł" is the Polish one; NFD leaves it unchanged.
 */
export function foldText(text) {
  return text.toLocaleLowerCase('pl').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');
}

export function queryTerms(query) {
  return foldText(query).split(/\s+/).filter(Boolean);
}

const dayStartUtcGuess = date => Date.parse(`${date}T00:00:00Z`);

/** Variant J0: fold every field on every query (no index). */
export function searchNaive(data, catalog, query) {
  const terms = queryTerms(query);
  const clients = new Map(catalog.clients.map(item => [item.id, item.name]));
  const projects = new Map(catalog.projects.map(item => [item.id, item]));
  const tasks = new Map(catalog.tasks.map(item => [item.id, item.name]));
  return data.entries.filter(entry => {
    const project = projects.get(entry.project_id);
    const text = foldText(`${entry.description}\n${clients.get(project?.client_id) ?? ''}\n${project?.name ?? ''}\n${tasks.get(entry.task_id) ?? ''}`);
    return terms.every(term => text.includes(term));
  });
}

/** Folded text per entry (description + client + project + task), built once per report read. */
export function buildIndex(data, catalog) {
  const clients = new Map(catalog.clients.map(item => [item.id, item.name]));
  const projects = new Map(catalog.projects.map(item => [item.id, item]));
  const tasks = new Map(catalog.tasks.map(item => [item.id, item.name]));
  const texts = data.entries.map(entry => {
    const project = projects.get(entry.project_id);
    return foldText(`${entry.description}\n${clients.get(project?.client_id) ?? ''}\n${project?.name ?? ''}\n${tasks.get(entry.task_id) ?? ''}`);
  });
  return { entries: data.entries, texts };
}

/**
 * Variant J1: filter the prepared index. Every term must be a substring (AND). The optional date range
 * keeps entries that touch [from, through] in local days; a one-day margin is applied here and the report
 * function clips the exact local days, so the sum stays the report's own.
 */
export function searchIndexed(index, query, range = null) {
  const terms = queryTerms(query);
  const low = range ? dayStartUtcGuess(range.from) - DAY : -Infinity;
  const high = range ? dayStartUtcGuess(range.through) + 2 * DAY : Infinity;
  const result = [];
  for (let i = 0; i < index.entries.length; i++) {
    const entry = index.entries[i];
    if (range && (Date.parse(entry.ended_at) < low || Date.parse(entry.started_at) >= high)) continue;
    const text = index.texts[i];
    let ok = true;
    for (const term of terms) if (!text.includes(term)) { ok = false; break; }
    if (ok) result.push(entry);
  }
  return result;
}

/** The result total from the report's own function (D12 day segmentation, sleep and pending as in the report). */
export function resultSummary(data, catalog, matched, from, through) {
  const view = makeReportView({ ...data, entries: matched }, catalog, allReportClients, from, through);
  return { seconds: view.liveSeconds, pendingSeconds: view.pendingSeconds, excluded: view.excludedEntryIds.length, contributions: view.contributions };
}

/** Rows grouped by day for rendering (the History's own grouping), on the matched entries. */
export function resultDays(data, catalog, matched) {
  return historyDays(matched, { ...data, entries: matched }, catalog, NOW_MS);
}

export function measure(fn, { warmup = 3, runs = 15 } = {}) {
  let value;
  for (let i = 0; i < warmup; i++) value = fn();
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    value = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const at = q => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)];
  return { median: at(0.5), p95: at(0.95), max: times[times.length - 1], runs, value };
}

export const QUERIES = [
  { id: 'zolc', query: 'zolc', note: 'AC1: „zolc” → „żółć”, „Żółty”, „Zażółć” (rzadkie)' },
  { id: 'lodz', query: 'lodz', note: '„lodz” → „Łódź” (litera ł)' },
  { id: 'spotkanie', query: 'spotkanie', note: 'częste słowo opisu i nazwa zadania' },
  { id: 'two-terms', query: 'studio lak', note: 'dwa człony: klient „Studio Łąka”' },
  { id: 'one-letter', query: 'a', note: 'najgorszy przypadek: prawie wszystko pasuje' },
  { id: 'none', query: 'xqzv', note: 'brak wyników' },
];

export const FIRST_DAY = '2000-01-01';
export const TODAY = '2026-11-24';
export const LAST_30 = { from: '2026-10-26', through: '2026-11-24' };

/**
 * Variant J3: the result total from per-entry contributions of ONE report over all entries for the chosen
 * range (computed once per report read and range). The report total is a plain sum of per-entry day
 * pieces, so summing the matched entries' contributions gives the same seconds and pending seconds as
 * makeReportView on the matched entries alone. runJsBench asserts this for every query.
 */
export function contributionIndex(view) {
  return new Map(view.contributions.map(item => [item.id, item]));
}

export function sumFromContributions(contributions, matched) {
  let seconds = 0, pendingSeconds = 0, counted = 0;
  for (const entry of matched) {
    const item = contributions.get(entry.id);
    if (!item) continue;
    seconds += item.seconds; pendingSeconds += item.pendingSeconds; counted++;
  }
  return { seconds, pendingSeconds, counted };
}

/**
 * One JS measurement set for a history of `count` entries. `light` (used in Edge) skips the slowest
 * measurements of the current code: J0, historyDays and makeReportView on results above 1 500 entries.
 */
export function runJsBench(count, options = {}) {
  const light = !!options.light;
  const runs = { warmup: options.warmup ?? 3, runs: options.runs ?? 15 };
  const { catalog, data } = synthesize(count);
  const payload = JSON.stringify(data);
  const parse = measure(() => JSON.parse(payload), { warmup: 1, runs: 5 });
  const build = measure(() => buildIndex(data, catalog), { warmup: 1, runs: 5 });
  const index = build.value;
  const bases = new Map();
  const baseFor = (from, through) => {
    const key = `${from}|${through}`;
    if (!bases.has(key)) {
      const timing = measure(() => makeReportView(data, catalog, allReportClients, from, through), { warmup: 0, runs: light ? 1 : 3 });
      bases.set(key, { timing, contributions: contributionIndex(timing.value) });
    }
    return bases.get(key);
  };
  const rows = [];
  const cases = [...QUERIES.map(item => ({ ...item, range: null })), { id: 'spotkanie-30d', query: 'spotkanie', note: '„spotkanie” w ostatnich 30 dniach', range: LAST_30 }];
  for (const item of cases) {
    const from = item.range?.from ?? FIRST_DAY;
    const through = item.range?.through ?? TODAY;
    const naive = item.range || light ? null : measure(() => searchNaive(data, catalog, item.query), runs);
    const filter = measure(() => searchIndexed(index, item.query, item.range), runs);
    const matched = filter.value;
    const base = baseFor(from, through);
    const fromContributions = measure(() => sumFromContributions(base.contributions, matched), runs);
    const heavy = matched.length > 1500;
    const sum = light && heavy ? null : measure(() => resultSummary(data, catalog, matched, from, through), { warmup: 1, runs: light ? 3 : heavy ? 5 : 15 });
    const days = light ? null : measure(() => resultDays(data, catalog, matched), { warmup: 1, runs: heavy ? 3 : 10 });
    // AC2 check, to the second: J3 equals makeReportView on the matched entries (seconds and pending seconds).
    const reference = sum?.value ?? resultSummary(data, catalog, matched, from, through);
    const j3 = fromContributions.value;
    if (j3.seconds !== reference.seconds || j3.pendingSeconds !== reference.pendingSeconds) throw new Error(`AC2 mismatch for ${item.id}: ${j3.seconds}/${j3.pendingSeconds} != ${reference.seconds}/${reference.pendingSeconds}`);
    rows.push({ id: item.id, query: item.query, note: item.note, matches: matched.length, naiveMs: naive && pick(naive), filterMs: pick(filter),
      sumMs: sum && pick(sum), daysMs: days && pick(days), j3Ms: pick(fromContributions), baseMs: pick(base.timing),
      resultSeconds: reference.seconds, pendingSeconds: reference.pendingSeconds, ac2: 'równe (s i oczekujące)' });
  }
  return {
    count, payloadBytes: new TextEncoder().encode(payload).length, parseMs: pick(parse), indexMs: pick(build),
    indexChars: index.texts.reduce((sum, text) => sum + text.length, 0), fullReportMs: pick(baseFor(FIRST_DAY, TODAY).timing), rows,
    sleepEntries: data.entries.filter(entry => entry.sleep_periods).length,
    midnightEntries: data.entries.filter(entry => entry.started_at.slice(0, 10) !== entry.ended_at.slice(0, 10)).length,
  };
}

/** Markdown for one runJsBench result (median / p95 in ms). */
export function formatJsResult(js) {
  const fmt = timing => timing ? `${timing.median} / ${timing.p95}` : '—';
  const range30 = js.rows.find(row => row.id === 'spotkanie-30d');
  const lines = [
    `Dane: ${js.midnightEntries} wpisów przez północ (UTC), ${js.sleepEntries} z okresami uśpienia. Ładunek get_report_data (JSON): ${(js.payloadBytes / 1024 / 1024).toFixed(2)} MB, JSON.parse: ${fmt(js.parseMs)} ms. Budowa indeksu JS: ${fmt(js.indexMs)} ms (${js.indexChars} znaków).`,
    `Raport bazowy dla J3 (jeden makeReportView na wszystkich wpisach, raz na odczyt danych i zakres): cała historia ${fmt(js.fullReportMs)} ms; ostatnie 30 dni ${fmt(range30.baseMs)} ms.`,
    '',
    '| Zapytanie | Wyniki | J0 bez indeksu | J1 filtr | J3 suma z wkładów | Suma: makeReportView na wynikach (obecny kod) | Grupowanie dni (historyDays) | AC2 |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
    ...js.rows.map(row => `| \`${row.query}\`${row.id === 'spotkanie-30d' ? ' (30 dni)' : ''} | ${row.matches} | ${fmt(row.naiveMs)} | ${fmt(row.filterMs)} | ${fmt(row.j3Ms)} | ${fmt(row.sumMs)} | ${fmt(row.daysMs)} | ${row.ac2} |`),
  ];
  return lines.join('\n');
}

const round = value => Math.round(value * 100) / 100;
const pick = result => ({ median: round(result.median), p95: round(result.p95), max: round(result.max), runs: result.runs });
