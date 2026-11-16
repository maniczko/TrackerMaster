import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

type Id = number | string;
type DatabaseHealth = { schema_version: number; clients: number; projects: number; tasks: number; completed_entries: number; open_entries: number };
type Client = { id: Id; name: string };
type Project = { id: Id; client_id: Id; name: string; archived: boolean };
type Task = { id: Id; project_id: Id; name: string };
type Entry = { id: Id; task_id: Id; started_at: string; ended_at: string | null; duration_seconds?: number | null; recovered?: boolean; manually_resolved?: boolean };
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

export default function App() {
  const [data, setData] = useState<Snapshot>(EMPTY);
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [names, setNames] = useState({ client: '', project: '', task: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastBackup, setLastBackup] = useState('');
  const [dbHealth, setDbHealth] = useState<DatabaseHealth | null>(null);
  const [recoveryEnd, setRecoveryEnd] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
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
  const tasks = data.tasks.filter(t => same(t.project_id, projectId));
  const activeTask = data.tasks.find(t => same(t.id, data.active?.task_id));
  const activeProject = data.projects.find(p => same(p.id, activeTask?.project_id));
  const activeClient = data.clients.find(c => same(c.id, activeProject?.client_id));
  const elapsed = data.active ? Math.max(0, (now - new Date(data.active.started_at).getTime()) / 1000) : 0;
  const displayElapsed = Number.isFinite(elapsed) ? elapsed : 0;
  const entries = useMemo(() => [...data.entries].sort((a, b) => b.started_at.localeCompare(a.started_at)), [data.entries]);

  async function execute(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice(''); setDbHealth(null);
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

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">T</span><div><strong>TrackerMaster</strong><small>Twój czas, pod kontrolą</small></div></div><div className="topbar-actions"><button className="secondary" type="button" disabled={!loaded || busy} onClick={() => execute(async () => { const result = await invoke<DatabaseHealth>('diagnose_database'); setDbHealth(result); }, 'Kontrola bazy danych zakończona pomyślnie.')}>Sprawdź bazę</button><button className="secondary" type="button" disabled={!loaded || busy} onClick={() => execute(async () => { const path = await invoke<string>('create_backup'); setLastBackup(path); }, 'Utworzono i zweryfikowano kopię bazy.')}>Utwórz kopię bazy</button><button className="widget-open" onClick={() => invoke('open_widget').catch(e => setError(`Nie udało się otworzyć widgetu: ${String(e)}`))}>Otwórz widget</button><span className="local-pill"><span /> Lokalnie na tym komputerze</span></div></header>
    <main>
      <div className="heading"><div><p className="eyebrow">TWÓJ DZIEŃ PRACY</p><h1>Rejestracja czasu</h1><p className="subtitle">Wybierz zadanie i skup się na pracy. Resztą zajmie się licznik.</p></div><div className="date">{new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</div></div>
      {error && <div role="alert" className="alert error">{error}</div>}
      {!loaded && <div role="status" className="alert error">Dane nie są aktualne. Odczytaj je ponownie przed wykonaniem kolejnej operacji. <button type="button" disabled={busy} onClick={retryRefresh}>Ponów odczyt</button></div>}
      {loaded && data.active?.recovered && <div role="alert" className="alert error"><strong>Pomiar wymaga weryfikacji.</strong> Rozpoczęto: {formatDate(data.active.started_at)}. Podaj faktyczny czas zakończenia. Cały okres między początkiem a wskazanym końcem zostanie zaliczony jako praca, także ewentualne przerwy.
        <form onSubmit={e => { e.preventDefault(); const end = new Date(recoveryEnd); if (!recoveryEnd || Number.isNaN(end.getTime())) { setError('Podaj poprawną datę zakończenia.'); return; } execute(() => invoke('recover_timer', { endedAt: end.toISOString() }), 'Przerwany pomiar zapisano z ręcznie wskazanym zakończeniem.'); }}>
          <label>Data i godzina zakończenia <input type="datetime-local" step="1" required value={recoveryEnd} onChange={e => setRecoveryEnd(e.target.value)} /></label>{' '}
          <button type="submit" disabled={busy || !loaded || !recoveryEnd}>Zapisz zakończenie</button>
        </form></div>}
      {notice && <div role="status" className="alert success">{notice}</div>}
      {lastBackup && <div role="status" className="alert success">Lokalna kopia: <code>{lastBackup}</code>. Plik zawiera dane klientów i nie jest szyfrowany — przechowuj go bezpiecznie.</div>}
      {dbHealth && <div role="status" className="alert success">Kontrola integralności: poprawna (schemat v{dbHealth.schema_version}). Klienci: {dbHealth.clients}, projekty: {dbHealth.projects}, zadania: {dbHealth.tasks}, zakończone wpisy: {dbHealth.completed_entries}, otwarte pomiary: {dbHealth.open_entries}. Diagnostyka nie pokazuje nazw ani opisów klientów.</div>}
      <div className="grid">
        <section className="timer card" aria-label="Pomiar czasu">
          <div className="section-top"><div><p className="section-kicker">AKTUALNY POMIAR</p><h2>Timer</h2></div><span className={`status ${loaded && data.active && !data.active.recovered ? 'running' : ''}`}><span />{!loaded ? 'Brak danych' : data.active?.recovered ? 'Do weryfikacji' : data.active ? 'W trakcie' : 'Zatrzymany'}</span></div>
          <div className="clock" aria-live="off">{!loaded || data.active?.recovered ? '—:—:—' : formatDuration(displayElapsed)}</div><p className="clock-caption">{!loaded ? 'Nie można ustalić stanu pomiaru' : data.active?.recovered ? 'Pomiar wymaga weryfikacji' : data.active ? 'Czas na ekranie jest orientacyjny' : 'Wybierz zadanie, aby rozpocząć'}</p>
          {loaded && data.active && <div className="active-info"><span>AKTYWNE ZADANIE</span><strong>{activeTask?.name || 'Nieznane zadanie'}</strong><small>{activeClient?.name || '—'} / {activeProject?.name || '—'}</small></div>}
          <div className="selectors">
            <label>Klient<select value={clientId} disabled={busy || !loaded} onChange={e => { setClientId(e.target.value); setProjectId(''); setTaskId(''); }}><option value="">Wybierz klienta</option>{data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Projekt<select value={projectId} disabled={busy || !loaded || !clientId} onChange={e => { setProjectId(e.target.value); setTaskId(''); }}><option value="">Wybierz projekt</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? ' (archiwum)' : ''}</option>)}</select></label>
            <label>Zadanie<select value={taskId} disabled={busy || !loaded || !projectId} onChange={e => setTaskId(e.target.value)}><option value="">Wybierz zadanie</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          </div>
          <div className="archive-controls"><label><input type="checkbox" checked={showArchived} onChange={e => { setShowArchived(e.target.checked); if (!e.target.checked && selectedProject?.archived) { setProjectId(''); setTaskId(''); } }} /> Pokaż projekty w archiwum</label>
          {selectedProject && <button className="secondary" disabled={busy || !loaded} onClick={() => execute(async () => { await invoke('archive_project', { projectId: Number(projectId), archived: !selectedProject.archived }); if (!selectedProject.archived && !showArchived) { setProjectId(''); setTaskId(''); } }, selectedProject.archived ? 'Projekt przywrócony.' : 'Projekt przeniesiony do archiwum; historia pozostaje dostępna.')}>{selectedProject.archived ? 'Przywróć projekt' : 'Archiwizuj projekt'}</button>}</div>
          <div className="actions"><button className="primary" disabled={busy || !taskId || !loaded || selectedProject?.archived || data.active?.recovered || same(data.active?.task_id, taskId)} onClick={() => execute(() => invoke('start_timer', { taskId: Number(taskId) }), data.active ? 'Przełączono zadanie.' : 'Pomiar uruchomiony.')}><span aria-hidden="true">▶</span> {data.active ? 'Przełącz zadanie' : 'Rozpocznij pomiar'}</button><button className="secondary" disabled={busy || !loaded || !data.active || data.active.recovered} onClick={() => execute(() => invoke('stop_timer'), 'Pomiar zatrzymany.')}><span aria-hidden="true">■</span> Zatrzymaj</button></div>
          <p className="helper">Pomiar działa dla jednego zadania jednocześnie.</p>
        </section>
        <aside className="card setup"><div className="section-top"><div><p className="section-kicker">UPORZĄDKUJ PRACĘ</p><h2>Twoja struktura</h2></div><span className="outline-icon">＋</span></div><p className="muted">Dodaj klienta, a następnie utwórz projekt i zadanie.</p>
          {(['client', 'project', 'task'] as const).map((kind, index) => { const namesPL = { client: 'Klient', project: 'Projekt', task: 'Zadanie' }; const disabled = busy || !loaded || (kind === 'project' && !clientId) || (kind === 'task' && (!projectId || selectedProject?.archived)); return <form key={kind} className="create-form" onSubmit={create(kind)}><div className="form-label"><span className="step">0{index + 1}</span><label htmlFor={`new-${kind}`}>{namesPL[kind]}</label></div><div className="input-row"><input id={`new-${kind}`} value={names[kind]} disabled={disabled} onChange={e => setNames(old => ({ ...old, [kind]: e.target.value }))} placeholder={`Nazwa: ${namesPL[kind].toLowerCase()}`} maxLength={200} /><button disabled={disabled || !names[kind].trim()} aria-label={`Dodaj ${namesPL[kind].toLowerCase()}`}>＋</button></div>{kind === 'project' && !clientId && <small>Najpierw wybierz klienta</small>}{kind === 'task' && !projectId && <small>Najpierw wybierz projekt</small>}</form>; })}
        </aside>
      </div>
      <section className="card history"><div className="section-top"><div><p className="section-kicker">TWOJA AKTYWNOŚĆ</p><h2>Historia pomiarów</h2></div>{loaded && <span className="count">{entries.length === 500 ? 'Ostatnie 500 wpisów' : `${entries.length} wpisów`}</span>}</div>
        {!loaded ? <p className="muted">Historia jest niedostępna do czasu ponownego odczytu danych.</p> : entries.length === 0 ? <div className="empty"><div className="empty-icon">◷</div><strong>Tu pojawi się Twoja historia</strong><p>Rozpocznij pierwszy pomiar, aby zobaczyć zapisane wpisy.</p></div> : <div className="table-wrap"><table><thead><tr><th>Zadanie</th><th>Klient / projekt</th><th>Rozpoczęcie</th><th>Zakończenie</th><th>Czas</th></tr></thead><tbody>{entries.map(e => { const t = data.tasks.find(x => same(x.id, e.task_id)); const p = data.projects.find(x => same(x.id, t?.project_id)); const c = data.clients.find(x => same(x.id, p?.client_id)); return <tr key={e.id}><td><strong>{t?.name || 'Nieznane zadanie'}</strong></td><td>{c?.name || '—'} / {p?.name || '—'}</td><td>{formatDate(e.started_at)}</td><td>{formatDate(e.ended_at)}{e.manually_resolved && <small> (wskazane ręcznie)</small>}</td><td className="duration">{e.duration_seconds == null ? 'Do weryfikacji' : formatDuration(e.duration_seconds)}</td></tr>; })}</tbody></table></div>}
      </section>
      <footer>Wersja rozwojowa · Dane przechowywane lokalnie</footer>
    </main>
  </div>;
}
