import { Temporal } from '@js-temporal/polyfill';
import type { SleepPeriod } from './sleepTime.ts';
import { reportByDay } from './reportTime.ts';

export type ExportEntry = { id: number; client: string; project: string; task: string; description: string; started_at: string; ended_at: string; duration_seconds: number; billable: boolean; sleep_periods?: readonly SleepPeriod[] };
export type ExportRow = { source: ExportEntry; contribution: number };

export function makeExportRows(entries: ExportEntry[], from: string, through: string, zone: string): ExportRow[] {
  const byId = new Map<number, ExportEntry>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.id) || entry.id <= 0 || byId.has(entry.id)) {
      throw new Error('Dane eksportu zawierają nieprawidłowy lub powtórzony identyfikator wpisu.');
    }
    byId.set(entry.id, entry);
  }
  const { excludedEntryIds, contributions } = reportByDay(entries, from, through, zone);
  if (excludedEntryIds.length) throw new Error(`Wpis #${excludedEntryIds[0]} wymaga poprawienia przed eksportem.`);
  return contributions.flatMap(row => {
    const source = byId.get(row.id);
    return source && !row.hasPendingSleep ? [{ source, contribution: row.seconds }] : [];
  });
}


/** Fail closed if the backend returns entries for a different client.
 * This is defense-in-depth: the SQLite query must still filter by client_id.
 */
export function makeClientExportRows(entries: ExportEntry[], clientName: string, from: string, through: string, zone: string): ExportRow[] {
  if (!clientName || entries.some(entry => entry.client !== clientName)) {
    throw new Error('Dane eksportu zawierają wpisy innego klienta.');
  }
  return makeExportRows(entries, from, through, zone);
}

export function formatDuration(seconds: number): string {
  seconds = Math.floor(seconds);
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}

// Prefix risky text for spreadsheet import; original records remain untouched.
export function spreadsheetText(value: string): string {
  return /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value;
}

const csvField = (value: string) => `"${value.replace(/"/g, '""')}"`;
export const localTimestamp = (value: string, zone: string) => Temporal.Instant.from(value).toZonedDateTimeISO(zone).toString({ smallestUnit: 'second', timeZoneName: 'never', calendarName: 'never' });

export function sameExportRows(left: readonly ExportRow[], right: readonly ExportRow[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Map(right.map(row => [row.source.id, row]));
  return left.every(row => {
    const candidate = expected.get(row.source.id);
    if (!candidate || candidate.contribution !== row.contribution) return false;
    expected.delete(row.source.id);
    const a = row.source;
    const b = candidate.source;
    return a.client === b.client && a.project === b.project && a.task === b.task
      && a.description === b.description && a.billable === b.billable && a.duration_seconds === b.duration_seconds
      && a.started_at === b.started_at && a.ended_at === b.ended_at;
  });
}

export function exportCsv(rows: ExportRow[], zone: string): string {
  const headers = ['ID wpisu', 'Klient', 'Projekt', 'Zadanie', 'Opis', 'Start', 'Koniec', 'Rozliczalność', 'Czas całkowity w sekundach', 'Czas całkowity HH:MM:SS', 'Czas w wybranym okresie w sekundach', 'Czas w wybranym okresie HH:MM:SS'];
  const lines = rows.map(({ source: e, contribution }) => [String(e.id), ...[e.client, e.project, e.task, e.description].map(spreadsheetText), localTimestamp(e.started_at, zone), localTimestamp(e.ended_at, zone), e.billable ? 'Tak' : 'Nie', String(e.duration_seconds), formatDuration(e.duration_seconds), String(contribution), formatDuration(contribution)]);
  return '\ufeff' + [headers, ...lines].map(line => line.map(csvField).join(';')).join('\r\n') + '\r\n';
}
