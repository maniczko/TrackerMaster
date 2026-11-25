// DEV-41 / PTT-63: history search model. AC1 (matching and Polish folding), AC2 (result totals equal the
// report of the same entries to the second: midnight, DST, sleep decisions, active timer, ranges) and the
// privacy rule (the module keeps nothing and logs nothing). Deterministic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSearchIndex, foldSearchText, matchEntries, MAX_SEARCH_LENGTH, searchBase, searchSummary, searchTerms } from '../src/historySearch.ts';
import { makeReportView } from '../src/reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from '../src/reportView.ts';
import { reportByDay } from '../src/reportTime.ts';
import { allReportClients } from '../src/reportScope.ts';
import type { ReportCatalog } from '../src/reportScope.ts';
import { splitSleepTime } from '../src/sleepTime.ts';
import type { SleepDecision } from '../src/sleepTime.ts';

const ZONE = 'Europe/Warsaw';
const catalog: ReportCatalog = {
  clients: [{ id: 1, name: 'Kancelaria Żuraw' }, { id: 2, name: 'Studio Łąka' }, { id: 3, name: 'Fundacja Źródło', archived: true }],
  projects: [
    { id: 10, client_id: 1, name: 'Wdrożenie' }, { id: 11, client_id: 1, name: 'Audyt' },
    { id: 20, client_id: 2, name: 'Strona www' }, { id: 30, client_id: 3, name: 'Szkolenia', archived: true },
  ],
  tasks: [
    { id: 100, project_id: 10, name: 'Spotkanie' }, { id: 101, project_id: 11, name: 'Przegląd kodu' },
    { id: 200, project_id: 20, name: 'Projekt UI' }, { id: 300, project_id: 30, name: 'Ćwiczenia', archived: true },
  ],
};

const completed = (id: number, project_id: number, task_id: number | null, started_at: string, ended_at: string, description = '', billable = false): CompletedReportEntry =>
  ({ id, project_id, task_id, started_at, ended_at, duration_seconds: Math.floor((Date.parse(ended_at) - Date.parse(started_at)) / 1000), billable, description });
const data = (entries: CompletedReportEntry[], active: ActiveReportEntry | null = null) => ({ entries, active, time_zone: ZONE });
// Local (Warsaw) date of a stored UTC timestamp, for checking what the generated data covers.
const dateKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.parse(iso));
const ids = (list: readonly { id: number }[]) => list.map(item => item.id).sort((a, b) => a - b);

test('AC1: folding ignores case and Polish diacritics, including ł', () => {
  assert.equal(foldSearchText('Żółć'), 'zolc');
  assert.equal(foldSearchText('ŻÓŁTY'), 'zolty');
  assert.equal(foldSearchText('Łódź'), 'lodz');
  assert.equal(foldSearchText('Zażółć gęślą jaźń'), 'zazolc gesla jazn');
  assert.equal(foldSearchText('Żółć'.normalize('NFD')), foldSearchText('Żółć'.normalize('NFC')));
  assert.deepEqual(searchTerms('  Zolc   ŁÓDŹ zolc '), ['zolc', 'lodz']);
  assert.deepEqual(searchTerms(' \t\n'), []);
  assert.equal(searchTerms('a'.repeat(MAX_SEARCH_LENGTH + 50))[0].length, MAX_SEARCH_LENGTH);
});

test('AC1: a phrase finds exactly the entries whose description, client, project or task contain every term', () => {
  const entries = [
    completed(1, 10, 100, '2026-11-02T08:00:00.000Z', '2026-11-02T09:00:00.000Z', 'Żółć w raporcie'),
    completed(2, 10, null, '2026-11-02T10:00:00.000Z', '2026-11-02T10:30:00.000Z', 'Zażółć gęślą jaźń'),
    completed(3, 20, 200, '2026-11-03T08:00:00.000Z', '2026-11-03T09:00:00.000Z', 'makieta ekranu'),
    completed(4, 30, 300, '2026-11-04T08:00:00.000Z', '2026-11-04T08:20:00.000Z', ''),
    completed(5, 11, 101, '2026-11-05T08:00:00.000Z', '2026-11-05T08:45:00.000Z', 'ŻÓŁTY przycisk, Łódź'),
  ];
  const index = buildSearchIndex(data(entries), catalog);
  const find = (phrase: string) => ids(matchEntries(index, searchTerms(phrase)));
  assert.deepEqual(find('zolc'), [1, 2]); // substring: "zażółć" too
  assert.deepEqual(find('zolt'), [5]);
  assert.deepEqual(find('lodz'), [5]);
  assert.deepEqual(find('studio lak'), [3]); // client name, two terms (AND)
  assert.deepEqual(find('lak makieta'), [3]);
  assert.deepEqual(find('lak zolc'), []);
  assert.deepEqual(find('wdrozenie'), [1, 2]); // project
  assert.deepEqual(find('spotkanie'), [1]); // task
  assert.deepEqual(find('cwiczenia'), [4]); // archived client, project and task stay searchable
  assert.deepEqual(find('xqzv'), []);
  assert.deepEqual(find(''), [1, 2, 3, 4, 5]); // no terms: no text filter
});

// Deterministic random history: midnight crossings, both 2026 DST days, every sleep decision.
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0) / 4_294_967_296;
}
const WORDS = ['spotkanie', 'raport', 'żółć', 'Łódź', 'klient', 'poprawki', 'gęś', 'API', 'faktura', 'Zażółć'];
const DECISIONS: SleepDecision[] = ['pending', 'included', 'excluded', 'auto_included'];

function history(seed: number, count: number) {
  const random = lcg(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const entries: CompletedReportEntry[] = [];
  // Start a few days before the spring DST change and walk past the autumn one.
  let cursor = Date.parse('2026-03-25T06:00:00.000Z');
  const special = [Date.parse('2026-03-28T22:30:00.000Z'), Date.parse('2026-10-24T21:30:00.000Z')];
  for (let id = 1; id <= count; id++) {
    let start = cursor + Math.floor(random() * 20) * 3_600_000;
    if (id === 7) start = special[0];
    if (id === 9) start = special[1];
    const minutes = random() < 0.15 ? 120 + Math.floor(random() * 240) : 10 + Math.floor(random() * 150);
    const end = start + minutes * 60_000;
    cursor = Math.max(cursor + Math.floor(86_400_000 * (0.5 + random() * 1.5) / 60_000) * 60_000, end);
    const project = pick(catalog.projects);
    const tasks = catalog.tasks.filter(task => task.project_id === project.id);
    const description = random() < 0.2 ? '' : Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(WORDS)).join(' ');
    const entry = completed(id, Number(project.id), random() < 0.4 ? null : Number(pick(tasks).id), new Date(start).toISOString(), new Date(end).toISOString(), description, random() < 0.5);
    if (random() < 0.12) {
      const third = Math.floor((end - start) / 3);
      const sleep_periods = [{ id, entryId: id, startedMs: start + third, endedMs: start + 2 * third, decision: pick(DECISIONS) }];
      entry.sleep_periods = sleep_periods;
      entry.duration_seconds = Math.floor(splitSleepTime(id, start, end, sleep_periods).workMs / 1000);
    }
    entries.push(entry);
  }
  return entries;
}

test('AC2: on random histories the result totals equal the report of the matched entries, to the second', () => {
  const ranges = [['2026-01-01', '2026-12-31'], ['2026-03-29', '2026-03-29'], ['2026-10-25', '2026-11-30'], ['2026-06-01', '2026-06-30']] as const;
  const phrases = ['zolc', 'lodz', 'spotkanie', 'studio', 'lak raport', 'a', '', 'zzz'];
  let checked = 0, nonZero = 0;
  const seen = new Set<string>();
  for (let seed = 1; seed <= 6; seed++) {
    const entries = history(seed, 160);
    for (const entry of entries) {
      for (const period of entry.sleep_periods ?? []) seen.add(period.decision);
      if (dateKey(entry.started_at) !== dateKey(entry.ended_at)) seen.add('midnight');
      if (dateKey(entry.started_at) === '2026-03-28' || dateKey(entry.ended_at) === '2026-03-29') seen.add('spring');
      if (dateKey(entry.started_at) === '2026-10-24' || dateKey(entry.ended_at) === '2026-10-25') seen.add('autumn');
    }
    const all = data(entries);
    const index = buildSearchIndex(all, catalog);
    for (const [from, through] of ranges) {
      const base = searchBase(all, catalog, from, through);
      for (const phrase of phrases) {
        const matched = matchEntries(index, searchTerms(phrase)) as CompletedReportEntry[];
        const summary = searchSummary(base, matched);
        const alone = makeReportView(data(matched), catalog, allReportClients, from, through);
        assert.equal(summary.seconds, alone.liveSeconds, `seconds seed ${seed} ${phrase} ${from}`);
        assert.equal(summary.pendingSeconds, alone.pendingSeconds, `pending seed ${seed} ${phrase} ${from}`);
        assert.deepEqual(summary.days, [...alone.liveDays].reverse(), `days seed ${seed} ${phrase} ${from}`);
        assert.deepEqual(ids(summary.entries), ids(alone.contributions));
        // The same total straight from reportByDay (all entries here have valid relations).
        assert.equal(summary.seconds, reportByDay(matched, from, through, ZONE).totalSeconds);
        checked++;
        if (summary.seconds > 0) nonZero++;
      }
    }
  }
  assert.equal(checked, 6 * 4 * 8);
  // The data really exercises what AC2 is about, and most cases have a non-trivial total.
  assert.deepEqual([...seen].sort(), ['auto_included', 'autumn', 'excluded', 'included', 'midnight', 'pending', 'spring']);
  assert.ok(nonZero > checked / 2, `only ${nonZero} of ${checked} cases had a non-zero total`);
});

test('AC2: an entry across midnight and DST counts only its pieces inside the range', () => {
  const entries = [
    completed(1, 10, 100, '2026-03-28T22:30:00.000Z', '2026-03-29T02:00:00.000Z', 'żółć'), // 23:30 CET – 04:00 CEST
    completed(2, 10, 100, '2026-10-24T21:30:00.000Z', '2026-10-25T02:00:00.000Z', 'żółć'), // 23:30 CEST – 03:00 CET
  ];
  const all = data(entries);
  const matched = matchEntries(buildSearchIndex(all, catalog), searchTerms('zolc'));
  assert.deepEqual(searchSummary(searchBase(all, catalog, '2026-03-29', '2026-03-29'), matched).seconds, 10_800);
  assert.deepEqual(searchSummary(searchBase(all, catalog, '2026-03-28', '2026-03-28'), matched).seconds, 1800);
  const autumn = searchSummary(searchBase(all, catalog, '2026-10-24', '2026-10-25'), matched);
  assert.deepEqual(autumn.days, [{ date: '2026-10-25', seconds: 14_400 }, { date: '2026-10-24', seconds: 1800 }]);
  assert.deepEqual(ids(autumn.entries), [2]);
});

test('AC2: pending sleep is shown apart, excluded sleep and rejected entries are not counted', () => {
  const start = Date.parse('2026-11-10T08:00:00.000Z');
  const withSleep = (id: number, decision: SleepDecision) => {
    const entry = completed(id, 20, 200, new Date(start + id * 86_400_000).toISOString(), new Date(start + id * 86_400_000 + 3 * 3_600_000).toISOString(), 'sen');
    const periods = [{ id, entryId: id, startedMs: start + id * 86_400_000 + 3_600_000, endedMs: start + id * 86_400_000 + 2 * 3_600_000, decision }];
    entry.sleep_periods = periods;
    entry.duration_seconds = Math.floor(splitSleepTime(id, Date.parse(entry.started_at), Date.parse(entry.ended_at), periods).workMs / 1000);
    return entry;
  };
  const inconsistent = { ...completed(9, 20, 200, '2026-11-20T08:00:00.000Z', '2026-11-21T08:00:00.000Z', 'sen'), duration_seconds: 60 };
  const all = data([withSleep(1, 'pending'), withSleep(2, 'excluded'), withSleep(3, 'included'), withSleep(4, 'auto_included'), inconsistent]);
  const summary = searchSummary(searchBase(all, catalog, '2026-11-01', '2026-11-30'), matchEntries(buildSearchIndex(all, catalog), searchTerms('sen')));
  assert.equal(summary.seconds, 2 * 3600 + 2 * 3600 + 3 * 3600 + 3 * 3600); // pending and excluded hours are not work
  assert.equal(summary.pendingSeconds, 3600);
  assert.equal(summary.pendingEntries, 1);
  assert.equal(summary.excludedEntries, 1);
  assert.deepEqual(ids(summary.entries), [1, 2, 3, 4]);
});

test('AC2: the active timer is counted only as the report counts it', () => {
  const entries = [completed(1, 10, 100, '2026-11-24T07:00:00.000Z', '2026-11-24T08:00:00.000Z', 'raport')];
  const running: ActiveReportEntry = { id: 2, project_id: 10, task_id: 100, started_at: '2026-11-24T09:00:00.000Z', ended_at: '2026-11-24T09:30:00.000Z', duration_seconds: 1800, unresolved: false, billable: false, description: 'raport' };
  const resolved = data(entries, running);
  const summary = searchSummary(searchBase(resolved, catalog, '2026-11-24', '2026-11-24'), matchEntries(buildSearchIndex(resolved, catalog), searchTerms('raport')));
  assert.equal(summary.seconds, 5400);
  assert.equal(summary.includesRunning, true);
  assert.equal(summary.seconds, makeReportView(resolved, catalog, allReportClients, '2026-11-24', '2026-11-24').liveSeconds);
  const unresolved = data(entries, { ...running, ended_at: null, duration_seconds: null, unresolved: true });
  const pendingClock = searchSummary(searchBase(unresolved, catalog, '2026-11-24', '2026-11-24'), matchEntries(buildSearchIndex(unresolved, catalog), searchTerms('raport')));
  assert.equal(pendingClock.seconds, 3600);
  assert.equal(pendingClock.includesRunning, false);
  assert.deepEqual(ids(pendingClock.entries), [1]);
});

test('results are newest first and the day totals are newest first', () => {
  const entries = history(3, 40);
  const all = data(entries);
  const summary = searchSummary(searchBase(all, catalog, '2026-01-01', '2026-12-31'), matchEntries(buildSearchIndex(all, catalog), []));
  const starts = summary.entries.map(entry => Date.parse(entry.started_at));
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a));
  const dates = summary.days.map(day => day.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('privacy: the search model keeps no state and never stores or logs the phrase', () => {
  const source = readFileSync(new URL('../src/historySearch.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'console.', 'invoke(', 'fetch(', 'document.cookie']) {
    assert.ok(!source.includes(forbidden), `historySearch.ts must not use ${forbidden}`);
  }
  assert.ok(!/^let\s|^const\s+\w+\s*=\s*new\s+Map/m.test(source), 'no module-level mutable state');
});
