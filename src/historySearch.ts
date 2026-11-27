// History search (PTT-63 / DEV-41, design: docs/TECH-14-HISTORY-SEARCH.md, variant J1 + J3). Pure, no I/O.
//
// - Matching (J1): every term of the phrase is a substring of the entry's folded text (description, client,
//   project, task), case- and Polish-diacritic-insensitive. The index is built once per report read.
// - Totals (J3): one makeReportView over ALL entries for the chosen range (the "base", built once per report
//   read and range); a result's seconds, pending seconds and day totals are sums of the matched entries'
//   contributions in that base. The report total is a plain sum of per-entry day pieces, so this equals
//   the report of the matched entries alone, to the second (tests/historySearch.test.ts checks it).
//
// The phrase is never stored or logged: this module keeps no state between calls.
import { makeReportView } from './reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from './reportView.ts';
import { addDaySeconds, dateInZone, validTimeZone } from './reportTime.ts';
import type { EntryContribution, ReportDay } from './reportTime.ts';
import { allReportClients } from './reportScope.ts';
import type { ReportCatalog } from './reportScope.ts';

type ReportData = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };
type SearchableEntry = CompletedReportEntry | ActiveReportEntry;

/** Longest phrase that is searched; longer input is cut (UI keeps the field at the same limit). */
export const MAX_SEARCH_LENGTH = 200;

/**
 * Case- and Polish-diacritic-insensitive form: lower case (pl), NFD, combining marks removed, then "ł" → "l"
 * ("ł" has no Unicode decomposition, so NFD alone leaves "zołc" for "Żółć").
 */
export function foldSearchText(text: string): string {
  return text.toLocaleLowerCase('pl').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');
}

/** Folded, de-duplicated terms of a phrase (split on white space); an empty list means "no text filter". */
export function searchTerms(phrase: string): string[] {
  const terms = foldSearchText(phrase.slice(0, MAX_SEARCH_LENGTH)).split(/\s+/).filter(Boolean);
  return [...new Set(terms)];
}

export type SearchIndex = { readonly entries: readonly SearchableEntry[]; readonly texts: readonly string[] };

/** Folded searchable text of every entry in the report read (completed entries and the active one). */
export function buildSearchIndex(data: ReportData, catalog: ReportCatalog): SearchIndex {
  const clients = new Map(catalog.clients.map(item => [String(item.id), item.name]));
  const projects = new Map(catalog.projects.map(item => [String(item.id), item]));
  const tasks = new Map(catalog.tasks.map(item => [String(item.id), item.name]));
  const entries: SearchableEntry[] = data.active ? [...data.entries, data.active] : [...data.entries];
  const texts = entries.map(entry => {
    const project = projects.get(String(entry.project_id));
    const client = project ? clients.get(String(project.client_id)) ?? '' : '';
    const task = entry.task_id === null ? '' : tasks.get(String(entry.task_id)) ?? '';
    return foldSearchText(`${entry.description}\n${client}\n${project?.name ?? ''}\n${task}`);
  });
  return { entries, texts };
}

/** Entries whose text contains every term (AND). No terms: every entry. */
export function matchEntries(index: SearchIndex, terms: readonly string[]): SearchableEntry[] {
  if (!terms.length) return [...index.entries];
  const result: SearchableEntry[] = [];
  for (let i = 0; i < index.entries.length; i++) {
    const text = index.texts[i];
    let ok = true;
    for (const term of terms) if (!text.includes(term)) { ok = false; break; }
    if (ok) result.push(index.entries[i]);
  }
  return result;
}

export type SearchBase = {
  readonly from: string;
  readonly through: string;
  readonly contributions: ReadonlyMap<number, EntryContribution>;
  readonly excludedEntryIds: ReadonlySet<number>;
  /** Id of the active timer when the report counts it (resolved projection), else null. */
  readonly runningId: number | null;
  readonly missingRelations: boolean;
};

/** The report for all clients over [from, through], reduced to what the search needs. Throws like makeReportView. */
export function searchBase(data: ReportData, catalog: ReportCatalog, from: string, through: string): SearchBase {
  const view = makeReportView(data, catalog, allReportClients, from, through);
  return {
    from, through,
    contributions: new Map(view.contributions.map(item => [item.id, item])),
    excludedEntryIds: new Set(view.excludedEntryIds),
    runningId: view.active && !view.active.unresolved && view.active.ended_at !== null ? view.active.id : null,
    missingRelations: view.missingRelations,
  };
}

export type SearchSummary = {
  /** Matched entries that the report counts in the range (with their contribution), newest first. */
  entries: SearchableEntry[];
  seconds: number;
  pendingSeconds: number;
  /** Matched entries with sleep awaiting a decision (their pending time is not in `seconds`). */
  pendingEntries: number;
  /** Per local day of the reporting zone, the matched entries' seconds (for the History day headers). */
  days: ReportDay[];
  /** Matched entries the report rejects as inconsistent (shown with the report's warning, not counted). */
  excludedEntries: number;
  /** True when the matched set contains the running timer counted by the report. */
  includesRunning: boolean;
};

/** Result totals from the base contributions of the matched entries (J3). */
export function searchSummary(base: SearchBase, matched: readonly SearchableEntry[]): SearchSummary {
  const entries: SearchableEntry[] = [];
  let seconds = 0, pendingSeconds = 0, pendingEntries = 0, excludedEntries = 0, includesRunning = false;
  const days = new Map<string, number>();
  for (const entry of matched) {
    const item = base.contributions.get(entry.id);
    if (!item) {
      if (base.excludedEntryIds.has(entry.id)) excludedEntries++;
      continue;
    }
    entries.push(entry);
    seconds += item.seconds;
    pendingSeconds += item.pendingSeconds;
    if (item.hasPendingSleep) pendingEntries++;
    if (entry.id === base.runningId) includesRunning = true;
    addDaySeconds(days, item.days);
  }
  entries.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id);
  return {
    entries, seconds, pendingSeconds, pendingEntries, excludedEntries, includesRunning,
    days: [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, value]) => ({ date, seconds: value })),
  };
}

/** Local date range spanning every completed entry (and a resolved active timer), or today when empty. */
export function dataDateBounds(data: ReportData, now: number): { from: string; through: string } | null {
  if (!validTimeZone(data.time_zone)) return null;
  let minMs = Infinity;
  let maxMs = -Infinity;
  const check = (startIso: string, endIso: string | null) => {
    const start = Date.parse(startIso);
    const end = endIso === null ? NaN : Date.parse(endIso);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
    if (start < minMs) minMs = start;
    const endTouch = end > start ? end - 1 : start;
    if (endTouch > maxMs) maxMs = endTouch;
  };
  for (const entry of data.entries) check(entry.started_at, entry.ended_at);
  if (data.active && !data.active.unresolved && data.active.ended_at !== null) {
    check(data.active.started_at, data.active.ended_at);
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    const today = dateInZone(now, data.time_zone);
    return { from: today, through: today };
  }
  return { from: dateInZone(minMs, data.time_zone), through: dateInZone(maxMs, data.time_zone) };
}

/** First `limit` rows across day groups, preserving full day totals even when a day spans pages. */
export function paginateHistoryDays<T, D extends { date: string; label: string; seconds: number; rows: T[] }>(
  days: readonly D[],
  limit: number,
): { days: D[]; shownRows: number; totalRows: number } {
  const maxRows = Math.max(1, Math.floor(limit));
  let totalRows = 0;
  for (const day of days) totalRows += day.rows.length;
  const visible: D[] = [];
  let shownRows = 0;
  for (const day of days) {
    if (shownRows >= maxRows) break;
    const remaining = maxRows - shownRows;
    if (day.rows.length <= remaining) {
      visible.push(day);
      shownRows += day.rows.length;
    } else {
      visible.push({ ...day, rows: day.rows.slice(0, remaining) });
      shownRows += remaining;
    }
  }
  return { days: visible, shownRows, totalRows };
}

export type HighlightPart = { text: string; hit: boolean };

/** Code-point-safe highlight spans matching `terms` under `foldSearchText` (Polish diacritics and `ł`). */
export function searchHighlightParts(text: string, terms: readonly string[]): HighlightPart[] {
  if (!text || !terms.length) return text ? [{ text, hit: false }] : [];
  const spans: [number, number][] = [];
  let folded = '';
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index)!;
    const width = code > 0xffff ? 2 : 1;
    const piece = foldSearchText(text.slice(index, index + width));
    for (let j = 0; j < piece.length; j++) spans.push([index, index + width]);
    folded += piece;
    index += width;
  }
  const ranges: [number, number][] = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    while (from <= folded.length - term.length) {
      const found = folded.indexOf(term, from);
      if (found < 0) break;
      const endIndex = found + term.length - 1;
      if (found < spans.length && endIndex < spans.length) {
        ranges.push([spans[found][0], spans[endIndex][1]]);
      }
      from = found + term.length;
    }
  }
  if (!ranges.length) return [{ text, hit: false }];
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && range[0] <= prev[1]) prev[1] = Math.max(prev[1], range[1]);
    else merged.push([...range]);
  }
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    if (end > start) parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

