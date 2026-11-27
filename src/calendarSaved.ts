import type { CalendarBillable } from './calendarModel.ts';
import { validCalendarDate, weekStartOf } from './calendarModel.ts';
import type { ReportScope } from './reportScope.ts';

// Convenience only (DEV-28): the last week and filters. Never a source of data; fail-closed on corrupt scope.
export const CALENDAR_STORAGE_KEY = 'trackermaster.calendar.v1';
export type Saved = { week?: string; month?: string; scope?: ReportScope; billable?: CalendarBillable };
export type SavedRead = { saved: Saved; corrupt: boolean };
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function validPositiveId(item: unknown): boolean {
  return item === null || (typeof item === 'number' && Number.isSafeInteger(item) && item > 0);
}

export function readSavedState(storage?: StorageLike): SavedRead {
  try {
    const store = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
    if (!store) return { saved: {}, corrupt: false };
    const raw = store.getItem(CALENDAR_STORAGE_KEY);
    if (raw === null) return { saved: {}, corrupt: false };
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { saved: {}, corrupt: true };
    const scopeValid = value.scope === undefined || (
      typeof value.scope === 'object'
      && value.scope !== null
      && !Array.isArray(value.scope)
      && validPositiveId(value.scope.clientId)
      && validPositiveId(value.scope.projectId)
      && validPositiveId(value.scope.taskId)
      && (value.scope.projectId === null || value.scope.clientId !== null)
      && (value.scope.taskId === null || value.scope.projectId !== null)
    );
    if (!scopeValid) return { saved: {}, corrupt: true };
    return {
      saved: {
        week: validCalendarDate(value.week) ? weekStartOf(value.week) : undefined,
        month: typeof value.month === 'string' ? value.month : undefined,
        scope: value.scope as ReportScope | undefined,
        billable: ['all', 'billable', 'nonbillable'].includes(value.billable) ? value.billable : undefined,
      },
      corrupt: false,
    };
  } catch { return { saved: {}, corrupt: true }; }
}

export function readSaved(storage?: StorageLike): Saved { return readSavedState(storage).saved; }

// Week and month keep each other's last position and share the filters (DEV-25).
export function save(value: Saved, storage?: StorageLike) {
  try {
    const store = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
    if (!store) return;
    store.setItem(CALENDAR_STORAGE_KEY, JSON.stringify({ ...readSaved(store), ...value }));
  } catch { /* convenience only */ }
}
