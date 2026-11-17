import { Temporal } from '@js-temporal/polyfill';
import type { SleepPeriod } from './sleepTime.ts';
import { dateInZone, reportByDay } from './reportTime.ts';

export type ExportEntry = { id: number; client: string; project: string; task: string; description: string; started_at: string; ended_at: string; duration_seconds: number; billable: boolean; sleep_periods?: readonly SleepPeriod[] };
export type ExportRow = { source: ExportEntry; contribution: number };

export function makeExportRows(entries: ExportEntry[], from: string, through: string, zone: string): ExportRow[] {
  // reportByDay rejects duplicate IDs within one call. Since export computes
  // each row independently, enforce the same invariant across the full export.
  const ids = new Set<number>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.id) || entry.id <= 0 || ids.has(entry.id)) {
      throw new Error('Dane eksportu zawierają nieprawidłowy lub powtórzony identyfikator wpisu.');
    }
    ids.add(entry.id);
  }
  return entries.flatMap(source => {
    if (source.sleep_periods?.some(period => period.decision === 'pending')) throw new Error(`Wpis #${source.id} zawiera nierozstrzygnięty czas uśpienia.`);
    const result = reportByDay([source], from, through, zone);
    if (result.excludedEntryIds.length) throw new Error(`Wpis #${source.id} wymaga poprawienia przed eksportem.`);
    const zeroLengthDate = Date.parse(source.started_at) === Date.parse(source.ended_at) && source.duration_seconds === 0
      ? dateInZone(Date.parse(source.started_at), zone) : null;
    return result.totalSeconds > 0 || (zeroLengthDate !== null && zeroLengthDate >= from && zeroLengthDate <= through)
      ? [{ source, contribution: result.totalSeconds }] : [];
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
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}

// Prefix risky text for spreadsheet import; original records remain untouched.
export function spreadsheetText(value: string): string {
  return /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value;
}

const csvField = (value: string) => `"${value.replace(/"/g, '""')}"`;
export const localTimestamp = (value: string, zone: string) => Temporal.Instant.from(value).toZonedDateTimeISO(zone).toString({ smallestUnit: 'second', timeZoneName: 'never', calendarName: 'never' });

export function exportCsv(rows: ExportRow[], zone: string): string {
  const headers = ['ID wpisu', 'Klient', 'Projekt', 'Zadanie', 'Opis', 'Start', 'Koniec', 'Rozliczalność', 'Czas całkowity (sekundy)', 'Czas całkowity (HH:MM:SS)', 'Czas w wybranym okresie (sekundy)', 'Czas w wybranym okresie (HH:MM:SS)'];
  const lines = rows.map(({ source: e, contribution }) => [String(e.id), ...[e.client, e.project, e.task, e.description].map(spreadsheetText), localTimestamp(e.started_at, zone), localTimestamp(e.ended_at, zone), e.billable ? 'Tak' : 'Nie', String(e.duration_seconds), formatDuration(e.duration_seconds), String(contribution), formatDuration(contribution)]);
  return '\ufeff' + [headers, ...lines].map(line => line.map(csvField).join(';')).join('\r\n') + '\r\n';
}
