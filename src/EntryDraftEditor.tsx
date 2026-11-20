import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { draftRange, editableFields, matchesFields, mergeDraftFields, sourceFields } from './entryDraft';
import type { DraftApplication, DraftFields, DraftList, DraftSource, DraftSourceStatus, EditableField, EntryDraft } from './entryDraft';
import { createDraftSort } from './draftSort';
import type { DraftSort, DraftSortState } from './draftSort';
import { clientLabels } from './clientLabels';

type NamedItem = { id: number | string; name: string; archived: boolean };
type Project = NamedItem & { client_id: number | string };
type Task = NamedItem & { project_id: number | string };
type Props = {
  clients: NamedItem[];
  projects: Project[];
  tasks: Task[];
  enabled: boolean;
  onCommitted: (entryId: number) => Promise<void>;
};

export type EntryDraftEditorHandle = {
  openEntry: (entryId: number, focus: EditableField) => void;
  hasUnsavedChanges: () => boolean;
};

type Target = { clientId: string; projectId: string; taskId: string };
type Editor = {
  session: number;
  source: DraftSource;
  base: DraftSource | null;
  baseline: DraftFields | null;
  fields: DraftFields;
  saved: EntryDraft | null;
  target: Target;
  focus: EditableField;
};
type Review = {
  draft: EntryDraft;
  current: DraftSource | null;
  currentFields: DraftFields | null;
  databaseId: string | null;
  selected: EditableField[];
};
type CloseRequest = { id: number; action: 'hide' | 'quit' };

const emptyTarget = { clientId: '', projectId: '', taskId: '' };
const fieldLabels: Record<EditableField, string> = { start: 'Rozpoczęcie', end: 'Zakończenie', description: 'Opis' };
const snapshotWarning = 'Nie udało się zapisać szkicu. Ostatnie zmiany mogą nie przetrwać zamknięcia.';

function fieldHasChanges(editor: Editor): boolean {
  return !editor.baseline || !matchesFields(editor.fields, editor.baseline);
}

const EntryDraftEditor = forwardRef<EntryDraftEditorHandle, Props>(function EntryDraftEditor(
  { clients, projects, tasks, enabled, onCommitted }, ref,
) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [items, setItems] = useState<DraftList>({ drafts: [], unreadable: 0 });
  const [listOpen, setListOpen] = useState(false);
  const [reminder, setReminder] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [storageProblem, setStorageProblem] = useState('');
  const [sort, setSort] = useState<DraftSortState>({ order: 'newest', writing: false, failed: false });
  const [sorting] = useState(() => createDraftSort(order => invoke('set_draft_sort', { order }), setSort));
  const [sortReady, setSortReady] = useState(false);
  const [sortReadProblem, setSortReadProblem] = useState(false);
  const [closeReady, setCloseReady] = useState(false);
  const [closeRequest, setCloseRequest] = useState<CloseRequest | null>(null);
  const current = useRef<Editor | null>(null);
  const sequence = useRef(0);
  const operation = useRef(false);
  const pendingWrite = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const editorSection = useRef<HTMLElement>(null);
  const listSection = useRef<HTMLElement>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const endField = useRef<HTMLInputElement>(null);
  const descriptionField = useRef<HTMLTextAreaElement>(null);
  const closeDialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const automaticCloseId = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<CloseRequest>('entry-editor-close', request => {
      setError('');
      setCloseRequest(request.payload);
    }).then(remove => {
      if (disposed) remove();
      else { unlisten = remove; setCloseReady(true); }
    }).catch(() => {
      if (!disposed) setError('Nie udało się włączyć ochrony edycji przy zamykaniu aplikacji.');
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    void invoke<DraftSort>('get_draft_sort').then(value => {
      if (!disposed) sorting.restore(value);
    }).catch(() => {
      if (!disposed) setSortReadProblem(true);
    }).finally(() => {
      if (!disposed) setSortReady(true);
    });
    return () => { disposed = true; };
  }, [sorting]);

  useEffect(() => {
    let cancelled = false;
    void invoke<DraftList>('get_entry_drafts').then(result => {
      if (!cancelled) {
        setItems(result);
        setReminder(result.drafts.length > 0);
      }
    }).catch(() => {
      if (!cancelled) setError('Nie udało się odczytać listy szkiców.');
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    const field = editor.focus === 'description' ? descriptionField : editor.focus === 'end' ? endField : dateField;
    field.current?.focus({ preventScroll: true });
    editorSection.current?.scrollIntoView({ block: 'nearest' });
  }, [editor?.session]);

  function replaceEditor(value: Editor | null) {
    current.current = value;
    setEditor(value);
  }

  async function dismissEditor() {
    window.clearTimeout(timer.current);
    setStorageProblem('');
    replaceEditor(null);
    await invoke('set_entry_editor_guard', { open: false });
  }

  async function readDrafts(): Promise<DraftList> {
    const result = await invoke<DraftList>('get_entry_drafts');
    setItems(result);
    return result;
  }

  function run(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setWorking(true);
    setError('');
    void action().catch(problem => setError(String(problem))).finally(() => {
      operation.current = false;
      setWorking(false);
    });
  }

  async function showEditor(
    source: DraftSource, base: DraftSource | null, fields: DraftFields, saved: EntryDraft | null,
    focus: EditableField, target = emptyTarget,
  ) {
    if (!closeReady) throw new Error('Ochrona edycji nie jest jeszcze dostępna. Otwórz edycję ponownie.');
    const baseline = base ? sourceFields(base, fields.inputTimeZone) : null;
    await invoke('set_entry_editor_guard', { open: true });
    setReview(null);
    setStorageProblem('');
    replaceEditor({ session: ++sequence.current, source, base, baseline, fields, saved, target, focus });
  }

  function canOpenEditor(): boolean {
    if (current.current && fieldHasChanges(current.current)) {
      setError('Zapisz lub odłóż bieżącą edycję przed otwarciem innego wpisu.');
      editorSection.current?.scrollIntoView({ block: 'nearest' });
      return false;
    }
    return true;
  }

  function openList() {
    if (!listOpen) void sorting.enterList();
    setListOpen(true);
  }

  async function reviewDraft(draft: EntryDraft) {
    openList();
    const status = await invoke<DraftSourceStatus>('check_entry_draft_source', {
      entryId: draft.source.entryId, revision: draft.revision,
    });
    if (status.status === 'ready') {
      await showEditor(draft.source, status.source, { ...draft.fields, target: undefined }, draft, 'start');
      return;
    }
    const currentSource = status.status === 'changed' ? status.source : null;
    setReview({
      draft, current: currentSource,
      currentFields: currentSource ? sourceFields(currentSource, draft.fields.inputTimeZone) : null,
      databaseId: status.status === 'missing' ? status.source.databaseId : null,
      selected: [],
    });
  }

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => current.current !== null && fieldHasChanges(current.current),
    openEntry(entryId, focus) {
      if (!enabled || operation.current) return;
      if (!closeReady) {
        setError('Ochrona edycji nie jest jeszcze dostępna. Otwórz edycję ponownie.');
        return;
      }
      if (current.current?.source.entryId === entryId) {
        const field = focus === 'description' ? descriptionField : dateField;
        field.current?.focus();
        return;
      }
      if (!canOpenEditor()) return;
      run(async () => {
        const listed = await readDrafts();
        const saved = listed.drafts.find(value => value.source.entryId === entryId);
        if (saved) {
          await reviewDraft(saved);
          listSection.current?.scrollIntoView({ block: 'nearest' });
          return;
        }
        const source = await invoke<DraftSource>('get_entry_edit_source', { entryId });
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        await showEditor(source, source, sourceFields(source, zone), null, focus);
      });
    },
  }));

  function storeSnapshot(session: number): Promise<void> {
    const write = pendingWrite.current.then(async () => {
      const active = current.current;
      if (!active || active.session !== session) return;
      const saved = active.saved;
      if (saved ? matchesFields(saved.fields, active.fields) : !fieldHasChanges(active)) return;
      const draft = await invoke<EntryDraft>('save_entry_draft', {
        source: active.source, fields: active.fields, expectedRevision: saved?.revision ?? null,
      });
      const latest = current.current;
      if (latest?.session !== session) return;
      replaceEditor({ ...latest, saved: draft });
      setStorageProblem('');
      setItems(list => ({
        ...list,
        drafts: [draft, ...list.drafts.filter(candidate => candidate.source.entryId !== draft.source.entryId)],
      }));
    });
    pendingWrite.current = write.catch(() => {
      if (current.current?.session === session) setStorageProblem(snapshotWarning);
    });
    return write;
  }

  function queueSnapshot(session: number) {
    void storeSnapshot(session).catch(() => {});
  }

  function changeField(field: EditableField, value: string) {
    const active = current.current;
    if (!active || operation.current) return;
    const normalized = field !== 'description' && value.length === 16 ? `${value}:00` : value;
    if (normalized === active.fields[field]) return;
    replaceEditor({ ...active, fields: { ...active.fields, [field]: normalized } });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => queueSnapshot(active.session), 1000);
  }

  function flushOnBlur() {
    const active = current.current;
    if (!active || operation.current) return;
    window.clearTimeout(timer.current);
    queueSnapshot(active.session);
  }

  function clearListed(draft: EntryDraft) {
    setItems(list => ({ ...list, drafts: list.drafts.filter(value => value.revision !== draft.revision) }));
    setReview(value => value?.draft.revision === draft.revision ? null : value);
  }

  async function discard(draft: EntryDraft) {
    await invoke('discard_entry_draft', { entryId: draft.source.entryId, revision: draft.revision });
    clearListed(draft);
  }

  async function applyEditor() {
      const active = current.current;
      if (!active) return;
      window.clearTimeout(timer.current);
      if (!fieldHasChanges(active)) {
        await pendingWrite.current;
        if (current.current?.saved) await discard(current.current.saved);
        await dismissEditor();
        return;
      }
      await storeSnapshot(active.session);
      const saved = current.current?.saved;
      if (!saved) throw new Error(snapshotWarning);
      let application: DraftApplication;
      if (active.base && active.baseline) {
        const rangeChanged = active.fields.start !== active.baseline.start || active.fields.end !== active.baseline.end;
        application = {
          kind: 'correction', base: active.base,
          range: rangeChanged ? draftRange(active.fields) : null, description: active.fields.description,
        };
      } else {
        const { clientId, projectId, taskId } = active.target;
        if (!clientId || !projectId || !active.fields.target) throw new Error('Wybierz klienta i projekt dla nowego wpisu.');
        application = {
          kind: 'new_entry', databaseId: active.fields.target.databaseId,
          clientId: Number(clientId), projectId: Number(projectId), taskId: taskId ? Number(taskId) : null,
          range: draftRange(active.fields), description: active.fields.description,
        };
      }
      const entryId = await invoke<number>('apply_entry_draft', { entryId: saved.source.entryId, revision: saved.revision, application });
      clearListed(saved);
      await dismissEditor();
      await onCommitted(entryId);
  }

  async function leaveEditor(keep: boolean) {
      const active = current.current;
      if (!active) return;
      window.clearTimeout(timer.current);
      if (keep) await storeSnapshot(active.session);
      else {
        await pendingWrite.current;
        if (current.current?.saved) await discard(current.current.saved);
      }
      await dismissEditor();
  }

  function updateTarget(target: Target) {
    const active = current.current;
    if (!active || operation.current || !active.fields.target) return;
    replaceEditor({
      ...active, target,
      fields: { ...active.fields, target: {
        databaseId: active.fields.target.databaseId,
        clientId: target.clientId ? Number(target.clientId) : null,
        projectId: target.projectId ? Number(target.projectId) : null,
        taskId: target.taskId ? Number(target.taskId) : null,
      } },
    });
    window.clearTimeout(timer.current);
    queueSnapshot(active.session);
  }

  function prepareNewEntry(recovered: EntryDraft, databaseId: string) {
    const reference = recovered.fields.target?.databaseId === databaseId
      ? recovered.fields.target : recovered.source.databaseId === databaseId ? recovered.source : null;
    const client = clients.find(item => !item.archived && String(item.id) === String(reference?.clientId));
    const project = client && projects.find(item => !item.archived
      && String(item.id) === String(reference?.projectId) && String(item.client_id) === String(client.id));
    const task = project && tasks.find(item => !item.archived
      && String(item.id) === String(reference?.taskId) && String(item.project_id) === String(project.id));
    const fields = { ...recovered.fields, target: {
      databaseId,
      clientId: client ? Number(client.id) : null,
      projectId: project ? Number(project.id) : null,
      taskId: task ? Number(task.id) : null,
    } };
    run(() => showEditor(recovered.source, null, fields, recovered, 'start', {
      clientId: client ? String(client.id) : '',
      projectId: project ? String(project.id) : '',
      taskId: task ? String(task.id) : '',
    }));
  }

  async function answerClose(request: CloseRequest, proceed: boolean) {
    await invoke('resolve_entry_editor_close', { requestId: request.id, proceed });
    setCloseRequest(null);
  }

  const needsCloseChoice = closeRequest !== null && editor !== null && fieldHasChanges(editor);
  useEffect(() => {
    const dialog = closeDialog.current;
    if (needsCloseChoice && dialog && !dialog.open) {
      dialog.showModal();
      stay.current?.focus();
    } else if (!needsCloseChoice && dialog?.open) {
      dialog.close();
    }
  }, [needsCloseChoice]);

  useEffect(() => {
    if (!closeRequest || needsCloseChoice || working || automaticCloseId.current === closeRequest.id) return;
    automaticCloseId.current = closeRequest.id;
    run(async () => {
      await pendingWrite.current;
      await answerClose(closeRequest, true);
      // The window can be reopened from the tray without reopening a clean form.
      window.clearTimeout(timer.current);
      replaceEditor(null);
    });
  }, [closeRequest, needsCloseChoice, working]);

  const count = items.drafts.length;
  const ordered = [...items.drafts].sort((left, right) => {
    const byTime = left.snapshotUpdatedAt.localeCompare(right.snapshotUpdatedAt);
    return (sort.order === 'newest' ? -byTime : byTime) || left.source.entryId - right.source.entryId;
  });
  const availableClients = clients.filter(item => !item.archived);
  const clientLabelById = clientLabels(clients);
  const availableProjects = projects.filter(item => !item.archived && String(item.client_id) === editor?.target.clientId);
  const availableTasks = tasks.filter(item => !item.archived && String(item.project_id) === editor?.target.projectId);
  const readableCount = count === 1 ? 'Masz 1 niezapisany szkic.' : `Niezapisane szkice (${count})`;

  return <div className="entry-drafts">
    {editor && <section ref={editorSection} className="entry-draft-panel" aria-label="Edycja wpisu">
      <h3>{editor.base ? `Korekta wpisu #${editor.source.entryId}` : 'Nowy wpis z odzyskanego szkicu'}</h3>
      <form onSubmit={event => { event.preventDefault(); run(applyEditor); }}>
        <p className="muted">Strefa wpisywanych godzin {editor.fields.inputTimeZone}</p>
        {!editor.base && <div className="selectors">
          <label>Klient<select required value={editor.target.clientId} disabled={working} onChange={e => updateTarget({ ...emptyTarget, clientId: e.target.value })}>
            <option value="">Wybierz klienta</option>{availableClients.map(client => <option key={client.id} value={client.id}>{clientLabelById.get(String(client.id))}</option>)}
          </select></label>
          <label>Projekt<select required value={editor.target.projectId} disabled={working || !editor.target.clientId} onChange={e => updateTarget({ ...editor.target, projectId: e.target.value, taskId: '' })}>
            <option value="">Wybierz projekt</option>{availableProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          <label>Zadanie<select value={editor.target.taskId} disabled={working || !editor.target.projectId} onChange={e => updateTarget({ ...editor.target, taskId: e.target.value })}>
            <option value="">Bez zadania</option>{availableTasks.map(task => <option key={task.id} value={task.id}>{task.name}</option>)}
          </select></label>
        </div>}
        <div className="selectors">
          <label>Rozpoczęcie<input ref={dateField} type="datetime-local" step={1} required disabled={working} value={editor.fields.start} onChange={e => changeField('start', e.target.value)} onBlur={flushOnBlur} /></label>
          <label>Zakończenie<input ref={endField} type="datetime-local" step={1} required disabled={working} value={editor.fields.end} onChange={e => changeField('end', e.target.value)} onBlur={flushOnBlur} /></label>
        </div>
        <label htmlFor="entry-draft-description">Opis</label>
        <textarea id="entry-draft-description" ref={descriptionField} rows={3} maxLength={2000} disabled={working} value={editor.fields.description} onChange={e => changeField('description', e.target.value)} onBlur={flushOnBlur} />
        {storageProblem && <p className="alert error" role="alert">{storageProblem}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={working || !enabled}>Zapisz</button>
          <button type="button" className="secondary" disabled={working} onClick={() => run(() => leaveEditor(true))}>Zachowaj szkic</button>
          <button type="button" className="secondary" disabled={working} onClick={() => {
            if (!fieldHasChanges(editor) && !editor.saved) run(dismissEditor);
            else if (window.confirm('Odrzucić zmiany i usunąć szkic?')) run(() => leaveEditor(false));
          }}>Odrzuć zmiany</button>
        </div>
      </form>
    </section>}
    {count > 0 && reminder && <div className="alert entry-draft-reminder" role="status">
      <strong>{readableCount}</strong>
      <div className="actions">
        <button className="secondary" type="button" onClick={openList}>Przejdź do szkiców</button>
        <button className="secondary" type="button" onClick={() => setReminder(false)}>Później</button>
      </div>
    </div>}
    {error && !needsCloseChoice && <div className="alert error" role="alert">{error}</div>}
    <dialog ref={closeDialog} className="entry-draft-dialog" aria-labelledby="draft-close-title" onCancel={event => {
      event.preventDefault();
      if (closeRequest) run(() => answerClose(closeRequest, false));
    }}>
      <h3 id="draft-close-title">Zapisać zmiany w edytowanym wpisie?</h3>
      <p>{closeRequest?.action === 'quit' ? 'Najpierw zdecyduj, co zrobić z edycją, aby zakończyć aplikację.' : 'Wybierz, co zrobić z edycją przed zamknięciem okna.'}</p>
      {error && needsCloseChoice && <p className="alert error" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" className="primary" disabled={working || !enabled} onClick={() => {
          if (closeRequest) run(async () => { await applyEditor(); await answerClose(closeRequest, true); });
        }}>Zapisz</button>
        <button type="button" className="secondary" disabled={working} onClick={() => {
          if (closeRequest) run(async () => { await leaveEditor(false); await answerClose(closeRequest, true); });
        }}>Odrzuć zmiany</button>
        <button ref={stay} type="button" className="secondary" disabled={working} onClick={() => {
          if (closeRequest) run(() => answerClose(closeRequest, false));
        }}>Pozostań</button>
      </div>
    </dialog>
    {items.unreadable > 0 && <p className="alert error" role="alert">Nie udało się odczytać części szkiców ({items.unreadable}).</p>}
    {!listOpen && count > 0 && <button className="secondary" type="button" onClick={openList}>Szkice ({count})</button>}
    {listOpen && <section ref={listSection} className="entry-draft-panel" aria-label="Szkice wpisów">
      <div className="section-top">
        <h3>Szkice ({count})</h3>
        <button className="secondary" type="button" disabled={working} onClick={() => { setListOpen(false); setReview(null); }}>Zamknij listę</button>
      </div>
      {count === 0 && <p className="muted">Brak zapisanych szkiców.</p>}
      {count > 0 && <label className="entry-draft-sort">Kolejność
        <select value={sort.order} disabled={!sortReady} onChange={e => {
          setSortReadProblem(false);
          void sorting.choose(e.target.value === 'oldest' ? 'oldest' : 'newest');
        }}>
          <option value="newest">Najnowsze</option>
          <option value="oldest">Najstarsze</option>
        </select>
      </label>}
      {sortReadProblem && <p className="alert error" role="alert">Nie udało się odczytać kolejności szkiców. Wyświetlono najnowsze.</p>}
      {sort.failed && <div className="alert error" role="alert">
        Nie udało się zapamiętać sortowania. Wybrana kolejność działa w tej sesji.
        <div className="actions"><button type="button" className="secondary" disabled={sort.writing} onClick={() => { void sorting.retry(); }}>Spróbuj ponownie</button></div>
      </div>}
      {count > 0 && <ul className="entry-draft-list">{ordered.map(draft => <li key={draft.revision}>
        <span><strong>Wpis #{draft.source.entryId}</strong> · {new Date(draft.snapshotUpdatedAt).toLocaleString('pl-PL')}</span>
        <div className="actions">
          <button type="button" className="secondary" disabled={working || !enabled || !closeReady} onClick={() => { if (canOpenEditor()) run(() => reviewDraft(draft)); }}>Przywróć szkic</button>
          <button type="button" className="secondary" disabled={working || !!editor} onClick={() => {
            if (window.confirm(`Odrzucić szkic wpisu #${draft.source.entryId}?`)) run(() => discard(draft));
          }}>Odrzuć</button>
        </div>
      </li>)}</ul>}
      {review && <div className="entry-draft-review">
        <h4>{review.current ? 'Wpis zmienił się od utworzenia szkicu' : 'Oryginalny wpis jest usunięty lub niedostępny'}</h4>
        <div className="table-wrap"><table>
          <thead><tr><th scope="col">Pole</th>{review.currentFields && <th scope="col">Aktualny wpis</th>}<th scope="col">Odzyskany szkic</th>{review.currentFields && <th scope="col">Przenieś</th>}</tr></thead>
          <tbody>{editableFields.map(field => <tr key={field}>
            <th scope="row">{fieldLabels[field]}</th>
            {review.currentFields && <td>{review.currentFields[field] || '—'}</td>}
            <td>{review.draft.fields[field] || '—'}</td>
            {review.currentFields && <td><input
              type="checkbox"
              aria-label={`Przenieś pole ${fieldLabels[field]}`}
              disabled={working || review.currentFields[field] === review.draft.fields[field]}
              checked={review.selected.includes(field)}
              onChange={event => {
                const selected = event.target.checked ? [...review.selected, field] : review.selected.filter(value => value !== field);
                setReview({ ...review, selected });
              }}
            /></td>}
          </tr>)}</tbody>
        </table></div>
        <div className="actions">
          {review.current && review.currentFields
            ? <button type="button" className="primary" disabled={working || !enabled || review.selected.length === 0} onClick={() => {
                if (review.current && review.currentFields && canOpenEditor()) {
                  const source = review.current;
                  const fields = mergeDraftFields(review.currentFields, review.draft.fields, review.selected);
                  run(() => showEditor(review.draft.source, source, fields, review.draft, review.selected[0]));
                }
              }}>Przenieś wybrane pola</button>
            : <button type="button" className="primary" disabled={working || !enabled} onClick={() => {
                if (review.databaseId && canOpenEditor()) prepareNewEntry(review.draft, review.databaseId);
              }}>Utwórz nowy wpis ze szkicu</button>}
          <button type="button" className="secondary" onClick={() => setReview(null)}>Wróć do listy</button>
        </div>
      </div>}
    </section>}
  </div>;
});

export default EntryDraftEditor;
