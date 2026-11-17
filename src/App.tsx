import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Report from './Report';

type Id = number | string;
type Client = { id: Id; name: string; archived: boolean };
type Project = { id: Id; client_id: Id; name: string; archived: boolean; billable: boolean };
type Task = { id: Id; project_id: Id; name: string; archived: boolean };
type Entry = { id: Id; task_id: Id; started_at: string; ended_at: string | null; duration_seconds?: number | null; recovered?: boolean; manually_resolved?: boolean; billable: boolean; description: string };
type DeletedEntry = { id: Id; task_id: Id; started_at: string; ended_at: string; duration_seconds: number; deleted_at: string };
type Revision = { id: Id; changed_at: string; before_start: string; before_end: string; before_seconds: number; after_start: string; after_end: string; after_seconds: number };
type BillingRevision = { id: Id; changed_at: string; before_billable: boolean; after_billable: boolean };
type DescriptionRevision = { id: Id; changed_at: string; before_description: string; after_description: string };
type DatabaseHealth = { schema_version: number; clients: number; projects: number; tasks: number; completed_entries: number; open_entries: number };
type RestorePreview = { token: string; health: DatabaseHealth };
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
const localInputValue = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
const formatPreciseDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'medium' });
};
const parseLocalDate = (value: string) => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts) return null;
  const date = new Date(value);
  const expected = parts.slice(1).map(part => Number(part || 0));
  const actual = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
  if (Number.isNaN(date.getTime()) || actual.some((part, index) => part !== expected[index])) return null;
  // A repeated local time at the end of daylight saving does not identify one instant.
  for (let minutes = -180; minutes <= 180; minutes++) {
    if (minutes === 0) continue;
    const other = new Date(date.getTime() + minutes * 60_000);
    const components = [other.getFullYear(), other.getMonth() + 1, other.getDate(), other.getHours(), other.getMinutes(), other.getSeconds()];
    if (components.every((part, index) => part === expected[index])) return null;
  }
  return date;
};

export default function App() {
  const [data, setData] = useState<Snapshot>(EMPTY);
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
  const [editing, setEditing] = useState<{ id: Id; expectedStart: string; expectedEnd: string; start: string; end: string } | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [deleted, setDeleted] = useState<DeletedEntry[] | null>(null);
  const [lastBackup, setLastBackup] = useState('');
  const [databaseHealth, setDatabaseHealth] = useState<DatabaseHealth | null>(null);
  const [restorePath, setRestorePath] = useState('');
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreDone, setRestoreDone] = useState('');
  const [revisions, setRevisions] = useState<{ entryId: Id; items: Revision[]; billing: BillingRevision[]; descriptions: DescriptionRevision[] } | null>(null);
  const revisionsRequest = useRef(0);
  const historyRef = useRef<HTMLElement>(null);
  const descriptionRef = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (describe) descriptionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [describe?.id]);
  const refresh = useCallback(async () => {
    try {
      const next = await invoke<Snapshot>('get_snapshot');
      setData(next);
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
  const selectedTask = data.tasks.find(t => same(t.id, taskId));
  const tasks = data.tasks.filter(t => same(t.project_id, projectId) && (showArchived || !t.archived));
  const activeTask = data.tasks.find(t => same(t.id, data.active?.task_id));
  const activeProject = data.projects.find(p => same(p.id, activeTask?.project_id));
  const activeClient = data.clients.find(c => same(c.id, activeProject?.client_id));
  const elapsed = data.active ? Math.max(0, (now - new Date(data.active.started_at).getTime()) / 1000) : 0;
  const displayElapsed = Number.isFinite(elapsed) ? elapsed : 0;
  const entries = useMemo(() => [...data.entries].sort((a, b) => b.started_at.localeCompare(a.started_at)), [data.entries]);

  async function execute(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      try { await action(); }
      catch (e) {
        setError(`Nie udało się potwierdzić operacji: ${String(e)}. Sprawdź aktualny stan przed ponowieniem.`);
        try { await refresh(); } catch { /* Odczyt można ponowić osobno. */ }
        return;
      }
      try { await refresh(); setNotice(message); }
      catch (e) { setError(`${message} Nie udało się odświeżyć danych: ${String(e)}. Ponów odczyt, nie operację.`); }
    } finally { setBusy(false); }
  }
  async function retryRefresh() {
    setBusy(true); setError(''); setNotice('');
    try { await refresh(); setNotice('Dane zostały odświeżone.'); }
    catch (e) { setError(`Nie udało się odczytać danych: ${String(e)}`); }
    finally { setBusy(false); }
  }
  async function showRevisions(entryId: Id) {
    const request = ++revisionsRequest.current;
    try {
      const [items, billing, descriptions] = await Promise.all([invoke<Revision[]>('entry_revisions', { entryId: Number(entryId) }), invoke<BillingRevision[]>('billing_revisions', { entryId: Number(entryId) }), invoke<DescriptionRevision[]>('description_revisions', { entryId: Number(entryId) })]);
      if (request === revisionsRequest.current) setRevisions({ entryId, items, billing, descriptions });
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
    setBusy(true); setError(''); setNotice('');
    try {
      const safetyPath = await invoke<string>('apply_backup_restore', { token: restorePreview.token, confirmed: true });
      setRestoreDone(safetyPath); setRestorePreview(null); setRestoreConfirmed(false);
    } catch (e) { setRestorePreview(null); setRestoreConfirmed(false); setError(`${String(e)} Sprawdź kopię ponownie przed kolejną próbą.`); }
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

  if (restoreDone) return <div className="app-shell"><main><section className="card"><h1>Kopia została przywrócona</h1><p>Ze względów bezpieczeństwa zamknij aplikację i uruchom ją ponownie. Jeśli kopia zawierała otwarty pomiar, po uruchomieniu będzie on wymagał weryfikacji.</p><p>Kopia danych sprzed przywrócenia: <code>{restoreDone}</code>. Nie jest szyfrowana.</p>{error && <div role="alert" className="alert error">{error}</div>}<button className="primary" onClick={() => invoke('exit_after_restore').catch(e => setError(`Nie udało się zamknąć aplikacji: ${String(e)}`))}>Zamknij aplikację</button></section></main></div>;

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">T</span><div><strong>TrackerMaster</strong><small>Twój czas, pod kontrolą</small></div></div><div className="topbar-actions"><button className="widget-open" onClick={() => invoke('open_widget').catch(e => setError(`Nie udało się otworzyć widgetu: ${String(e)}`))}>Otwórz widget</button><span className="local-pill"><span /> Lokalnie na tym komputerze</span></div></header>
    <main>
      <div className="heading"><div><p className="eyebrow">TWÓJ DZIEŃ PRACY</p><h1>Rejestracja czasu</h1><p className="subtitle">Wybierz zadanie i skup się na pracy. Resztą zajmie się licznik.</p></div><div className="date">{new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</div></div>
      {error && <div role="alert" className="alert error">{error}</div>}
      {!loaded && <div role="status" className="alert error">Dane nie są aktualne. Odczytaj je ponownie przed wykonaniem kolejnej operacji. <button type="button" disabled={busy} onClick={retryRefresh}>Ponów odczyt</button></div>}
      {loaded && data.active?.recovered && <div role="alert" className="alert error"><strong>Pomiar wymaga weryfikacji.</strong> Rozpoczęto: {formatDate(data.active.started_at)}. Podaj faktyczny czas zakończenia. Cały okres między początkiem a wskazanym końcem zostanie zaliczony jako praca, także ewentualne przerwy.
        <form onSubmit={e => { e.preventDefault(); const end = new Date(recoveryEnd); if (!recoveryEnd || Number.isNaN(end.getTime())) { setError('Podaj poprawną datę zakończenia.'); return; } execute(() => invoke('recover_timer', { endedAt: end.toISOString(), expectedActiveId: Number(data.active!.id) }), 'Przerwany pomiar zapisano z ręcznie wskazanym zakończeniem.'); }}>
          <label>Data i godzina zakończenia <input type="datetime-local" step="1" required value={recoveryEnd} onChange={e => setRecoveryEnd(e.target.value)} /></label>{' '}
          <button type="submit" disabled={busy || !loaded || !recoveryEnd}>Zapisz zakończenie</button>
        </form></div>}
      {notice && <div role="status" className="alert success">{notice}</div>}
      <div className="grid">
        <section className="timer card" aria-label="Pomiar czasu">
          <div className="section-top"><div><p className="section-kicker">AKTUALNY POMIAR</p><h2>Timer</h2></div><span className={`status ${loaded && data.active && !data.active.recovered ? 'running' : ''}`}><span />{!loaded ? 'Brak danych' : data.active?.recovered ? 'Do weryfikacji' : data.active ? 'W trakcie' : 'Zatrzymany'}</span></div>
          <div className="clock" aria-live="off">{!loaded || data.active?.recovered ? '—:—:—' : formatDuration(displayElapsed)}</div><p className="clock-caption">{!loaded ? 'Nie można ustalić stanu pomiaru' : data.active?.recovered ? 'Pomiar wymaga weryfikacji' : data.active ? 'Czas na ekranie jest orientacyjny' : 'Wybierz zadanie, aby rozpocząć'}</p>
          {loaded && data.active && <div className="active-info"><span>AKTYWNE ZADANIE</span><strong>{activeTask?.name || 'Nieznane zadanie'}</strong><small>{activeClient?.name || '—'} / {activeProject?.name || '—'}</small><small>{data.active.description || 'Bez opisu'}</small><button className="secondary" type="button" disabled={busy} onClick={() => setDescribe({ id: data.active!.id, expected: data.active!.description, value: data.active!.description })}>Zmień opis</button></div>}
          <div className="selectors">
            <label>Klient<select value={clientId} disabled={busy || !loaded} onChange={e => { setClientId(e.target.value); setProjectId(''); setTaskId(''); }}><option value="">Wybierz klienta</option>{data.clients.filter(c => showArchived || !c.archived).map(c => <option key={c.id} value={c.id}>{c.name}{c.archived ? ' (archiwum)' : ''}</option>)}</select></label>
            <label>Projekt<select value={projectId} disabled={busy || !loaded || !clientId} onChange={e => { setProjectId(e.target.value); setTaskId(''); }}><option value="">Wybierz projekt</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? ' (archiwum)' : ''}</option>)}</select></label>
            <label>Zadanie<select value={taskId} disabled={busy || !loaded || !projectId} onChange={e => setTaskId(e.target.value)}><option value="">Wybierz zadanie</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.name}{t.archived ? ' (archiwum)' : ''}</option>)}</select></label>
          </div>
          <div className="archive-controls"><label><input type="checkbox" checked={showArchived} onChange={e => { setShowArchived(e.target.checked); if (!e.target.checked && selectedClient?.archived) { setClientId(''); setProjectId(''); setTaskId(''); } else if (!e.target.checked && selectedProject?.archived) { setProjectId(''); setTaskId(''); } else if (!e.target.checked && selectedTask?.archived) setTaskId(''); }} /> Pokaż archiwum klientów, projektów i zadań</label>
          {selectedClient && <button className="secondary" disabled={busy || !loaded} onClick={() => execute(async () => { await invoke('archive_client', { clientId: Number(clientId), archived: !selectedClient.archived }); if (!selectedClient.archived && !showArchived) { setClientId(''); setProjectId(''); setTaskId(''); } }, selectedClient.archived ? 'Klient przywrócony. Projekty pozostają w archiwum.' : 'Klient przeniesiony do archiwum; historia pozostaje dostępna.')}>{selectedClient.archived ? 'Przywróć klienta' : 'Archiwizuj klienta'}</button>}
          {selectedProject && <button className="secondary" disabled={busy || !loaded} onClick={() => execute(async () => { await invoke('archive_project', { projectId: Number(projectId), archived: !selectedProject.archived }); if (!selectedProject.archived && !showArchived) { setProjectId(''); setTaskId(''); } }, selectedProject.archived ? 'Projekt przywrócony.' : 'Projekt przeniesiony do archiwum; historia pozostaje dostępna.')}>{selectedProject.archived ? 'Przywróć projekt' : 'Archiwizuj projekt'}</button>}
          {selectedTask && <button className="secondary" disabled={busy || !loaded} onClick={() => execute(async () => { await invoke('archive_task', { taskId: Number(taskId), archived: !selectedTask.archived }); if (!selectedTask.archived && !showArchived) setTaskId(''); }, selectedTask.archived ? 'Zadanie przywrócone.' : 'Zadanie przeniesione do archiwum; historia pozostaje dostępna.')}>{selectedTask.archived ? 'Przywróć zadanie' : 'Archiwizuj zadanie'}</button>}</div>
          {selectedProject && <div className="archive-controls"><label><input type="checkbox" checked={selectedProject.billable} disabled={busy || !loaded} onChange={e => void execute(() => invoke('set_project_billable', { projectId: Number(selectedProject.id), expected: selectedProject.billable, billable: e.target.checked }), 'Zapisano domyślną rozliczalność projektu.')} /> Nowe pomiary projektu są domyślnie rozliczalne</label></div>}
          {selectedProject && <p className="helper">Zmiana ustawienia projektu nie zmienia wcześniejszych ani trwających pomiarów.</p>}
          {loaded && data.active && <div className="archive-controls"><label><input type="checkbox" checked={data.active.billable} disabled={busy} onChange={e => void execute(() => invoke('set_entry_billable', { entryId: Number(data.active!.id), expected: data.active!.billable, billable: e.target.checked }), 'Zapisano rozliczalność pomiaru.')} /> Ten pomiar jest rozliczalny</label></div>}
          <label>Opis nowego pomiaru (opcjonalnie)<input value={timerDescription} maxLength={2000} disabled={busy || !loaded} onChange={e => setTimerDescription(e.target.value)} placeholder="Nad czym pracujesz?" /></label>
          <div className="actions"><button className="primary" disabled={busy || !taskId || !loaded || selectedClient?.archived || selectedProject?.archived || selectedTask?.archived || data.active?.recovered || same(data.active?.task_id, taskId)} onClick={() => execute(async () => { await invoke('start_timer', { taskId: Number(taskId), expectedActiveId: data.active ? Number(data.active.id) : null, description: timerDescription }); setTimerDescription(''); }, data.active ? 'Przełączono zadanie.' : 'Pomiar uruchomiony.')}><span aria-hidden="true">▶</span> {data.active ? 'Przełącz zadanie' : 'Rozpocznij pomiar'}</button><button className="secondary" disabled={busy || !loaded || !data.active || data.active.recovered} onClick={() => execute(() => invoke('stop_timer', { expectedActiveId: Number(data.active!.id) }), 'Pomiar zatrzymany.')}><span aria-hidden="true">■</span> Zatrzymaj</button></div>
          <p className="helper">Pomiar działa dla jednego zadania jednocześnie.</p>
        </section>
        <aside className="card setup"><div className="section-top"><div><p className="section-kicker">UPORZĄDKUJ PRACĘ</p><h2>Twoja struktura</h2></div><span className="outline-icon">＋</span></div><p className="muted">Dodaj klienta, a następnie utwórz projekt i zadanie.</p>
          {(['client', 'project', 'task'] as const).map((kind, index) => { const namesPL = { client: 'Klient', project: 'Projekt', task: 'Zadanie' }; const disabled = busy || !loaded || (kind === 'project' && (!clientId || selectedClient?.archived)) || (kind === 'task' && (!projectId || selectedProject?.archived || selectedClient?.archived)); return <form key={kind} className="create-form" onSubmit={create(kind)}><div className="form-label"><span className="step">0{index + 1}</span><label htmlFor={`new-${kind}`}>{namesPL[kind]}</label></div><div className="input-row"><input id={`new-${kind}`} value={names[kind]} disabled={disabled} onChange={e => setNames(old => ({ ...old, [kind]: e.target.value }))} placeholder={`Nazwa: ${namesPL[kind].toLowerCase()}`} maxLength={200} /><button disabled={disabled || !names[kind].trim()} aria-label={`Dodaj ${namesPL[kind].toLowerCase()}`}>＋</button></div>{kind === 'project' && !clientId && <small>Najpierw wybierz klienta</small>}{kind === 'task' && !projectId && <small>Najpierw wybierz projekt</small>}</form>; })}
          <details><summary>Zmień nazwę</summary><p className="muted">Wybierz klienta, projekt lub zadanie w timerze, a następnie popraw jego nazwę. Historia pomiarów zostanie zachowana.</p><div className="actions">{([{ kind: 'client', item: selectedClient, label: 'Klient' }, { kind: 'project', item: selectedProject, label: 'Projekt' }, { kind: 'task', item: selectedTask, label: 'Zadanie' }] as const).map(({ kind, item, label }) => <button type="button" className="secondary" key={kind} disabled={busy || !loaded || !item} onClick={() => item && setRename({ kind, id: item.id, expected: item.name, name: item.name })}>{label}</button>)}</div>
            {rename && <form className="create-form" onSubmit={e => { e.preventDefault(); void execute(async () => { await invoke('rename_item', { kind: rename.kind, id: Number(rename.id), expectedName: rename.expected, name: rename.name }); setRename(null); }, 'Nazwa została zmieniona.'); }}><label htmlFor="rename-item">Nowa nazwa dla: {rename.expected}</label><input id="rename-item" value={rename.name} maxLength={200} onChange={e => setRename({ ...rename, name: e.target.value })} /><div className="actions"><button className="secondary" type="submit" disabled={busy || !loaded || !rename.name.trim()}>Zapisz nazwę</button><button className="secondary" type="button" disabled={busy} onClick={() => setRename(null)}>Anuluj</button></div></form>}
          </details>
        </aside>
      </div>
      {describe && <section ref={descriptionRef} className="card history" aria-label="Edycja opisu"><form onSubmit={e => { e.preventDefault(); void execute(async () => { await invoke('set_entry_description', { entryId: Number(describe.id), expected: describe.expected, description: describe.value }); const id = describe.id; setDescribe(null); if (revisions && same(revisions.entryId, id)) await showRevisions(id); }, 'Opis został zapisany.'); }}><h2>Opis wpisu #{describe.id}</h2><label>Opis (opcjonalnie)<textarea value={describe.value} maxLength={2000} rows={3} onChange={e => setDescribe({ ...describe, value: e.target.value })} /></label><div className="actions"><button className="secondary" type="submit" disabled={busy || !loaded}>Zapisz opis</button><button className="secondary" type="button" disabled={busy} onClick={() => setDescribe(null)}>Anuluj</button></div></form></section>}
      <Report clients={data.clients} projects={data.projects} tasks={data.tasks} loaded={loaded} onEditEntry={entry => { setEditing({ id: entry.id, expectedStart: entry.started_at, expectedEnd: entry.ended_at, start: localInputValue(entry.started_at), end: localInputValue(entry.ended_at) }); historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />
      <section ref={historyRef} className="card history"><div className="section-top"><div><p className="section-kicker">TWOJA AKTYWNOŚĆ</p><h2>Historia pomiarów</h2></div>{loaded && <span className="count">{entries.length === 500 ? 'Ostatnie 500 wpisów' : `${entries.length} wpisów`}</span>}</div>
        <p className="muted">Pomiary zapisane przed dodaniem rozliczalności mają domyślnie status nierozliczalny. Możesz go zmienić dla każdego wpisu.</p>
        <details><summary>Dodaj czas ręcznie</summary><p className="muted">Wybierz klienta, projekt i zadanie powyżej, a następnie podaj czas rozpoczęcia i zakończenia w strefie czasowej komputera.</p>
          <form onSubmit={e => { e.preventDefault(); const start = parseLocalDate(manualStart); const end = parseLocalDate(manualEnd); if (!start || !end) { setError('Sprawdź daty i godziny. Godzina nie może być nieistniejąca ani występować dwukrotnie przy zmianie czasu.'); return; } void execute(async () => { await invoke('create_manual_entry', { taskId: Number(taskId), startedAt: start.toISOString(), endedAt: end.toISOString(), description: manualDescription }); setManualStart(''); setManualEnd(''); setManualDescription(''); }, 'Wpis czasu został dodany.'); }}>
            <div className="selectors"><label>Rozpoczęcie<input type="datetime-local" step="1" required value={manualStart} onChange={e => setManualStart(e.target.value)} /></label><label>Zakończenie<input type="datetime-local" step="1" required value={manualEnd} onChange={e => setManualEnd(e.target.value)} /></label></div>
            <label>Opis (opcjonalnie)<input value={manualDescription} maxLength={2000} onChange={e => setManualDescription(e.target.value)} /></label>
            <button className="secondary" type="submit" disabled={busy || !loaded || !taskId || !!selectedClient?.archived || !!selectedProject?.archived || !!selectedTask?.archived || !manualStart || !manualEnd}>Dodaj wpis</button>
          </form>
        </details>
        {editing && <form aria-label="Korekta wpisu" onSubmit={e => { e.preventDefault(); const start = parseLocalDate(editing.start); const end = parseLocalDate(editing.end); if (!start || !end) { setError('Sprawdź daty i godziny. Godzina nie może być nieistniejąca ani występować dwukrotnie przy zmianie czasu.'); return; } void execute(async () => { await invoke('edit_time_entry', { entryId: Number(editing.id), expectedStart: editing.expectedStart, expectedEnd: editing.expectedEnd, startedAt: start.toISOString(), endedAt: end.toISOString() }); setEditing(null); if (revisions && same(revisions.entryId, editing.id)) await showRevisions(editing.id); }, 'Korekta została zapisana.'); }}>
          <h3>Korekta wpisu</h3><p className="muted">Podaj godziny w strefie czasowej komputera. Poprzednie wartości pozostaną w historii zmian.</p>
          <div className="selectors"><label>Rozpoczęcie<input type="datetime-local" step="1" required value={editing.start} onChange={e => setEditing({ ...editing, start: e.target.value })} /></label><label>Zakończenie<input type="datetime-local" step="1" required value={editing.end} onChange={e => setEditing({ ...editing, end: e.target.value })} /></label></div>
          <button className="secondary" type="submit" disabled={busy || !loaded}>Zapisz korektę</button>{' '}<button className="secondary" type="button" onClick={() => setEditing(null)}>Anuluj</button>
        </form>}
        {deleting && <div className="alert error" role="alert"><strong>Usunąć wpis #{deleting.id}?</strong> {formatPreciseDate(deleting.started_at)} – {deleting.ended_at && formatPreciseDate(deleting.ended_at)}. Nie będzie uwzględniany w zestawieniach; informacja o usunięciu pozostanie w historii. <button type="button" disabled={busy || !loaded} onClick={() => void execute(async () => { await invoke('delete_time_entry', { entryId: Number(deleting.id), expectedStart: deleting.started_at, expectedEnd: deleting.ended_at }); setDeleting(null); if (editing && same(editing.id, deleting.id)) setEditing(null); if (deleted) await loadDeleted(); }, 'Wpis został usunięty z zestawień.')}>Potwierdź usunięcie</button>{' '}<button type="button" disabled={busy} onClick={() => setDeleting(null)}>Anuluj</button></div>}
        {!loaded ? <p className="muted">Historia jest niedostępna do czasu ponownego odczytu danych.</p> : entries.length === 0 ? <div className="empty"><div className="empty-icon">◷</div><strong>Tu pojawi się Twoja historia</strong><p>Rozpocznij pierwszy pomiar, aby zobaczyć zapisane wpisy.</p></div> : <div className="table-wrap"><table><thead><tr><th>Zadanie</th><th>Klient / projekt</th><th>Rozpoczęcie</th><th>Zakończenie</th><th>Czas</th><th>Operacje</th></tr></thead><tbody>{entries.map(e => { const t = data.tasks.find(x => same(x.id, e.task_id)); const p = data.projects.find(x => same(x.id, t?.project_id)); const c = data.clients.find(x => same(x.id, p?.client_id)); return <tr key={e.id}><td><strong>{t?.name || 'Nieznane zadanie'}</strong>{e.description && <small className="entry-description">{e.description}</small>}</td><td>{c?.name || '—'} / {p?.name || '—'}</td><td>{formatDate(e.started_at)}</td><td>{formatDate(e.ended_at)}{e.manually_resolved && <small> (wskazane ręcznie)</small>}</td><td className="duration">{e.duration_seconds == null ? 'Do weryfikacji' : formatDuration(e.duration_seconds)}</td><td><button type="button" className="secondary" disabled={busy || !loaded} aria-label={`Zmień opis: ${t?.name || 'zadanie'}`} onClick={() => setDescribe({ id: e.id, expected: e.description, value: e.description })}>Opis</button>{' '}<button type="button" className="secondary" disabled={busy || !loaded} aria-label={`${e.billable ? 'Oznacz jako nierozliczalny' : 'Oznacz jako rozliczalny'}: ${t?.name || 'zadanie'}`} onClick={() => void execute(() => invoke('set_entry_billable', { entryId: Number(e.id), expected: e.billable, billable: !e.billable }), 'Zapisano rozliczalność wpisu.')}>{e.billable ? 'Rozliczalny' : 'Nierozliczalny'}</button>{' '}<button type="button" className="secondary" disabled={busy || !e.ended_at} aria-label={`Popraw wpis: ${t?.name || 'zadanie'}`} onClick={() => e.ended_at && setEditing({ id: e.id, expectedStart: e.started_at, expectedEnd: e.ended_at, start: localInputValue(e.started_at), end: localInputValue(e.ended_at) })}>Popraw</button>{' '}<button type="button" className="secondary" aria-label={`Historia zmian: ${t?.name || 'zadanie'}`} onClick={() => void showRevisions(e.id)}>Historia zmian</button>{' '}<button type="button" className="secondary" disabled={busy || !e.ended_at} aria-label={`Usuń wpis: ${t?.name || 'zadanie'}`} onClick={() => setDeleting(e)}>Usuń</button></td></tr>; })}</tbody></table></div>}
        <details onToggle={e => { if (e.currentTarget.open) void loadDeleted(); }}><summary>Usunięte wpisy</summary><p className="muted">Te wpisy nie są uwzględniane w aktywnej historii. Zachowano je wraz z historią zmian.</p><button type="button" className="secondary" onClick={() => void loadDeleted()}>Odśwież listę</button>{deleted === null ? <p className="muted">Odczytywanie lub brak dostępu do listy.</p> : deleted.length === 0 ? <p className="muted">Brak usuniętych wpisów.</p> : <ul>{deleted.map(entry => <li key={entry.id}><strong>{data.tasks.find(task => same(task.id, entry.task_id))?.name || 'Nieznane zadanie'}</strong> · {formatPreciseDate(entry.started_at)} – {formatPreciseDate(entry.ended_at)} · {formatDuration(entry.duration_seconds)} · usunięto {formatPreciseDate(entry.deleted_at)}{' '}<button type="button" className="secondary" onClick={() => void showRevisions(entry.id)}>Historia zmian</button></li>)}</ul>}{deleted?.length === 500 && <p className="muted">Wyświetlono ostatnie 500 usuniętych wpisów.</p>}</details>
        {revisions && <section aria-label="Historia korekt"><div className="section-top"><h3>Historia zmian wpisu #{revisions.entryId}</h3><button className="secondary" type="button" onClick={() => { revisionsRequest.current++; setRevisions(null); }}>Zamknij</button></div>{revisions.items.length === 0 && revisions.billing.length === 0 && revisions.descriptions.length === 0 && <p className="muted">Ten wpis nie ma zapisanych zmian.</p>}{revisions.items.length > 0 && <ul>{revisions.items.map(revision => <li key={revision.id}><strong>{formatPreciseDate(revision.changed_at)}</strong>: {formatPreciseDate(revision.before_start)} – {formatPreciseDate(revision.before_end)} ({formatDuration(revision.before_seconds)}) → {formatPreciseDate(revision.after_start)} – {formatPreciseDate(revision.after_end)} ({formatDuration(revision.after_seconds)})</li>)}</ul>}{revisions.billing.length > 0 && <ul>{revisions.billing.map(revision => <li key={revision.id}><strong>{formatPreciseDate(revision.changed_at)}</strong>: {revision.before_billable ? 'Rozliczalny' : 'Nierozliczalny'} → {revision.after_billable ? 'Rozliczalny' : 'Nierozliczalny'}</li>)}</ul>}{revisions.descriptions.length > 0 && <ul>{revisions.descriptions.map(revision => <li key={revision.id}><strong>{formatPreciseDate(revision.changed_at)}</strong>: {revision.before_description || 'Bez opisu'} → {revision.after_description || 'Bez opisu'}</li>)}</ul>}</section>}
      </section>
      <section className="card" aria-label="Bezpieczeństwo danych"><div className="section-top"><div><p className="section-kicker">TWOJE DANE</p><h2>Kopia zapasowa</h2></div></div><p className="muted">Utwórz lokalną kopię bazy danych, również podczas trwającego pomiaru.</p><div className="actions"><button className="secondary" type="button" disabled={!loaded || busy} onClick={() => void execute(async () => { setLastBackup(await invoke<string>('create_backup')); }, 'Kopia została utworzona i sprawdzona.')}>Utwórz kopię</button><button className="secondary" type="button" disabled={!loaded || busy} onClick={() => void execute(async () => { setDatabaseHealth(await invoke<DatabaseHealth>('diagnose_database')); }, 'Sprawdzono bazę danych.')}>Sprawdź bazę</button></div>{lastBackup && <p role="status">Kopia została zapisana: <code>{lastBackup}</code>. Zawiera dane klientów i nie jest szyfrowana.</p>}{databaseHealth && <p role="status">Baza poprawna · Klienci: {databaseHealth.clients} · Projekty: {databaseHealth.projects} · Zadania: {databaseHealth.tasks} · Zakończone wpisy: {databaseHealth.completed_entries} · Otwarte pomiary: {databaseHealth.open_entries}</p>}
        <details><summary>Przywróć kopię</summary><p className="muted">Podaj pełną ścieżkę do pliku kopii. Przed przywróceniem aplikacja sprawdzi plik i utworzy kopię obecnych danych. Zakończ aktywny pomiar.</p><label>Ścieżka do kopii <input type="text" value={restorePath} disabled={busy || !!restorePreview} onChange={e => setRestorePath(e.target.value)} placeholder="C:\\...\\kopia.sqlite3" /></label>{' '}{!restorePreview && <button className="secondary" type="button" disabled={busy || !restorePath.trim()} onClick={() => void prepareRestore()}>Sprawdź kopię</button>}
          {restorePreview && <div><p role="status">Kopia zawiera: klientów {restorePreview.health.clients}, projektów {restorePreview.health.projects}, zadań {restorePreview.health.tasks}, zakończonych wpisów {restorePreview.health.completed_entries}, otwartych pomiarów {restorePreview.health.open_entries}.</p><p>Przywrócenie zastąpi obecne dane. Najpierw zostanie utworzona ich lokalna kopia bezpieczeństwa. Po przywróceniu konieczne będzie ponowne uruchomienie aplikacji.</p>{restorePreview.health.open_entries > 0 && <p>Otwarty pomiar z kopii będzie wymagał weryfikacji po ponownym uruchomieniu.</p>}<label><input type="checkbox" checked={restoreConfirmed} onChange={e => setRestoreConfirmed(e.target.checked)} /> Rozumiem, że bieżące dane zostaną zastąpione.</label><div className="actions"><button className="primary" type="button" disabled={busy || !loaded || !!data.active || !restoreConfirmed} onClick={() => void applyRestore()}>Przywróć kopię</button><button className="secondary" type="button" disabled={busy} onClick={() => void cancelRestore()}>Anuluj</button></div>{data.active && <p className="muted">Zakończ lub rozlicz aktywny pomiar przed przywróceniem.</p>}</div>}
        </details>
      </section>
      <footer>Wersja rozwojowa · Dane przechowywane lokalnie</footer>
    </main>
  </div>;
}
