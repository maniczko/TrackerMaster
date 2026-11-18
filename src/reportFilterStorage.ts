import { Temporal } from '@js-temporal/polyfill';

export type SavedReportFilter = { kind: 'today' | 'week' } | { kind: 'custom'; from: string; through: string };
type StorageAccess = Pick<Storage, 'getItem'>;
const key = 'report-date-filter-v1';

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01') return false;
  try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; }
}

export function validReportFilter(value: unknown): value is SavedReportFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.kind === 'today' || item.kind === 'week') return true;
  return item.kind === 'custom' && validDate(item.from) && validDate(item.through) && item.from <= item.through;
}

export function readReportFilter(storage: StorageAccess): { filter: SavedReportFilter | null; problem: boolean } {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { filter: null, problem: false };
    const parsed: unknown = JSON.parse(raw);
    return validReportFilter(parsed) ? { filter: parsed, problem: false } : { filter: null, problem: true };
  } catch { return { filter: null, problem: true }; }
}

