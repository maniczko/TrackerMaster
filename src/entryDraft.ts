import { Temporal } from '@js-temporal/polyfill';

export type DraftSource = {
  databaseId: string;
  entryId: number;
  clientId: number;
  projectId: number;
  taskId: number | null;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  description: string;
  billable: boolean;
  timeRevision: number;
  descriptionRevision: number;
  billingRevision: number;
};

export type DraftTarget = {
  databaseId: string;
  clientId: number | null;
  projectId: number | null;
  taskId: number | null;
};
export type DraftFields = {
  start: string;
  end: string;
  description: string;
  inputTimeZone: string;
  target?: DraftTarget;
};
export type EditableField = 'start' | 'end' | 'description';

export type EntryDraft = {
  formatVersion: number;
  source: DraftSource;
  fields: DraftFields;
  revision: string;
  snapshotUpdatedAt: string;
};

export type DraftList = { drafts: EntryDraft[]; unreadable: number };
export type DraftSourceStatus =
  | { status: 'ready' | 'changed'; source: DraftSource }
  | { status: 'missing'; source: { databaseId: string } };

type DraftRange = { startedAt: string; endedAt: string };
export type DraftApplication =
  | { kind: 'correction'; base: DraftSource; range: DraftRange | null; description: string }
  | { kind: 'new_entry'; databaseId: string; clientId: number; projectId: number; taskId: number | null; range: DraftRange; description: string };

export const editableFields: readonly EditableField[] = ['start', 'end', 'description'];

export function sourceFields(source: DraftSource, inputTimeZone: string): DraftFields {
  const localTimestamp = (iso: string) => Temporal.Instant.from(iso)
    .toZonedDateTimeISO(inputTimeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' });
  return {
    start: localTimestamp(source.startedAt),
    end: localTimestamp(source.endedAt),
    description: source.description,
    inputTimeZone,
  };
}

export function matchesFields(a: DraftFields, b: DraftFields): boolean {
  return a.inputTimeZone === b.inputTimeZone
    && a.target?.databaseId === b.target?.databaseId
    && a.target?.clientId === b.target?.clientId
    && a.target?.projectId === b.target?.projectId
    && a.target?.taskId === b.target?.taskId
    && editableFields.every(field => a[field] === b[field]);
}

export function mergeDraftFields(current: DraftFields, recovered: DraftFields, selected: readonly EditableField[]): DraftFields {
  const result = { ...current };
  for (const field of selected) result[field] = recovered[field];
  return result;
}

export function draftRange(fields: DraftFields): DraftRange {
  const resolve = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error();
    return Temporal.PlainDateTime.from(value)
      .toZonedDateTime(fields.inputTimeZone, { disambiguation: 'reject' })
      .toInstant()
      .toString({ smallestUnit: 'second' });
  };
  try {
    return { startedAt: resolve(fields.start), endedAt: resolve(fields.end) };
  } catch {
    throw new Error('Sprawdź daty i godziny. Wybierz jednoznaczną godzinę w strefie wskazanej w formularzu.');
  }
}
