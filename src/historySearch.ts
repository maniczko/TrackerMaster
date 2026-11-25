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
import { addDaySeconds } from './reportTime.ts';
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
