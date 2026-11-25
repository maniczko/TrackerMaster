import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Report from './Report';
import ShortcutSettings from './ShortcutSettings';
import { SleepNote, SleepPendingList, SleepReadError, usePendingSleep } from './SleepPending';
import EntryDraftEditor from './EntryDraftEditor';
import type { EntryDraftEditorHandle } from './EntryDraftEditor';
import { localInputRange, localRangeProblem, parseLocalDate } from './localDateTime';
import type { LocalRangeProblem } from './localDateTime';
import { sentence } from './messageText';
import { clientLabels } from './clientLabels';
import EntryMenu from './EntryMenu';
import { entryTimeRange } from './historyFormat';
import { defaultShortcut, shortcutLabel } from './shortcut';
import { MiniTimerTaskPicker } from './MiniTimerPanel';
import { choicesFor, createActionSettle, createRequestGate, recentChoices } from './miniTimerModel';
import { mainAction, selectionFor, selectionKey, startBlocked } from './timerChoice';
import { historyDays, liveTimerTotals, timerTotals, totalsBaseData } from './reportDayModel';
import { dateInZone } from './reportTime';
import type { HistoryRow } from './reportDayModel';
import { snapshotSignature, useAllClientsReport } from './useAllClientsReport';
import CalendarShell from './CalendarShell';
import './miniTimer.css';

type Id = number | string;
type Client = { id: Id; name: string; archived: boolean };
type Project = { id: Id; client_id: Id; name: string; archived: boolean; billable: boolean };
type Task = { id: Id; project_id: Id; name: string; archived: boolean };
type Entry = { id: Id; task_id: Id | null; project_id: Id; started_at: string; ended_at: string | null; duration_seconds?: number | null; recovered?: boolean; uncertain?: boolean; has_sleep?: boolean; excluded_sleep_ms?: number; manually_resolved?: boolean; billable: boolean; description: string };
type DeletedEntry = { id: Id; task_id: Id | null; project_id: Id; started_at: string; ended_at: string; duration_seconds: number; deleted_at: string };
type Revision = { id: Id; changed_at: string; before_start: string; before_end: string; before_seconds: number; after_start: string; after_end: string; after_seconds: number };
type BillingRevision = { id: Id; changed_at: string; before_billable: boolean; after_billable: boolean };
type DescriptionRevision = { id: Id; changed_at: string; before_description: string; after_description: string };
type DraftOrigin = { sourceEntryId: Id; createdAt: string };
type DatabaseHealth = { schema_version: number; clients: number; projects: number; tasks: number; completed_entries: number; open_entries: number };
type RestorePreview = { token: string; health: DatabaseHealth };
type ShortcutStatus = { registered: boolean; message: string; shortcut: string };
export type Snapshot = { clients: Client[]; projects: Project[]; tasks: Task[]; active: Entry | null; entries: Entry[] };
const EMPTY: Snapshot = { clients: [], projects: [], tasks: [], active: null, entries: [] };
export const same = (a: Id | undefined | null, b: Id | undefined | null) => a != null && b != null && String(a) === String(b);
export const formatDuration = (value: number) => {
  const seconds = Math.max(0, Math.floor(value));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
};
const formatDate = (value: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
};
const formatPreciseDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'medium' });
};

// Wording differs from the backend errors on purpose: the backend message still proves a rejected save.
const recoveryHints: Record<LocalRangeProblem, string> = {
  invalid: 'Tej godziny nie da się jednoznacznie ustalić (zmiana czasu). Wybierz inną.',
  before: 'Ta godzina jest wcześniejsza niż rozpoczęcie pomiaru. Wybierz późniejszą.',
  after: 'Ta godzina jest w przyszłości. Wybierz czas nie późniejszy niż teraz.',
};

export default function App() {
  const [data, setData] = useState<Snapshot>(EMPTY);
  const [snapshotAt, setSnapshotAt] = useState(0);
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [names, setNames] = useState({ client: '', project: '', task: '' });
  const [rename, setRename] = useState<{ kind: 'client' | 'project' | 'task'; id: Id; expected: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recoveryEnd, setRecoveryEnd] = useState('');
  const [manualStart, setManualStart] = useState('');
  const [manualEnd, setManualEnd] = useState('');
  const [timerDescription, setTimerDescription] = useState('');
  const [manualDescription, setManualDescription] = useState('');
  const [describe, setDescribe] = useState<{ id: Id; expected: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [deleted, setDeleted] = useState<DeletedEntry[] | null>(null);
  const [lastBackup, setLastBackup] = useState('');
  const [databaseHealth, setDatabaseHealth] = useState<DatabaseHealth | null>(null);
  const [restorePath, setRestorePath] = useState('');
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreDone, setRestoreDone] = useState('');
  const [revisions, setRevisions] = useState<{ entryId: Id; items: Revision[]; billing: BillingRevision[]; descriptions: DescriptionRevision[]; origin: DraftOrigin | null; reveal: boolean } | null>(null);
  const revisionsRequest = useRef(0);
  const revisionSection = useRef<HTMLElement>(null);
  const entryEditor = useRef<EntryDraftEditorHandle>(null);
  const hasUnsavedReportEdit = useCallback(() => entryEditor.current?.hasUnsavedChanges() ?? false, []);
  const descriptionRef = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [reportRevision, setReportRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcut, setShortcut] = useState<ShortcutStatus | null>(null);
  const readShortcut = useCallback(() => { invoke<ShortcutStatus>('shortcut_status').then(setShortcut, () => setShortcut(null)); }, []);
  useEffect(() => {
    readShortcut();
    window.addEventListener('focus', readShortcut);
    return () => window.removeEventListener('focus', readShortcut);
  }, [readShortcut]);
  const needsStructure = loaded && data.clients.length === 0;
  // A first run needs the structure forms; keep the section open once it was shown.
  useEffect(() => { if (needsStructure) setSettingsOpen(true); }, [needsStructure]);
  const openStructure = () => { setSettingsOpen(true); window.setTimeout(() => document.getElementById('new-client')?.focus(), 0); };
  useEffect(() => { if (describe) descriptionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [describe?.id]);
  useEffect(() => { if (revisions?.reveal) revisionSection.current?.scrollIntoView({ block: 'start' }); }, [revisions]);
  const refresh = useCallback(async () => {
    try {
      const next = await invoke<Snapshot>('get_snapshot');
      setData(next);
      setSnapshotAt(Date.now());
      setLoaded(true);
    } catch (e) {
      setLoaded(false);
      throw e;
    }
  }, []);

  useEffect(() => {
    refresh().catch(e => setError(`Nie udało się odczytać danych: ${String(e)}`));
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const sync = window.setInterval(() => refresh().catch(e => setError(`Nie udało się odczytać danych: ${String(e)}`)), 2500);
    return () => { window.clearInterval(timer); window.clearInterval(sync); };
  }, [refresh]);

  const projects = data.projects.filter(p => same(p.client_id, clientId) && (showArchived || !p.archived));
  const selectedProject = data.projects.find(p => same(p.id, projectId));
  const selectedClient = data.clients.find(c => same(c.id, clientId));
  const clientLabelById = useMemo(() => clientLabels(data.clients), [data.clients]);
  const selectedTask = data.tasks.find(t => same(t.id, taskId));
  const tasks = data.tasks.filter(t => same(t.project_id, projectId) && (showArchived || !t.archived));
  const activeTask = data.tasks.find(t => same(t.id, data.active?.task_id));
  const activeProject = data.projects.find(p => same(p.id, data.active?.project_id));
  const activeClient = data.clients.find(c => same(c.id, activeProject?.client_id));
  const elapsed = data.active ? Math.max(0, (now - new Date(data.active.started_at).getTime() - (data.active.excluded_sleep_ms ?? 0)) / 1000) : 0;
  const displayElapsed = Number.isFinite(elapsed) ? elapsed : 0;
  const entries = useMemo(() => [...data.entries].sort((a, b) => b.started_at.localeCompare(a.started_at)), [data.entries]);
  // Quick start: the mini timer's project/task choice (same model and component), mapped onto the lists below.
  const pickerInput = useRef<HTMLInputElement>(null);
  const timerDescriptionInput = useRef<HTMLInputElement>(null);
  const choices = useMemo(() => choicesFor(data), [data]);
  const recent = useMemo(() => recentChoices(choices, data.entries), [choices, data.entries]);
  const catalog = useMemo(() => ({ clients: data.clients, projects: data.projects, tasks: data.tasks }), [data.clients, data.projects, data.tasks]);
  // Day/week totals and History day groups come from the report's own calculation (all clients).
  // Read again after every confirmed change (reportRevision) and whenever the snapshot shows other data,
  // e.g. a start or stop from the mini timer; the open report itself still follows reportRevision only.
  const shownData = useMemo(() => snapshotSignature(data.entries, data.active), [data.entries, data.active]);
  const allClients = useAllClientsReport(loaded, `${reportRevision}|${shownData}`);
  // Timer or calendar (DEV-24). Only what is shown changes: the timer, its state and any open edit stay mounted.
  const [view, setView] = useState<'timer' | 'calendar'>(() => { try { return window.localStorage.getItem('trackermaster.view.v1') === 'calendar' ? 'calendar' : 'timer'; } catch { return 'timer'; } });
  const showView = (next: 'timer' | 'calendar') => { setView(next); try { window.localStorage.setItem('trackermaster.view.v1', next); } catch { /* convenience only */ } };
  // Totals run with the clock: the report base (re-read on changes, focus and every 60 s) plus the
  // running timer after its report projection, only while the fresh snapshot shows it resolved.
  const clockActive = data.active ? { id: data.active.id, recovered: data.active.recovered, uncertain: data.active.uncertain } : null;
  const baseData = useMemo(() => allClients.read ? totalsBaseData(allClients.read.data, clockActive) : null,
    [allClients.read, clockActive?.id, clockActive?.recovered, clockActive?.uncertain]);
  const totalsDay = baseData ? (() => { try { return dateInZone(now, baseData.time_zone); } catch { return ''; } })() : '';
  const totalsBase = useMemo(() => {
    if (!baseData) return null;
    try { return timerTotals(baseData, catalog, now); } catch { return null; }
  }, [baseData, catalog, totalsDay]);
  const totals = totalsBase && baseData ? liveTimerTotals(totalsBase, baseData, now, clockActive, now - snapshotAt <= 5000) : null;
  const historyGroups = useMemo(() => {
    if (!allClients.read) return null;
    try { return historyDays(entries, allClients.read.data, catalog, allClients.read.at); } catch { return null; }
  }, [entries, allClients.read, catalog]);
  // One write at a time: a fast double click cannot send a second start before the first returns.
  const writes = useRef(createRequestGate()).current;
  const startDisabled = startBlocked({ busy, loaded, projectId, taskId, client: selectedClient, project: selectedProject, task: selectedTask, active: data.active });
  const main = mainAction({ busy, loaded, projectId, taskId, client: selectedClient, project: selectedProject, task: selectedTask, active: data.active });
  // Start and Stop are one button that changes meaning in place: after either, a second click is ignored for a moment.
  const mainSettle = useRef(createActionSettle()).current;
  const sleep = usePendingSleep(loaded, async () => {
    setReportRevision(version => version + 1);
    await refresh();
  });
  function startTimer() {
    return execute(async () => { await invoke('start_project_timer', { projectId: Number(projectId), taskId: taskId ? Number(taskId) : null, expectedActiveId: data.active ? Number(data.active.id) : null, description: timerDescription }); setTimerDescription(''); }, data.active ? 'Przełączono zadanie.' : 'Pomiar uruchomiony.');
  }
  function runMainAction() {
    if (main.disabled) return;
    if (main.kind === 'choose') {
      // Like the mini timer: Start without a project leads to the project search.
      if (needsStructure) openStructure();
      else { pickerInput.current?.focus(); pickerInput.current?.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    // Double click in either direction: Stop → Start must not start a timer, Start → Stop must not end it.
    if (!mainSettle.allows(Date.now())) return;
    mainSettle.mark(Date.now());
    const settled = () => mainSettle.mark(Date.now());
    if (main.kind === 'stop') void execute(() => invoke('stop_timer', { expectedActiveId: Number(data.active!.id) }), 'Pomiar zatrzymany.').finally(settled);
    else void startTimer().finally(settled);
  }
  function chooseTimerTarget(key: string) {
    const next = selectionFor(choices, key);
    if (!next) return;
    setClientId(next.clientId); setProjectId(next.projectId); setTaskId(next.taskId);
    timerDescriptionInput.current?.focus();
  }

  async function execute(action: () => Promise<unknown>, message: string) {
    if (!writes.beginWrite()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      try { await action(); }
      catch (e) {
        setError(`Nie udało się potwierdzić operacji: ${sentence(e)} Sprawdź aktualny stan przed ponowieniem.`);
        try { await refresh(); } catch { /* Odczyt można ponowić osobno. */ }
        return;
      }
      setReportRevision(version => version + 1);
      try { await refresh(); setNotice(message); }
      catch (e) { setError(`${message} Nie udało się odświeżyć danych: ${sentence(e)} Ponów odczyt, nie operację.`); }
    } finally { writes.endWrite(); setBusy(false); }
  }
  async function retryRefresh() {
    setBusy(true); setError(''); setNotice('');
    try { await refresh(); setReportRevision(version => version + 1); setNotice('Dane zostały odświeżone.'); }
    catch (e) { setError(`Nie udało się odczytać danych: ${String(e)}`); }
    finally { setBusy(false); }
  }
  async function showRevisions(entryId: Id, reveal = false) {
    const request = ++revisionsRequest.current;
    try {
      const args = { entryId: Number(entryId) };
      const [items, billing, descriptions, origin] = await Promise.all([
        invoke<Revision[]>('entry_revisions', args),
        invoke<BillingRevision[]>('billing_revisions', args),
        invoke<DescriptionRevision[]>('description_revisions', args),
        invoke<DraftOrigin | null>('get_entry_draft_origin', args),
      ]);
      if (request === revisionsRequest.current) setRevisions({ entryId, items, billing, descriptions, origin, reveal });
    } catch (e) { if (request === revisionsRequest.current) setError(`Nie udało się odczytać historii zmian: ${String(e)}`); }
  }
  async function loadDeleted() {
    try { setDeleted(await invoke<DeletedEntry[]>('deleted_entries')); }
    catch (e) { setDeleted(null); setError(`Nie udało się odczytać usuniętych wpisów: ${String(e)}`); }
  }
  async function prepareRestore() {
    setBusy(true); setError(''); setNotice('');
    try { setRestorePreview(await invoke<RestorePreview>('prepare_backup_restore', { path: restorePath })); setRestoreConfirmed(false); }
    catch (e) { setRestorePreview(null); setError(String(e)); }
    finally { setBusy(false); }
  }
  async function cancelRestore() {
    if (!restorePreview) return;
    try { await invoke('cancel_backup_restore', { token: restorePreview.token }); setRestorePreview(null); setRestoreConfirmed(false); }
    catch (e) { setError(`Nie udało się anulować: ${String(e)}`); }
  }
  async function applyRestore() {
    if (!restorePreview || !restoreConfirmed) return;
    if (entryEditor.current?.hasUnsavedChanges()) {
      setError('Zapisz lub zachowaj szkic edycji przed przywróceniem kopii.');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const safetyPath = await invoke<string>('apply_backup_restore', { token: restorePreview.token, confirmed: true });
      setRestoreDone(safetyPath); setRestorePreview(null); setRestoreConfirmed(false);
    } catch (e) {
      const message = String(e);
      setRestoreConfirmed(false);
      if (message === 'Nie udało się przywrócić kopii. Sprawdź dane i kopie bezpieczeństwa przed ponowieniem.') {
        setError(message);
      } else {
        setRestorePreview(null);
        setError(`${message} Sprawdź kopię ponownie przed kolejną próbą.`);
      }
    }
    finally { setBusy(false); }
  }
  const create = (kind: 'client' | 'project' | 'task') => async (event: FormEvent) => {
    event.preventDefault();
    const name = names[kind].trim();
    if (!name) return;
    const command = `create_${kind}`;
    const args = kind === 'client' ? { name } : kind === 'project' ? { clientId: Number(clientId), name } : { projectId: Number(projectId), name };
    await execute(async () => {
      const id = String(await invoke<number>(command, args));
      if (kind === 'client') { setClientId(id); setProjectId(''); setTaskId(''); }
      if (kind === 'project') { setProjectId(id); setTaskId(''); }
      if (kind === 'task') setTaskId(id);
      setNames(old => ({ ...old, [kind]: '' }));
    }, kind === 'client' ? 'Klient dodany. Możesz teraz dodać projekt.' : kind === 'project' ? 'Projekt dodany. Możesz teraz dodać zadanie.' : 'Zadanie dodane. Możesz rozpocząć pomiar.');
  };

  // UI hints only; recover_timer stays the source of truth (it also rejects an end before the start).
  const recoveryStart = data.active?.recovered ? Date.parse(data.active.started_at) : null;
  const recoveryLimits = localInputRange(recoveryStart, now);
  const recoveryProblem = localRangeProblem(recoveryEnd, recoveryStart, now);

  const clockUnknown = !loaded || !!data.active?.recovered || !!data.active?.uncertain;
  const shortcutHint = shortcut && <p className="shortcut-hint">{data.active ? 'Zatrzymaj skrótem' : 'Skrót uruchamia pomiar z mini timera:'}{' '}
    {shortcutLabel(shortcut.shortcut || defaultShortcut).split(' + ').map((key, index) => <span key={key}>{index > 0 && ' + '}<kbd>{key}</kbd></span>)}
    {!shortcut.registered && <span> · obecnie niedostępny poza aplikacją</span>}</p>;

  const piecePartText = { whole: '', first: 'Ciąg dalszy następnego dnia', middle: 'Wpis trwa przez cały dzień', last: 'Początek poprzedniego dnia' } as const;
  // One History row; with a day piece (grouped view) it shows that day's clock range and report seconds.
  const historyEntryRow = (e: Entry, piece?: HistoryRow<Entry>) => {
                    const t = data.tasks.find(x => same(x.id, e.task_id)); const p = data.projects.find(x => same(x.id, e.project_id)); const c = data.clients.find(x => same(x.id, p?.client_id));
          const name = t?.name || 'zadanie'; const when = entryTimeRange(e.started_at, e.ended_at, now);
          const actions = !piece || piece.part === 'whole' || piece.part === 'first';
          const billingLabel = e.billable ? 'Oznacz jako nierozliczalny' : 'Oznacz jako rozliczalny';
          return <tr key={piece ? `${e.id}:${piece.date}` : e.id} data-part={piece?.part}><td><strong>{e.task_id === null ? 'Bez zadania' : t?.name || 'Nieznane zadanie'}</strong>{e.description && <small className="entry-description">{e.description}</small>}</td>
            <td>{c ? clientLabelById.get(String(c.id)) : '—'} / {p?.name || '—'}<small className="entry-billing" data-billable={e.billable}>{e.billable ? 'Rozliczalny' : 'Nierozliczalny'}</small></td>
            <td className="entry-when">{piece
              ? <><time dateTime={e.started_at} title={formatPreciseDate(e.started_at)}>{piece.start}</time>–{e.ended_at && <time dateTime={e.ended_at} title={formatPreciseDate(e.ended_at)}>{piece.end}</time>}{piece.part !== 'whole' && <small className="entry-part">{piecePartText[piece.part]}{piece.seconds !== null && ` · w tym dniu ${formatDuration(piece.seconds)}`}</small>}{piece.seconds === null && <small className="entry-part">Poza sumą raportu</small>}</>
              : <><time dateTime={e.started_at} title={formatPreciseDate(e.started_at)}>{when.start}</time>{' – '}{e.ended_at ? <time dateTime={e.ended_at} title={formatPreciseDate(e.ended_at)}>{when.end}</time> : when.end}</>}{e.manually_resolved && <small> (wskazane ręcznie)</small>}</td>
            <td className={e.duration_seconds == null ? 'duration pending' : 'duration'}>{e.duration_seconds == null ? 'Do weryfikacji' : formatDuration(e.duration_seconds)}</td>
            <td className="entry-actions">{!actions ? <small className="entry-part">Operacje przy dniu rozpoczęcia</small> : <><button type="button" className="secondary" disabled={busy || !loaded || !!data.active?.recovered} aria-label={`Wznów: ${name}`} onClick={() => void execute(() => invoke('resume_entry', { sourceId: Number(e.id), expectedActiveId: data.active ? Number(data.active.id) : null }), 'Pomiar wznowiony.')}>Wznów</button>
              <EntryMenu label={`Więcej operacji: ${name}`} items={[
                { key: 'description', label: 'Zmień opis', ariaLabel: `Zmień opis: ${name}`, disabled: busy || !loaded, onSelect: () => entryEditor.current?.openEntry(Number(e.id), 'description') },
                { key: 'billing', label: billingLabel, ariaLabel: `${billingLabel}: ${name}`, disabled: busy || !loaded, onSelect: () => void execute(() => invoke('set_entry_billable', { entryId: Number(e.id), expected: e.billable, billable: !e.billable }), 'Zapisano rozliczalność wpisu.') },
                { key: 'correct', label: 'Popraw wpis', ariaLabel: `Popraw wpis: ${name}`, disabled: busy || !e.ended_at, onSelect: () => entryEditor.current?.openEntry(Number(e.id), 'start') },
                { key: 'history', label: 'Historia zmian', ariaLabel: `Historia zmian: ${name}`, onSelect: () => void showRevisions(e.id) },
                { key: 'delete', label: 'Usuń wpis', ariaLabel: `Usuń wpis: ${name}`, danger: true, disabled: busy || !e.ended_at, onSelect: () => setDeleting(e) },
              ]} /></>}</td></tr>;
  };
  if (restoreDone) return <div className="app-shell"><main><section className="card"><h1>Kopia została przywrócona</h1><p>Ze względów bezpieczeństwa zamknij aplikację i uruchom ją ponownie. Jeśli kopia zawierała otwarty pomiar, po uruchomieniu będzie on wymagał weryfikacji.</p><p>Kopia danych sprzed przywrócenia: <code>{restoreDone}</code>. Nie jest szyfrowana.</p>{error && <div role="alert" className="alert error">{error}</div>}<button className="primary" onClick={() => invoke('exit_after_restore').catch(e => setError(`Nie udało się zamknąć aplikacji: ${String(e)}`))}>Zamknij aplikację</button></section></main></div>;

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">T</span><div><strong>TrackerMaster</strong><small>Twój czas, pod kontrolą</small></div></div>
      <div className="view-switch" role="group" aria-label="Widok"><button type="button" aria-pressed={view === 'timer'} onClick={() => showView('timer')}>Timer</button><button type="button" aria-pressed={view === 'calendar'} onClick={() => showView('calendar')}>Kalendarz</button></div>
      <div className="topbar-actions"><button className="widget-open" onClick={() => invoke('open_widget').catch(e => setError(`Nie udało się otworzyć widgetu: ${String(e)}`))}>Otwórz widget</button><span className="local-pill"><span /> Lokalnie na tym komputerze</span></div></header>
    <main>
      {import.meta.env.VITE_TRACKER_TEST_MODE === '1' && <div role="note" className="alert warning"><strong>Wersja testowa.</strong> Korzysta z osobnej bazy na tym komputerze. Wprowadzaj wyłącznie fikcyjne dane.</div>}
      <div className="heading" hidden={view !== 'timer'}><div><h1>Rejestracja czasu</h1><p className="subtitle">Wybierz projekt i skup się na pracy. Resztą zajmie się licznik.</p></div><div className="date">{new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</div></div>
      {error && <div role="alert" className="alert error">{error}</div>}
      {!loaded && <div role="status" className="alert error">Dane nie są aktualne. Odczytaj je ponownie przed wykonaniem kolejnej operacji. <button type="button" disabled={busy} onClick={retryRefresh}>Ponów odczyt</button></div>}
      {/* One compact review banner (UIQ-01): title and one sentence, the end-time form, the sleep note with the
          only button to the list, and the full rule under "Dlaczego?". The timer card stays visible at 1280×720. */}
      {loaded && data.active?.uncertain && !data.active.recovered && <div role="alert" className="alert pending timer-review">
        <p className="timer-review-lead"><strong>Nie można wiarygodnie wyświetlić czasu pomiaru.</strong> {data.active.has_sleep ? 'Uzupełnij brakujące czasy wybudzenia, a potem zatrzymaj pomiar przyciskiem pod licznikiem.' : 'Zatrzymaj pomiar przyciskiem pod licznikiem, aby go rozliczyć.'}</p>
        <SleepNote sleep={sleep} />
        <details className="timer-review-why"><summary>Dlaczego?</summary><p>Przyczyną mogło być uśpienie komputera, pominięte zdarzenie zasilania lub zmiana zegara. {data.active.has_sleep ? 'Jeśli na liście okresów uśpienia brakuje czasu wybudzenia, najpierw go uzupełnij. ' : ''}Następnie zatrzymaj pomiar: jeśli czasu nie da się potwierdzić, aplikacja nie zapisze końca i poprosi o faktyczny czas zakończenia.</p></details></div>}
      {loaded && data.active?.recovered && <div role="alert" className="alert pending timer-review">
        <p className="timer-review-lead"><strong>Pomiar wymaga weryfikacji.</strong> Rozpoczęto {formatDate(data.active.started_at)} — podaj faktyczny czas zakończenia. {data.active.has_sleep ? 'Czas do tej godziny zostanie zaliczony jako praca, z wyjątkiem okresów uśpienia, o których zdecydujesz.' : 'Cały czas do tej godziny, także przerwy, zostanie zaliczony jako praca.'}</p>
        <form noValidate className="timer-review-form" onSubmit={e => { e.preventDefault(); const end = parseLocalDate(recoveryEnd); if (!end) { setError('Sprawdź datę i godzinę zakończenia. Godzina nie może być nieistniejąca ani występować dwukrotnie przy zmianie czasu.'); return; } execute(() => invoke('recover_timer', { endedAt: end.toISOString(), expectedActiveId: Number(data.active!.id) }), 'Przerwany pomiar zapisano z ręcznie wskazanym zakończeniem.'); }}>
          <label>Data i godzina zakończenia <input type="datetime-local" step="1" required min={recoveryLimits.min} max={recoveryLimits.max} aria-invalid={recoveryProblem !== null} aria-describedby={recoveryProblem ? 'recovery-end-problem' : undefined} value={recoveryEnd} onChange={e => setRecoveryEnd(e.target.value)} /></label>{' '}
          <button type="submit" className="primary" disabled={busy || !loaded || !recoveryEnd || recoveryProblem === 'after' || recoveryProblem === 'invalid'}>Zapisz zakończenie</button>
          {recoveryProblem && <p id="recovery-end-problem" className="field-problem" role="status">{recoveryHints[recoveryProblem]}</p>}
        </form>
        <SleepNote sleep={sleep} />
        <details className="timer-review-why"><summary>Dlaczego?</summary><p>{data.active.has_sleep ? 'Jeśli praca zakończyła się przed uśpieniem komputera, wpisz tę godzinę — późniejsze okresy uśpienia nie będą liczone. Okres uśpienia, który trwał w chwili zakończenia, zostanie przycięty do tej godziny i pozostanie do Twojej decyzji. Pozostały czas między początkiem a wskazanym końcem, także niezarejestrowane przerwy, zostanie zaliczony jako praca.' : 'Cały okres między początkiem a wskazanym końcem zostanie zaliczony jako praca, także ewentualne przerwy.'}</p></details></div>}
      {loaded && !data.active?.recovered && !data.active?.uncertain && sleep.items.length > 0 && <div role="status" className="alert timer-review"><SleepNote sleep={sleep} /></div>}
      <SleepReadError sleep={sleep} />
      {notice && <div role="status" className="alert success">{notice}</div>}
      <div className="timer-view" hidden={view !== 'timer'}>
      <section className="timer card" aria-label="Pomiar czasu">
        <div className="timer-layout">
          <div className="timer-now">
          <div className="section-top"><div><p className="section-kicker">AKTUALNY POMIAR</p><h2>Timer</h2></div><span className={`status ${loaded && data.active && !data.active.recovered && !data.active.uncertain ? 'running' : loaded && (data.active?.recovered || data.active?.uncertain) ? 'pending' : ''}`}><span />{!loaded ? 'Brak danych' : data.active?.recovered || data.active?.uncertain ? 'Do weryfikacji' : data.active ? 'W trakcie' : 'Zatrzymany'}</span></div>
          {clockUnknown
            ? <div className="clock clock-unknown" role="img" aria-label={loaded ? 'Czas do weryfikacji' : 'Czas nieznany'} aria-live="off"><span>—</span><span className="clock-sep">:</span><span>—</span><span className="clock-sep">:</span><span>—</span></div>
            : <div className="clock" aria-live="off">{formatDuration(displayElapsed)}</div>}<p className="clock-caption">{!loaded ? 'Nie można ustalić stanu pomiaru' : data.active?.recovered || data.active?.uncertain ? 'Pomiar wymaga weryfikacji' : data.active ? 'Czas zapisze się przy zatrzymaniu' : 'Wybierz projekt lub zadanie, aby rozpocząć'}</p>
          <p className="timer-totals" aria-label="Suma czasu, wszyscy klienci">{totals ? totals.text : 'Dziś — · Tydzień —'}{totals?.needsReview && <span className="timer-totals-note"> · raport zawiera uwagi</span>}</p>
          {/* The main action: one place and size for Start (Deep Teal) and Stop (coral). */}
          <div className={`actions timer-main ${main.kind === 'stop' ? 'timer-stop' : 'timer-start'}`}>
            <button type="button" className="primary" disabled={main.disabled} aria-describedby={main.kind === 'choose' ? 'timer-main-hint' : undefined} onClick={runMainAction}>
              <span aria-hidden="true">{main.kind === 'stop' ? '■' : '▶'}</span> {main.kind === 'stop' ? 'Zatrzymaj' : 'Rozpocznij'}
            </button>
          </div>
          {main.kind === 'choose' && <p id="timer-main-hint" className="helper timer-main-hint">{needsStructure ? 'Najpierw dodaj klienta i projekt.' : 'Najpierw wybierz projekt lub zadanie.'}</p>}
          {(!data.active || (loaded && !data.active.recovered && !data.active.uncertain)) && shortcutHint}
          {loaded && data.active && <div className="active-info"><span>AKTYWNY POMIAR</span><strong>{data.active.task_id === null ? 'Bez zadania' : activeTask?.name || 'Nieznane zadanie'}</strong><small>{activeClient ? clientLabelById.get(String(activeClient.id)) : '—'} / {activeProject?.name || '—'}</small><small>{data.active.description || 'Bez opisu'}</small><button className="secondary" type="button" disabled={busy} onClick={() => setDescribe({ id: data.active!.id, expected: data.active!.description, value: data.active!.description })}>Zmień opis</button></div>}
          </div>
          <div className="timer-setup">
          {needsStructure && <p className="alert">Aby rozpocząć pomiar, dodaj najpierw klienta i projekt. <button type="button" className="secondary" onClick={openStructure}>Dodaj klienta i projekt</button></p>}
          {/* Toggl-like bar: description and Start/Switch stay at the top, above the picker results (UIQ-01: visible without scrolling). */}
          <div className="timer-bar">
            <label className="timer-description">Opis nowego pomiaru (opcjonalnie)<input ref={timerDescriptionInput} value={timerDescription} maxLength={2000} disabled={busy || !loaded} onChange={e => setTimerDescription(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !data.active) { e.preventDefault(); runMainAction(); } }} placeholder="Nad czym pracujesz?" /></label>
            {data.active && <div className="actions timer-start timer-switch"><button type="button" className="secondary" disabled={startDisabled} title={startDisabled && loaded && !busy && !data.active.recovered ? 'Wybierz inny projekt lub zadanie, aby przełączyć pomiar.' : undefined} onClick={() => void startTimer()}><span aria-hidden="true">⇄</span> Przełącz zadanie</button></div>}
          </div>
          <p className="timer-target" aria-live="polite">{selectedProject ? <>Wybrano: <strong>{selectedTask ? selectedTask.name : 'Bez zadania'}</strong> · {selectedClient ? clientLabelById.get(String(selectedClient.id)) : '—'} / {selectedProject.name}</> : 'Wybierz projekt lub zadanie poniżej.'}</p>
          <div className="timer-picker"><MiniTimerTaskPicker emptyHint="Najpierw dodaj klienta i projekt w sekcji „Dane i ustawienia” poniżej, w tym oknie." input={pickerInput} choices={choices} recent={recent} selected={selectionKey(projectId, taskId)}
            disabled={busy || !loaded || !!data.active?.recovered} onSelect={chooseTimerTarget} /></div>
          <details className="timer-lists"><summary>Wybierz z list: klient, projekt, zadanie</summary>
          <div className="selectors">
            <label>Klient<select title={selectedClient ? clientLabelById.get(String(selectedClient.id)) : undefined} value={clientId} disabled={busy || !loaded} onChange={e => { setClientId(e.target.value); setProjectId(''); setTaskId(''); }}><option value="">Wybierz klienta</option>{data.clients.filter(c => showArchived || !c.archived).map(c => <option key={c.id} value={c.id}>{clientLabelById.get(String(c.id))}{c.archived ? ' (archiwum)' : ''}</option>)}</select></label>
            <label>Projekt<select title={selectedProject?.name} value={projectId} disabled={busy || !loaded || !clientId} onChange={e => { setProjectId(e.target.value); setTaskId(''); }}><option value="">Wybierz projekt</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? ' (archiwum)' : ''}</option>)}</select></label>
            <label>Zadanie<select title={selectedTask?.name} value={taskId} disabled={busy || !loaded || !projectId} onChange={e => setTaskId(e.target.value)}><option value="">Bez zadania</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.name}{t.archived ? ' (archiwum)' : ''}</option>)}</select></label>
          </div>
          </details>
          <p className="helper">Jednocześnie może trwać jeden pomiar. Zadanie jest opcjonalne.</p>
          <details className="timer-settings"><summary>Archiwum i rozliczalność</summary>
          <div className="archive-controls"><label><input type="checkbox" checked={showArchived} onChange={e => { setShowArchived(e.target.checked); if (!e.target.checked && selectedClient?.archived) { setClientId(''); setProjectId(''); setTaskId(''); } else if (!e.target.checked && selectedProject?.archived) { setProjectId(''); setTaskId(''); } else if (!e.target.checked && selectedTask?.archived) setTaskId(''); }} /> Pokaż archiwum klientów, projektów i zadań</label>
          {selectedClient && <button className="secondary" disabled={busy || !loaded} onClick={() => execute(async () => { await invoke('archive_client', { clientId: Number(clientId), archived: !selectedClient.archived }); if (!selectedClient.archived && !showArchived) { setClientId(''); setProjectId(''); setTaskId(''); } }, selectedClient.archived ? 'Klient przywrócony. Projekty pozostają w archiwum.' : 'Klient przeniesiony do archiwum; historia pozostaje dostępna.')}>{selectedClient.archived ? 'Przywróć klienta' : 'Archiwizuj klienta'}</button>}
          {selectedProject && <button className="secondary" disabled={busy || !loaded} onClick={() => execute(async () => { await invoke('archive_project', { projectId: Number(projectId), archived: !selectedProject.archived }); if (!selectedProject.archived && !showArchived) { setProjectId(''); setTaskId(''); } }, selectedProject.archived ? 'Projekt przywrócony.' : 'Projekt przeniesiony do archiwum; historia pozostaje dostępna.')}>{selectedProject.archived ? 'Przywróć projekt' : 'Archiwizuj projekt'}</button>}
          {selectedTask && <button className="secondary" disabled={busy || !loaded} onClick={() => execute(async () => { await invoke('archive_task', { taskId: Number(taskId), archived: !selectedTask.archived }); if (!selectedTask.archived && !showArchived) setTaskId(''); }, selectedTask.archived ? 'Zadanie przywrócone.' : 'Zadanie przeniesione do archiwum; historia pozostaje dostępna.')}>{selectedTask.archived ? 'Przywróć zadanie' : 'Archiwizuj zadanie'}</button>}</div>
          {selectedProject && <div className="archive-controls"><label><input type="checkbox" checked={selectedProject.billable} disabled={busy || !loaded} onChange={e => void execute(() => invoke('set_project_billable', { projectId: Number(selectedProject.id), expected: selectedProject.billable, billable: e.target.checked }), 'Zapisano domyślną rozliczalność projektu.')} /> Nowe pomiary projektu są domyślnie rozliczalne</label></div>}
          {selectedProject && <p className="helper">Zmiana ustawienia projektu nie zmienia wcześniejszych ani trwających pomiarów.</p>}
          {loaded && data.active && <div className="archive-controls"><label><input type="checkbox" checked={data.active.billable} disabled={busy} onChange={e => void execute(() => invoke('set_entry_billable', { entryId: Number(data.active!.id), expected: data.active!.billable, billable: e.target.checked }), 'Zapisano rozliczalność pomiaru.')} /> Ten pomiar jest rozliczalny</label></div>}
          </details>
          </div>
        </div>
      </section>
      <SleepPendingList sleep={sleep} />
      {describe && <section ref={descriptionRef} className="card history" aria-label="Edycja opisu"><form onSubmit={e => { e.preventDefault(); void execute(async () => { await invoke('set_entry_description', { entryId: Number(describe.id), expected: describe.expected, description: describe.value }); const id = describe.id; setDescribe(null); if (revisions && same(revisions.entryId, id)) await showRevisions(id); }, 'Opis został zapisany.'); }}><h2>Opis wpisu #{describe.id}</h2><label>Opis (opcjonalnie)<textarea value={describe.value} maxLength={2000} rows={3} onChange={e => setDescribe({ ...describe, value: e.target.value })} /></label><div className="actions"><button className="secondary" type="submit" disabled={busy || !loaded}>Zapisz opis</button><button className="secondary" type="button" disabled={busy} onClick={() => setDescribe(null)}>Anuluj</button></div></form></section>}
      <Report clients={data.clients} projects={data.projects} tasks={data.tasks} loaded={loaded} revision={reportRevision} summary={allClients} hasUnsavedEdit={hasUnsavedReportEdit}
        onEditEntry={entryId => entryEditor.current?.openEntry(entryId, 'start')}
        onShowHistory={entryId => { void showRevisions(entryId, true); }} />
      <section className="card history"><div className="section-top"><div><p className="section-kicker">TWOJA AKTYWNOŚĆ</p><h2>Historia pomiarów</h2></div>{loaded && <span className="count">{entries.length === 500 ? 'Ostatnie 500 wpisów' : `${entries.length} wpisów`}</span>}</div>
        <p className="muted">Pomiary zapisane przed dodaniem rozliczalności mają domyślnie status nierozliczalny. Możesz go zmienić dla każdego wpisu.</p>
        <details><summary>Dodaj czas ręcznie</summary><p className="muted">Wybierz klienta i projekt powyżej; zadanie jest opcjonalne. Podaj czas rozpoczęcia i zakończenia w strefie czasowej komputera.</p>
          <form onSubmit={e => { e.preventDefault(); const start = parseLocalDate(manualStart); const end = parseLocalDate(manualEnd); if (!start || !end) { setError('Sprawdź daty i godziny. Godzina nie może być nieistniejąca ani występować dwukrotnie przy zmianie czasu.'); return; } void execute(async () => { await invoke('create_project_manual_entry', { projectId: Number(projectId), taskId: taskId ? Number(taskId) : null, startedAt: start.toISOString(), endedAt: end.toISOString(), description: manualDescription }); setManualStart(''); setManualEnd(''); setManualDescription(''); }, 'Wpis czasu został dodany.'); }}>
            <div className="selectors"><label>Rozpoczęcie<input type="datetime-local" step="1" required value={manualStart} onChange={e => setManualStart(e.target.value)} /></label><label>Zakończenie<input type="datetime-local" step="1" required value={manualEnd} onChange={e => setManualEnd(e.target.value)} /></label></div>
            <label>Opis (opcjonalnie)<input value={manualDescription} maxLength={2000} onChange={e => setManualDescription(e.target.value)} /></label>
            <button className="secondary" type="submit" disabled={busy || !loaded || !projectId || !!selectedClient?.archived || !!selectedProject?.archived || !!selectedTask?.archived || !manualStart || !manualEnd}>Dodaj wpis</button>
          </form>
        </details>
        <EntryDraftEditor ref={entryEditor} clients={data.clients} projects={data.projects} tasks={data.tasks}
          enabled={loaded && !busy} onCommitted={async entryId => {
            setNotice('Zmiany wpisu zostały zapisane.');
            setReportRevision(version => version + 1);
            try {
              await refresh();
              if (revisions && same(revisions.entryId, entryId)) await showRevisions(entryId);
            } catch { setError('Zmiany zostały zapisane. Odśwież historię, aby je zobaczyć.'); }
          }} />
        {deleting && <div className="alert error" role="alert"><strong>Usunąć wpis #{deleting.id}?</strong> {formatPreciseDate(deleting.started_at)} – {deleting.ended_at && formatPreciseDate(deleting.ended_at)}. Nie będzie uwzględniany w zestawieniach; informacja o usunięciu pozostanie w historii. <button type="button" className="danger" disabled={busy || !loaded} onClick={() => void execute(async () => { await invoke('delete_time_entry', { entryId: Number(deleting.id), expectedStart: deleting.started_at, expectedEnd: deleting.ended_at }); setDeleting(null); if (deleted) await loadDeleted(); }, 'Wpis został usunięty z zestawień.')}>Potwierdź usunięcie</button>{' '}<button type="button" disabled={busy} onClick={() => setDeleting(null)}>Anuluj</button></div>}
        {!loaded ? <p className="muted">Historia jest niedostępna do czasu ponownego odczytu danych.</p> : entries.length === 0 ? <div className="empty"><div className="empty-icon">◷</div><strong>Tu pojawi się Twoja historia</strong><p>Rozpocznij pierwszy pomiar, aby zobaczyć zapisane wpisy.</p></div> : historyGroups && historyGroups.length > 0
          ? <><p className="helper history-zone">Dni w strefie raportu ({allClients.read?.data.time_zone}). Suma dnia jak w raporcie: wszyscy klienci, z aktywnym pomiarem; wpis przez północ jest w obu dniach.</p><div className="table-wrap history-table"><table><thead><tr><th scope="col">Zadanie</th><th scope="col">Klient / projekt</th><th scope="col">Kiedy</th><th scope="col">Czas</th><th scope="col">Operacje</th></tr></thead>
            {historyGroups.map(day => <tbody key={day.date} aria-label={`${day.label}: ${formatDuration(day.seconds)}`}><tr className="history-day"><th scope="rowgroup" colSpan={5}><span>{day.label}</span><span className="history-day-total">{formatDuration(day.seconds)}</span></th></tr>{day.rows.map(row => historyEntryRow(row.entry, row))}</tbody>)}</table></div></>
          : <div className="table-wrap history-table"><table><thead><tr><th scope="col">Zadanie</th><th scope="col">Klient / projekt</th><th scope="col">Kiedy</th><th scope="col">Czas</th><th scope="col">Operacje</th></tr></thead><tbody>{entries.map(e => historyEntryRow(e))}</tbody></table></div>}
        <details onToggle={e => { if (e.currentTarget.open) void loadDeleted(); }}><summary>Usunięte wpisy</summary><p className="muted">Te wpisy nie są uwzględniane w aktywnej historii. Zachowano je wraz z historią zmian.</p><button type="button" className="secondary" onClick={() => void loadDeleted()}>Odśwież listę</button>{deleted === null ? <p className="muted">Odczytywanie lub brak dostępu do listy.</p> : deleted.length === 0 ? <p className="muted">Brak usuniętych wpisów.</p> : <ul>{deleted.map(entry => <li key={entry.id}><strong>{entry.task_id === null ? 'Bez zadania' : data.tasks.find(task => same(task.id, entry.task_id))?.name || 'Nieznane zadanie'}</strong> · {formatPreciseDate(entry.started_at)} – {formatPreciseDate(entry.ended_at)} · {formatDuration(entry.duration_seconds)} · usunięto {formatPreciseDate(entry.deleted_at)}{' '}<button type="button" className="secondary" onClick={() => void showRevisions(entry.id)}>Historia zmian</button></li>)}</ul>}{deleted?.length === 500 && <p className="muted">Wyświetlono ostatnie 500 usuniętych wpisów.</p>}</details>
        {revisions && <section ref={revisionSection} aria-label="Historia korekt"><div className="section-top"><h3>Historia zmian wpisu #{revisions.entryId}</h3><button className="secondary" type="button" onClick={() => { revisionsRequest.current++; setRevisions(null); }}>Zamknij</button></div>{revisions.origin && <p>Wpis powstał z odzyskanego szkicu wpisu #{revisions.origin.sourceEntryId} · {formatPreciseDate(revisions.origin.createdAt)}</p>}{!revisions.origin && revisions.items.length === 0 && revisions.billing.length === 0 && revisions.descriptions.length === 0 && <p className="muted">Ten wpis nie ma zapisanych zmian.</p>}{revisions.items.length > 0 && <ul>{revisions.items.map(revision => <li key={revision.id}><strong>{formatPreciseDate(revision.changed_at)}</strong>: {formatPreciseDate(revision.before_start)} – {formatPreciseDate(revision.before_end)} ({formatDuration(revision.before_seconds)}) → {formatPreciseDate(revision.after_start)} – {formatPreciseDate(revision.after_end)} ({formatDuration(revision.after_seconds)})</li>)}</ul>}{revisions.billing.length > 0 && <ul>{revisions.billing.map(revision => <li key={revision.id}><strong>{formatPreciseDate(revision.changed_at)}</strong>: {revision.before_billable ? 'Rozliczalny' : 'Nierozliczalny'} → {revision.after_billable ? 'Rozliczalny' : 'Nierozliczalny'}</li>)}</ul>}{revisions.descriptions.length > 0 && <ul>{revisions.descriptions.map(revision => <li key={revision.id}><strong>{formatPreciseDate(revision.changed_at)}</strong>: {revision.before_description || 'Bez opisu'} → {revision.after_description || 'Bez opisu'}</li>)}</ul>}</section>}
      </section>
      <details className="admin-panel" id="dane-i-ustawienia" open={settingsOpen || needsStructure} onToggle={e => { const open = e.currentTarget.open; if (!needsStructure) setSettingsOpen(open); }}>
        <summary><span><strong>Dane i ustawienia</strong><small>Klienci i projekty, skrót klawiaturowy, kopia zapasowa i diagnostyka</small></span></summary>
        <div className="admin-grid">
        <aside className="card setup"><div className="section-top"><div><p className="section-kicker">UPORZĄDKUJ PRACĘ</p><h2>Twoja struktura</h2></div><span className="outline-icon">＋</span></div><p className="muted">Dodaj klienta i projekt. Zadania możesz utworzyć później.</p>
          {(['client', 'project', 'task'] as const).map((kind, index) => { const namesPL = { client: 'Klient', project: 'Projekt', task: 'Zadanie' }; const disabled = busy || !loaded || (kind === 'project' && (!clientId || selectedClient?.archived)) || (kind === 'task' && (!projectId || selectedProject?.archived || selectedClient?.archived)); return <form key={kind} className="create-form" onSubmit={create(kind)}><div className="form-label"><span className="step">0{index + 1}</span><label htmlFor={`new-${kind}`}>{namesPL[kind]}</label></div><div className="input-row"><input id={`new-${kind}`} value={names[kind]} disabled={disabled} onChange={e => setNames(old => ({ ...old, [kind]: e.target.value }))} placeholder={`Nazwa: ${namesPL[kind].toLowerCase()}`} maxLength={200} /><button disabled={disabled || !names[kind].trim()} aria-label={`Dodaj ${namesPL[kind].toLowerCase()}`}>＋</button></div>{kind === 'project' && !clientId && <small>Najpierw wybierz klienta</small>}{kind === 'task' && !projectId && <small>Najpierw wybierz projekt</small>}</form>; })}
          <details><summary>Zmień nazwę</summary><p className="muted">Wybierz klienta, projekt lub zadanie w timerze, a następnie popraw jego nazwę. Historia pomiarów zostanie zachowana.</p><div className="actions">{([{ kind: 'client', item: selectedClient, label: 'Klient' }, { kind: 'project', item: selectedProject, label: 'Projekt' }, { kind: 'task', item: selectedTask, label: 'Zadanie' }] as const).map(({ kind, item, label }) => <button type="button" className="secondary" key={kind} disabled={busy || !loaded || !item} onClick={() => item && setRename({ kind, id: item.id, expected: item.name, name: item.name })}>{label}</button>)}</div>
            {rename && <form className="create-form" onSubmit={e => { e.preventDefault(); void execute(async () => { await invoke('rename_item', { kind: rename.kind, id: Number(rename.id), expectedName: rename.expected, name: rename.name }); setRename(null); }, 'Nazwa została zmieniona.'); }}><label htmlFor="rename-item">Nowa nazwa dla: {rename.expected}</label><input id="rename-item" value={rename.name} maxLength={200} onChange={e => setRename({ ...rename, name: e.target.value })} /><div className="actions"><button className="secondary" type="submit" disabled={busy || !loaded || !rename.name.trim()}>Zapisz nazwę</button><button className="secondary" type="button" disabled={busy} onClick={() => setRename(null)}>Anuluj</button></div></form>}
          </details>
        </aside>
      <ShortcutSettings onChange={setShortcut} />
      <section className="card" aria-label="Bezpieczeństwo danych"><div className="section-top"><div><p className="section-kicker">TWOJE DANE</p><h2>Kopia zapasowa</h2></div></div><p className="muted">Utwórz lokalną kopię bazy danych, również podczas trwającego pomiaru.</p><div className="actions"><button className="secondary" type="button" disabled={!loaded || busy} onClick={() => void execute(async () => { setLastBackup(await invoke<string>('create_backup')); }, 'Kopia została utworzona i sprawdzona.')}>Utwórz kopię</button><button className="secondary" type="button" disabled={!loaded || busy} onClick={() => void execute(async () => { setDatabaseHealth(await invoke<DatabaseHealth>('diagnose_database')); }, 'Sprawdzono bazę danych.')}>Sprawdź bazę</button></div>{lastBackup && <p role="status">Kopia została zapisana: <code>{lastBackup}</code>. Zawiera dane klientów i nie jest szyfrowana.</p>}{databaseHealth && <p role="status">Baza poprawna · Klienci: {databaseHealth.clients} · Projekty: {databaseHealth.projects} · Zadania: {databaseHealth.tasks} · Zakończone wpisy: {databaseHealth.completed_entries} · Otwarte pomiary: {databaseHealth.open_entries}</p>}
        <details><summary>Przywróć kopię</summary><p className="muted">Podaj pełną ścieżkę do pliku kopii. Przed przywróceniem aplikacja sprawdzi plik i utworzy kopię obecnych danych. Zakończ aktywny pomiar.</p><label>Ścieżka do kopii <input type="text" value={restorePath} disabled={busy || !!restorePreview} onChange={e => setRestorePath(e.target.value)} placeholder="C:\\...\\kopia.sqlite3" /></label>{' '}{!restorePreview && <button className="secondary" type="button" disabled={busy || !restorePath.trim()} onClick={() => void prepareRestore()}>Sprawdź kopię</button>}
          {restorePreview && <div><p role="status">Kopia zawiera: klientów {restorePreview.health.clients}, projektów {restorePreview.health.projects}, zadań {restorePreview.health.tasks}, zakończonych wpisów {restorePreview.health.completed_entries}, otwartych pomiarów {restorePreview.health.open_entries}.</p><p>Uwaga: przywrócenie zastąpi CAŁĄ obecną bazę danych tego komputera. Wpisy, klienci i projekty z obu komputerów NIE ZOSTANĄ SCALONE. Przed zastąpieniem powstanie lokalna kopia bezpieczeństwa dotychczasowych danych; po przywróceniu konieczny będzie restart aplikacji.</p>{restorePreview.health.open_entries > 0 && <p>Otwarty pomiar z kopii będzie wymagał weryfikacji po ponownym uruchomieniu.</p>}<label><input type="checkbox" checked={restoreConfirmed} onChange={e => setRestoreConfirmed(e.target.checked)} /> Rozumiem, że dane tego komputera zostaną zastąpione, a historie obu komputerów nie będą łączone.</label><div className="actions"><button className="danger" type="button" disabled={busy || !loaded || !!data.active || !restoreConfirmed} onClick={() => void applyRestore()}>Przywróć kopię</button><button className="secondary" type="button" disabled={busy} onClick={() => void cancelRestore()}>Anuluj</button></div>{data.active && <p className="muted">Zakończ lub rozlicz aktywny pomiar przed przywróceniem.</p>}</div>}
        </details>
      </section>
        </div>
      </details>
      </div>
      {view === 'calendar' && <CalendarShell report={allClients} catalog={catalog} loaded={loaded} now={now} snapshotFresh={now - snapshotAt <= 5000}
        snapshotActive={data.active ? { id: data.active.id, project_id: data.active.project_id, task_id: data.active.task_id, started_at: data.active.started_at, description: data.active.description, billable: data.active.billable, recovered: data.active.recovered, uncertain: data.active.uncertain } : null}
        editable={loaded && !busy} onEntrySaved={async () => { setReportRevision(version => version + 1); await refresh(); }} />}
      <footer>Wersja rozwojowa · Dane przechowywane lokalnie</footer>
    </main>
  </div>;
}
