import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration, same } from './App';
import type { Snapshot } from './App';

export default function Widget() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [onTop, setOnTop] = useState(false);
  const [shortcut, setShortcut] = useState({ registered: false, message: '' });
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem('widget-on-top') === 'true') {
        invoke('set_widget_on_top', { onTop: true }).then(() => setOnTop(true))
          .catch(() => setError('Nie udało się przywrócić przypięcia okna.'));
      }
    } catch { setError('Nie udało się odczytać ustawień widgetu.'); }
  }, []);
  const refresh = useCallback(async () => {
    try { setData(await invoke<Snapshot>('get_snapshot')); setError(''); }
    catch { setData(null); setError('Nie można odczytać danych. Otwórz aplikację i ponów próbę.'); }
  }, []);
  useEffect(() => {
    void refresh();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const sync = window.setInterval(() => void refresh(), 2500);
    return () => { window.clearInterval(clock); window.clearInterval(sync); };
  }, [refresh]);
  const choices = useMemo(() => (data?.tasks ?? []).flatMap(task => {
    const project = data?.projects.find(item => same(item.id, task.project_id));
    const client = data?.clients.find(item => same(item.id, project?.client_id));
    return project && !project.archived && client && !client.archived && !task.archived ? [{ task, project, client }] : [];
  }), [data]);
  const latest = data?.active?.task_id ?? data?.entries[0]?.task_id;
  const choiceId = selected || (choices.some(item => same(item.task.id, latest)) ? String(latest) : '');
  const choice = choices.find(item => same(item.task.id, data?.active?.task_id ?? choiceId));
  useEffect(() => { void invoke('set_shortcut_task', { taskId: choice ? Number(choice.task.id) : null }); }, [choice?.task.id]);
  useEffect(() => {
    const check = () => { void invoke<{ registered: boolean; message: string }>('shortcut_status').then(setShortcut).catch(() => {}); };
    check(); const timer = window.setInterval(check, 1500); return () => window.clearInterval(timer);
  }, []);
  const elapsed = data?.active ? (now - new Date(data.active.started_at).getTime()) / 1000 : 0;
  const filtered = choices.filter(({ task, project, client }) => `${task.name} ${project.name} ${client.name}`.toLocaleLowerCase('pl').includes(query.trim().toLocaleLowerCase('pl')));
  const groups = filtered.reduce<{ id: string; name: string; client: string; items: typeof choices }[]>((all, item) => {
    let group = all.find(g => g.id === String(item.project.id));
    if (!group) { group = { id: String(item.project.id), name: item.project.name, client: item.client.name, items: [] }; all.push(group); }
    group.items.push(item); return all;
  }, []);
  const visible = groups.flatMap(group => collapsed.includes(group.id) ? [] : group.items);

  const setPanel = useCallback(async (value: boolean) => {
    try { await invoke('widget_panel', { expanded: value }); setOpen(value); if (value) { setQuery(''); setCursor(0); setCollapsed([]); } }
    catch { setError('Nie udało się otworzyć panelu zadań.'); }
  }, []);
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  const toggle = useCallback(async () => {
    if (busy || !data || data.active?.recovered || (!data.active && !choice)) return;
    setBusy(true); setError('');
    try {
      if (data.active) await invoke('widget_stop', { entryId: Number(data.active.id) });
      else { await invoke('widget_start', { taskId: Number(choice!.task.id), description: draft }); setDraft(''); }
      await refresh();
    } catch (e) { await refresh(); setError(`Nie udało się wykonać operacji: ${String(e)}`); }
    finally { setBusy(false); }
  }, [busy, data, choice, draft, refresh]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!shortcut.registered && event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'Space' && !event.repeat) { event.preventDefault(); void toggle(); }
      if (event.key === 'Escape' && open) { event.preventDefault(); void setPanel(false); }
    };
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey);
  }, [toggle, open, setPanel, shortcut.registered]);
  async function changePin() {
    try { await invoke('set_widget_on_top', { onTop: !onTop }); setOnTop(!onTop); localStorage.setItem('widget-on-top', String(!onTop)); }
    catch { setError('Nie udało się zmienić przypięcia okna.'); }
  }
  function selectTask(id: string) { setSelected(id); void setPanel(false); }
  const showApp = () => invoke('show_main').catch(() => setError('Nie udało się otworzyć aplikacji.'));
  return <main className="mini-shell">
    <div className="mini-bar">
      <button className="mini-drag" title="Przeciągnij widget" aria-label="Przeciągnij widget" onMouseDown={e => { if (e.button === 0) void invoke('widget_drag'); }}>⠿</button>
      <div className="mini-details">
        <input className="mini-title mini-description" aria-label="Opis pomiaru" placeholder="Nad czym pracujesz?" maxLength={2000} value={data?.active ? data.active.description : draft} readOnly={!!data?.active} disabled={!data || busy} onChange={e => setDraft(e.target.value)} title={data?.active ? 'Opis zmienisz w pełnej aplikacji' : 'Opcjonalny opis pomiaru'} />
        <button className="mini-project" disabled={!data || !!data.active} onClick={() => void setPanel(!open)} aria-expanded={open} title={data?.active ? 'Zatrzymaj pomiar, aby zmienić zadanie' : choice ? `${choice.client.name} / ${choice.project.name}` : 'Wybierz projekt lub zadanie'}><span className="mini-plus">＋</span><span>{choice ? `${choice.client.name} / ${choice.project.name}` : 'Projekt lub zadanie'}</span></button>
      </div>
      <span className="mini-time" title={data?.active?.recovered ? 'Pomiar wymaga weryfikacji w aplikacji' : 'Czas bieżącego pomiaru'}>{!data || data.active?.recovered ? '—:—:—' : formatDuration(Number.isFinite(elapsed) ? elapsed : 0)}</span>
      <button className={`mini-play ${data?.active ? 'is-running' : ''}`} aria-label={data?.active ? 'Zatrzymaj pomiar' : 'Rozpocznij pomiar'} title={shortcut.registered ? "Start / stop · Ctrl + Shift + Spacja globalnie" : "Start / stop · Ctrl + Shift + Spacja w tym oknie"} disabled={busy || !data || !!data.active?.recovered || (!data.active && !choice)} onClick={() => void toggle()}>{data?.active ? <span className="mini-stop-icon" /> : <span className="mini-play-icon" />}</button>
      <button className="mini-icon mini-expand" onClick={showApp} title="Otwórz pełną aplikację" aria-label="Otwórz pełną aplikację">⤢</button>
      <button className="mini-close" onClick={() => invoke('close_widget')} title="Zamknij widget" aria-label="Zamknij widget">×</button>
    </div>
    {open && <section className="mini-panel" aria-label="Wybór zadania">
      <div className="mini-search-row"><div className="mini-search"><span aria-hidden="true">⌕</span><input ref={search} value={query} placeholder="Szukaj projektu, zadania lub klienta" aria-label="Szukaj projektu, zadania lub klienta" onChange={e => { setQuery(e.target.value); setCursor(0); }} onKeyDown={e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(Math.min(cursor + 1, visible.length - 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(Math.max(cursor - 1, 0)); }
        if (e.key === 'Enter' && visible[cursor]) { e.preventDefault(); selectTask(String(visible[cursor].task.id)); }
      }}/></div><button className={`mini-pin ${onTop ? 'is-pinned' : ''}`} onClick={() => void changePin()} aria-pressed={onTop} title={onTop ? 'Odepnij od wierzchu' : 'Przypnij na wierzchu'} aria-label={onTop ? 'Odepnij od wierzchu' : 'Przypnij na wierzchu'}><svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M16 3c-.4 0-.8.2-1 .5l-1 1-3.9-.4-.9.9 2 3.1-4.1 4.1-2.8-.2-.8.8 4.1 4.1-4.3 4.3.7.7 4.3-4.3 4.1 4.1.8-.8-.2-2.8 4.1-4.1 3.1 2 .9-.9-.4-3.9 1-1a1.4 1.4 0 0 0 0-2l-2.7-2.7a1.4 1.4 0 0 0-1-.4Z"/></svg></button></div>
      <div className="mini-results">{groups.length === 0 ? <div className="mini-empty">{choices.length ? 'Brak pasujących zadań.' : 'Brak zadań. Dodaj klienta, projekt i zadanie w aplikacji.'} <button onClick={showApp}>Otwórz aplikację</button></div> : groups.map(group => <div key={group.id} className="mini-group"><button className="mini-group-header" aria-expanded={!collapsed.includes(group.id)} onClick={() => { setCollapsed(current => current.includes(group.id) ? current.filter(id => id !== group.id) : [...current, group.id]); setCursor(0); }}><svg className="mini-folder" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v1H2V6Zm0 5h20v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7Z"/></svg><span className="mini-group-name">{group.name} <small>· {group.client}</small></span><small>{group.items.length} {group.items.length === 1 ? 'zadanie' : 'zadań'}</small><span>{collapsed.includes(group.id) ? '⌄' : '⌃'}</span></button>{!collapsed.includes(group.id) && group.items.map(item => { const index = visible.findIndex(v => same(v.task.id, item.task.id)); return <button key={item.task.id} className={`mini-result ${index === cursor ? 'highlighted' : ''}`} onMouseEnter={() => setCursor(index)} onClick={() => selectTask(String(item.task.id))}>{item.task.name}</button>; })}</div>)}</div>
    </section>}
    {(error || data?.active?.recovered || shortcut.message) && <div className="mini-problem" role="alert" onClick={showApp}>{error || shortcut.message || 'Pomiar wymaga weryfikacji. Otwórz aplikację.'}</div>}
  </main>;
}
