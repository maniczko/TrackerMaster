// DEV-26 (calendar package B): add or edit time from the calendar.
//
// No write logic of its own: a new entry goes through create_project_manual_entry (the same insert as
// "Dodaj czas ręcznie", with the billing chosen here in the same transaction); an edit goes through the
// entry drafts of History (save_entry_draft → apply_entry_draft): one transaction for time, description
// and billing, a local draft that survives a failed write or a restart (T26/T27), and a receipt that
// makes a retry return the same entry instead of a second correction.
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { draftRange, matchesFields, sourceFields } from './entryDraft';
import type { DraftFields, DraftList, DraftSource, EntryDraft } from './entryDraft';
import { formProblem, wallInstant, wallValue } from './calendarEntry';
import type { FormField, OtherEntry } from './calendarEntry';
import type { CalendarClockEntry, CalendarReportData } from './calendarModel';
import type { ReportCatalog } from './reportScope';
import { clientLabels } from './clientLabels';
import { formatDuration } from './reportCsv';
import { sentence } from './messageText';
import type { EditorCloseRequest } from './App';
import './calendarEntry.css';

export type CalendarEntryRequest =
  | { mode: 'new'; start: string; end: string }
  | { mode: 'edit'; entryId: number };

type Props = {
  request: CalendarEntryRequest;
  zone: string;
  now: number;
  catalog: ReportCatalog;
  /** All entries of the report read (not only the filtered ones): overlap hints and sleep periods. */
  data: CalendarReportData;
  active: CalendarClockEntry | null;
  enabled: boolean;
  closeRequest: EditorCloseRequest | null;
  onResolveClose: (requestId: number, proceed: boolean) => Promise<void>;
  onEditorState: (open: boolean, dirty: boolean) => void | Promise<void>;
  /** `note`: what the calendar should say after closing (e.g. a draft kept after a failed save). */
  onClose: (note?: string) => void;
  onSaved: (message: string) => Promise<void>;
};

type Loaded = { source: DraftSource; baseline: DraftFields; timeLocked: boolean };
type Form = { start: string; end: string; description: string; clientId: string; projectId: string; taskId: string; billable: boolean | null };

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const shortDay = (value: string) => `${Number(value.slice(8, 10))}.${value.slice(5, 7)}.${value.slice(0, 4)}`;

export default function CalendarEntryDialog({ request, zone, now, catalog, data, active, enabled, closeRequest, onResolveClose, onEditorState, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef(false);
  const savedDraft = useRef<EntryDraft | null>(null);
  const fieldRefs = useRef(new Map<FormField, HTMLElement>());
  const stayConfirm = useRef<HTMLButtonElement>(null);
  const handledCloseId = useRef<number | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [blocked, setBlocked] = useState('');
  const [form, setForm] = useState<Form>(() => request.mode === 'new'
    ? { start: request.start, end: request.end, description: '', clientId: '', projectId: '', taskId: '', billable: null }
    : { start: '', end: '', description: '', clientId: '', projectId: '', taskId: '', billable: null });
  const [attempted, setAttempted] = useState(false);
  const [working, setWorking] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [closeConfirm, setCloseConfirm] = useState<EditorCloseRequest | null>(null);
  const editing = request.mode === 'edit';
  const entryId = editing ? request.entryId : null;
  const reportEntry = entryId === null ? undefined : data.entries.find(entry => entry.id === entryId);

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
  }, []);

  // Edit: the current entry from the database, never the possibly older report row.
  useEffect(() => {
    if (entryId === null) return;
    let cancelled = false;
    const sleep = reportEntry?.sleep_periods ?? [];
    if (sleep.some(period => period.decision === 'pending')) {
      setBlocked('Wpis ma uśpienie do rozstrzygnięcia. Najpierw rozstrzygnij je w widoku Timer; do tego czasu wpisu nie można edytować.');
      return;
    }
    void Promise.all([invoke<DraftSource>('get_entry_edit_source', { entryId }), invoke<DraftList>('get_entry_drafts')]).then(([source, drafts]) => {
      if (cancelled) return;
      if (drafts.drafts.some(draft => draft.source.entryId === entryId)) {
        setBlocked('Ten wpis ma niezapisany szkic. Dokończ go albo odrzuć w Historii (widok Timer), zanim zmienisz go w kalendarzu.');
        return;
      }
      const baseline = sourceFields(source, zone);
      setLoaded({ source, baseline, timeLocked: sleep.length > 0 });
      setForm({ start: baseline.start, end: baseline.end, description: baseline.description, clientId: String(source.clientId),
        projectId: String(source.projectId), taskId: source.taskId === null ? '' : String(source.taskId), billable: source.billable });
    }).catch(error => { if (!cancelled) setBlocked(`Nie udało się odczytać wpisu: ${sentence(error)}`); });
    return () => { cancelled = true; };
  }, [entryId]);

  // First field: the client for a new entry, the start (or the description of a time-locked entry) for an edit.
  useEffect(() => {
    const first = editing ? (loaded ? (loaded.timeLocked ? 'description' : 'start') : null) : 'project';
    if (first) fieldRefs.current.get(first)?.focus();
  }, [editing, loaded]);

  const others = useMemo((): OtherEntry[] => {
    const label = (id: number, startMs: number, endMs: number | null) => {
      const start = wallValue(startMs, zone);
      return `wpis #${id}, ${shortDay(start)} ${start.slice(11, 16)}–${endMs === null ? 'trwa' : wallValue(endMs, zone).slice(11, 16)}`;
    };
    const list: OtherEntry[] = data.entries.map(entry => {
      const startMs = Date.parse(entry.started_at), endMs = Date.parse(entry.ended_at);
      return { id: entry.id, startMs, endMs, label: label(entry.id, startMs, endMs) };
    });
    const running = active ?? data.active;
    if (running) {
      const startMs = Date.parse(running.started_at);
      list.push({ id: Number(running.id), startMs, endMs: null, label: `trwający pomiar od ${wallValue(startMs, zone).slice(11, 16)}` });
    }
    return list.filter(entry => Number.isFinite(entry.startMs));
  }, [data, active, zone]);

  const projects = catalog.projects.filter(item => !item.archived && String(item.client_id) === form.clientId);
  const tasks = catalog.tasks.filter(item => !item.archived && String(item.project_id) === form.projectId);
  const clientLabelById = useMemo(() => clientLabels(catalog.clients as { id: number | string; name: string }[]), [catalog.clients]);
  const project = catalog.projects.find(item => String(item.id) === form.projectId) as (ReportCatalog['projects'][number] & { billable?: boolean }) | undefined;
  const billable = form.billable ?? project?.billable ?? false;
  const ready = !editing || loaded !== null;
  const dirty = useMemo(() => {
    if (blocked || !ready) return false;
    if (request.mode === 'edit') {
      if (!loaded) return false;
      return form.start !== loaded.baseline.start
        || form.end !== loaded.baseline.end
        || form.description !== loaded.source.description
        || billable !== loaded.source.billable
        || savedDraft.current !== null;
    }
    return Boolean(form.clientId || form.projectId || form.taskId || form.description.trim())
      || form.start !== request.start
      || form.end !== request.end
      || form.billable !== null;
  }, [blocked, ready, loaded, form, billable, request, saveError]);

  useEffect(() => {
    void onEditorState(true, dirty);
  }, [dirty, onEditorState]);
  useEffect(() => () => { void onEditorState(false, false); }, [onEditorState]);

  useEffect(() => {
    if (!closeRequest || handledCloseId.current === closeRequest.id || working || operation.current) return;
    handledCloseId.current = closeRequest.id;
    if (!dirty) {
      void onResolveClose(closeRequest.id, true)
        .catch(() => {})
        .finally(() => {
          onClose(savedDraft.current ? `Niezapisane zmiany wpisu #${savedDraft.current.source.entryId} zachowano jako szkic. Dokończ je w Historii (widok Timer).` : undefined);
        });
      return;
    }
    setCloseConfirm(closeRequest);
  }, [closeRequest, dirty, working, onClose, onResolveClose]);

  useEffect(() => {
    if (closeConfirm) stayConfirm.current?.focus();
  }, [closeConfirm]);

  const problem = ready && !blocked ? formProblem({
    start: form.start, end: form.end, description: form.description, zone, nowMs: now, entryId,
    needsProject: !editing, projectId: form.projectId ? Number(form.projectId) : null, others,
  }) : null;
  // A problem of the time fields shows at once (e.g. a click into the missing DST hour); a missing project after "Zapisz".
  const shownProblem = problem && (attempted || problem.field !== 'project') ? problem : null;
  const start = wallInstant(form.start, zone), end = wallInstant(form.end, zone);
  const length = 'ms' in start && 'ms' in end && end.ms > start.ms ? formatDuration(Math.floor(end.ms / 1000) - Math.floor(start.ms / 1000)) : null;
  const path = loaded && [clientLabelById.get(String(loaded.source.clientId)), catalog.projects.find(item => Number(item.id) === loaded.source.projectId)?.name,
    loaded.source.taskId === null ? null : catalog.tasks.find(item => Number(item.id) === loaded.source.taskId)?.name].filter(Boolean).join(' / ');

  function change(patch: Partial<Form>) {
    if (operation.current) return;
    setForm(current => ({ ...current, ...patch }));
  }

  function cancel() {
    if (operation.current) return;
    if (closeConfirm) {
      void answerClose(closeConfirm, false);
      return;
    }
    const kept = savedDraft.current;
    onClose(kept ? `Niezapisane zmiany wpisu #${kept.source.entryId} zachowano jako szkic. Dokończ je w Historii (widok Timer).` : undefined);
  }

  async function answerClose(requestToClose: EditorCloseRequest, proceed: boolean, note?: string) {
    setCloseConfirm(null);
    await onResolveClose(requestToClose.id, proceed);
    if (proceed) onClose(note);
  }

  async function discardAndClose(requestToClose: EditorCloseRequest) {
    if (operation.current) return;
    operation.current = true;
    setWorking(true);
    setSaveError('');
    try {
      if (savedDraft.current) {
        await invoke('discard_entry_draft', { entryId: savedDraft.current.source.entryId, revision: savedDraft.current.revision });
        savedDraft.current = null;
      }
      await answerClose(requestToClose, true);
    } catch (error) {
      setSaveError(`Nie udało się odrzucić szkicu: ${sentence(error)}`);
      await answerClose(requestToClose, false);
    } finally {
      operation.current = false;
      setWorking(false);
    }
  }

  async function save(fromClose?: EditorCloseRequest) {
    if (editing) {
      if (!loaded) return;
      const fields: DraftFields = { start: form.start, end: form.end, description: form.description, inputTimeZone: zone };
      const rangeChanged = form.start !== loaded.baseline.start || form.end !== loaded.baseline.end;
      const billingChanged = billable !== loaded.source.billable;
      if (!rangeChanged && form.description === loaded.source.description && !billingChanged && !savedDraft.current) {
        if (fromClose) await answerClose(fromClose, true);
        else onClose();
        return;
      }
      // The draft first, so a failed write keeps the edit (T26/T27); the same revision is applied on a retry.
      let saved = savedDraft.current;
      if (!saved || !matchesFields(saved.fields, fields)) {
        saved = await invoke<EntryDraft>('save_entry_draft', { source: loaded.source, fields, expectedRevision: saved?.revision ?? null });
        savedDraft.current = saved;
      }
      await invoke<number>('apply_entry_draft', { entryId: loaded.source.entryId, revision: saved.revision, application: {
        kind: 'correction', base: loaded.source, range: rangeChanged ? draftRange(fields) : null, description: form.description,
        ...(billingChanged ? { billable } : {}),
      } });
      savedDraft.current = null;
      if (fromClose) {
        await answerClose(fromClose, true);
      } else {
        onClose();
      }
      await onSaved('Zmiany wpisu zostały zapisane.');
      return;
    }
    const range = draftRange({ start: form.start, end: form.end, description: form.description, inputTimeZone: zone });
    await invoke('create_project_manual_entry', { projectId: Number(form.projectId), taskId: form.taskId ? Number(form.taskId) : null,
      startedAt: range.startedAt, endedAt: range.endedAt, description: form.description, billable });
    if (fromClose) {
      await answerClose(fromClose, true);
    } else {
      onClose();
    }
    await onSaved('Dodano wpis.');
  }

  function submit(fromClose?: EditorCloseRequest) {
    setAttempted(true);
    if (operation.current || !enabled || !ready || blocked) {
      if (fromClose && !operation.current) void answerClose(fromClose, false);
      return;
    }
    if (problem) {
      if (fromClose) void answerClose(fromClose, false);
      fieldRefs.current.get(problem.field)?.focus();
      return;
    }
    operation.current = true;
    setWorking(true);
    setSaveError('');
    void save(fromClose).catch(async error => {
      setSaveError(`Nie zapisano: ${sentence(error)} ${editing ? 'Zmiany zachowano w formularzu i w szkicu.' : 'Dane zostały w formularzu.'} Nic nie zostało zmienione; możesz spróbować ponownie.`);
      if (fromClose) await answerClose(fromClose, false);
    }).finally(() => { operation.current = false; setWorking(false); });
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab' || !dialog.current) return;
    // Focus stays in the dialog: Tab from the last control goes to the first, Shift+Tab the other way.
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(item => item.offsetParent !== null || item === document.activeElement);
    if (items.length === 0) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const ref = (field: FormField) => (node: HTMLElement | null) => { if (node) fieldRefs.current.set(field, node); else fieldRefs.current.delete(field); };
  const invalid = (field: FormField) => shownProblem?.field === field || undefined;
  const described = (field: FormField) => shownProblem?.field === field ? 'calendar-entry-problem' : undefined;
  const timeDisabled = working || !ready || !!blocked || !!loaded?.timeLocked;
  const title = editing ? `Edycja wpisu #${request.entryId}` : 'Nowy wpis';

  return <dialog ref={dialog} className="calendar-details calendar-entry-dialog" aria-labelledby="calendar-entry-title" aria-describedby="calendar-entry-zone"
    onCancel={event => { event.preventDefault(); cancel(); }} onKeyDown={onKeyDown}>
    <form noValidate onSubmit={event => { event.preventDefault(); submit(); }}>
      <h3 id="calendar-entry-title">{title}</h3>
      <p id="calendar-entry-zone" className="helper">Godziny w strefie raportu ({zone}). Enter zapisuje, Esc zamyka bez zapisu.</p>
      {blocked ? <p role="alert" className="alert error">{blocked}</p>
        : !ready ? <p role="status" className="helper">Wczytywanie wpisu…</p>
        : <>
          {editing ? <dl className="calendar-entry-target">
              <dt>Klient / projekt</dt><dd>{path || '—'}</dd>
              <dd className="helper">Klienta, projektu ani zadania zapisanego wpisu nie zmienisz w kalendarzu.</dd>
            </dl>
            : <div className="calendar-entry-row">
              <label>Klient<select ref={ref('project')} value={form.clientId} disabled={working} aria-invalid={invalid('project')} aria-describedby={described('project')}
                onChange={event => change({ clientId: event.target.value, projectId: '', taskId: '', billable: null })}>
                <option value="">Wybierz klienta</option>
                {catalog.clients.filter(item => !item.archived).map(item => <option key={item.id} value={item.id}>{clientLabelById.get(String(item.id)) ?? item.name}</option>)}
              </select></label>
              <label>Projekt<select value={form.projectId} disabled={working || !form.clientId} aria-invalid={invalid('project')} aria-describedby={described('project')}
                onChange={event => change({ projectId: event.target.value, taskId: '', billable: null })}>
                <option value="">{form.clientId ? 'Wybierz projekt' : 'Najpierw klient'}</option>
                {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
              <label>Zadanie<select value={form.taskId} disabled={working || !form.projectId} onChange={event => change({ taskId: event.target.value })}>
                <option value="">Bez zadania</option>
                {tasks.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
            </div>}
          <div className="calendar-entry-row">
            <label className="calendar-entry-time">Rozpoczęcie<input ref={ref('start')} type="datetime-local" step={1} required value={form.start} disabled={timeDisabled}
              aria-invalid={invalid('start')} aria-describedby={described('start')} onChange={event => change({ start: event.target.value.length === 16 ? `${event.target.value}:00` : event.target.value })} /></label>
            <label className="calendar-entry-time">Zakończenie<input ref={ref('end')} type="datetime-local" step={1} required value={form.end} disabled={timeDisabled}
              aria-invalid={invalid('end')} aria-describedby={described('end')} onChange={event => change({ end: event.target.value.length === 16 ? `${event.target.value}:00` : event.target.value })} /></label>
            <p className="calendar-entry-length" aria-live="polite"><span>Czas</span> <strong>{length ?? '—'}</strong></p>
          </div>
          {loaded?.timeLocked && <p className="helper">Wpis zawiera okresy uśpienia, więc jego godzin nie można zmienić. Możesz zmienić opis i rozliczalność.</p>}
          {/* A textarea keeps line breaks of an existing description (an input would drop them silently). Enter saves, Shift+Enter adds a line. */}
          <label className="calendar-entry-description">Opis<textarea ref={ref('description')} rows={2} maxLength={2000} value={form.description} disabled={working}
            aria-invalid={invalid('description')} aria-describedby={described('description')} onChange={event => change({ description: event.target.value })}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /></label>
          <label className="calendar-entry-billable"><input type="checkbox" checked={billable} disabled={working || (!editing && !form.projectId)}
            onChange={event => change({ billable: event.target.checked })} /> Rozliczalny</label>
          {shownProblem && <p id="calendar-entry-problem" role="alert" className="alert error">{shownProblem.message}</p>}
          {saveError && <p role="alert" className="alert error calendar-entry-save-error">{saveError}</p>}
          {!enabled && <p role="status" className="helper">Zapis jest chwilowo niedostępny (trwa inna operacja lub dane nie są aktualne).</p>}
        </>}
      <div className="actions">
        {!blocked && <button type="submit" className="primary" disabled={working || !ready || !enabled || !!closeConfirm}>{working ? 'Zapisywanie…' : saveError ? 'Spróbuj ponownie' : 'Zapisz'}</button>}
        <button type="button" className="secondary" disabled={working || !!closeConfirm} onClick={cancel}>{blocked ? 'Zamknij' : 'Anuluj'}</button>
      </div>
      {closeConfirm && <section className="calendar-close-confirm" role="alertdialog" aria-labelledby="calendar-close-title">
        <h4 id="calendar-close-title">Zapisać zmiany w edytowanym wpisie?</h4>
        <p className="helper">{closeConfirm.action === 'quit' ? 'Najpierw zdecyduj, co zrobić z edycją, aby zakończyć aplikację.' : 'Wybierz, co zrobić z edycją przed zamknięciem okna.'}</p>
        <div className="actions">
          <button type="button" className="primary" disabled={working || !enabled} onClick={() => submit(closeConfirm)}>Zapisz</button>
          <button type="button" className="secondary" disabled={working} onClick={() => { void discardAndClose(closeConfirm); }}>Odrzuć zmiany</button>
          <button ref={stayConfirm} type="button" className="secondary" disabled={working} onClick={() => { void answerClose(closeConfirm, false); }}>Pozostań</button>
        </div>
      </section>}
    </form>
  </dialog>;
}
