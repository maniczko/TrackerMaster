// DEV-38: saving a move or resize. No write logic of its own: the same transactional correction as the
// DEV-26 form and the History editor (get_entry_edit_source → save_entry_draft → apply_entry_draft).
// Time and its revision are written in one transaction with the draft's receipt, so a failed write changes
// nothing and a retry of the same draft revision returns the same entry instead of a second correction.
import { invoke } from '@tauri-apps/api/core';
import { draftRange } from './entryDraft.ts';
import type { DraftList, DraftSource, EntryDraft } from './entryDraft.ts';
import type { DragEntry, DragFields } from './calendarDrag.ts';

/** A move that was not saved yet: what to send again on a retry (and the draft to apply or discard). */
export type PendingMove = { entry: DragEntry; fields: DragFields; zone: string; source: DraftSource | null; draft: EntryDraft | null };

export class MoveRefused extends Error {}

/** Saves the new range; on any failure `pending` keeps what a retry needs (the same draft revision once saved). */
export async function saveMove(pending: PendingMove): Promise<void> {
  if (!pending.source) {
    const [source, drafts] = await Promise.all([invoke<DraftSource>('get_entry_edit_source', { entryId: pending.entry.id }), invoke<DraftList>('get_entry_drafts')]);
    if (drafts.drafts.some(draft => draft.source.entryId === pending.entry.id)) {
      throw new MoveRefused('Ten wpis ma niezapisany szkic. Dokończ go albo odrzuć w Historii (widok Timer), zanim go przesuniesz.');
    }
    // Fail closed: the block was drawn from the report read; when the entry changed since, nothing is sent.
    if (Date.parse(source.startedAt) !== pending.entry.startMs || Date.parse(source.endedAt) !== pending.entry.endMs) {
      throw new MoveRefused('Wpis zmienił się od ostatniego odczytu. Kalendarz pokaże jego aktualne godziny; przesuń go ponownie.');
    }
    pending.source = source;
  }
  const fields = { start: pending.fields.start, end: pending.fields.end, description: pending.source.description, inputTimeZone: pending.zone };
  if (!pending.draft) pending.draft = await invoke<EntryDraft>('save_entry_draft', { source: pending.source, fields, expectedRevision: null });
  await invoke<number>('apply_entry_draft', { entryId: pending.entry.id, revision: pending.draft.revision, application: {
    kind: 'correction', base: pending.source, range: draftRange(fields), description: pending.source.description,
  } });
  pending.draft = null;
}

/** Drops an unsaved move: its draft (if one was written) is discarded, so History does not offer it. */
export async function discardMove(pending: PendingMove): Promise<void> {
  if (pending.draft) await invoke('discard_entry_draft', { entryId: pending.entry.id, revision: pending.draft.revision });
  pending.draft = null;
}
