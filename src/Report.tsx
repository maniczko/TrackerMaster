import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dateInZone, reportByDay, reportOverlaps, validTimeZone } from './reportTime';
import type { ReportEntry } from './reportTime';

type Id = number | string;
type Client = { id: Id; name: string };
type Project = { id: Id; client_id: Id; name: string };
type Task = { id: Id; project_id: Id; name: string };
type Completed = ReportEntry & { task_id: number; billable: boolean };
type Active = { id: number; task_id: number; started_at: string; ended_at: string | null; duration_seconds: number | null; unresolved: boolean; billable: boolean };
type Data = { entries: Completed[]; active: Active | null; time_zone: string };

function todayWarsaw() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (name: string) => parts.find(p => p.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function duration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}

export default function Report({ clients, projects, tasks, loaded, onEditEntry }: { clients: Client[]; projects: Project[]; tasks: Task[]; loaded: boolean; onEditEntry: (entry: Completed) => void }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(() => todayWarsaw().slice(0, 8) + '01');
  const [through, setThrough] = useState(todayWarsaw);
  const [client, setClient] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [zoneDraft, setZoneDraft] = useState('');
  const [zoneError, setZoneError] = useState('');
  const [zoneSaving, setZoneSaving] = useState(false);
  const zoneInitialised = useRef(false);

  useEffect(() => {
    if (!open || !loaded) { setData(null); return; }
    let cancelled = false;
    let timer: number | undefined;
    async function update() {
      try {
        const next = await invoke<Data>('get_report_data');
        if (!cancelled) { setData(next); setError(''); if (!zoneInitialised.current) { setZoneDraft(next.time_zone); if (validTimeZone(next.time_zone)) { const today = dateInZone(Date.now(), next.time_zone); setFrom(today.slice(0, 8) + '01'); setThrough(today); } zoneInitialised.current = true; } }
      } catch (e) {
        if (!cancelled) { setData(null); setError(`Nie można odczytać raportu: ${String(e)}`); }
      } finally {
        if (!cancelled) timer = window.setTimeout(update, 5000);
      }
    }
    void update();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [open, loaded, refresh]);

  const result = useMemo(() => {
    if (!data) return null;
    const taskClients = new Map(tasks.map(task => {
      const project = projects.find(p => String(p.id) === String(task.project_id));
      return [String(task.id), project ? String(project.client_id) : null];
    }));
    const belongs = (taskId: Id) => !client || taskClients.get(String(taskId)) === client;
    // An unresolved relation must not silently disappear from a filtered report.
    const missingRelations = !!client && [...data.entries, ...(data.active ? [data.active] : [])].some(e => !taskClients.get(String(e.task_id)));
    const entries = data.entries.filter(e => belongs(e.task_id));
    const active = data.active && belongs(data.active.task_id) ? data.active : null;
    try {
      if (!validTimeZone(data.time_zone)) return { invalidZone: true as const };
      const completed = reportByDay(entries, from, through, data.time_zone);
      const activeEntry = active && !active.unresolved && active.ended_at !== null && active.duration_seconds !== null
        ? { id: active.id, started_at: active.started_at, ended_at: active.ended_at, duration_seconds: active.duration_seconds, billable: active.billable } : null;
      const combined = reportByDay(activeEntry ? [...entries, activeEntry] : entries, from, through, data.time_zone);
      const billableSeconds = reportByDay([...entries.filter(entry => entry.billable), ...(activeEntry?.billable ? [activeEntry] : [])], from, through, data.time_zone).totalSeconds;
      const overlaps = reportOverlaps(activeEntry ? [...entries, activeEntry] : entries, from, through, data.time_zone);
      return { completed, combined, overlaps, active, activeSeconds: combined.totalSeconds - completed.totalSeconds, billableSeconds, missingRelations, invalidRange: false, invalidZone: false };
    } catch {
      return { invalidRange: true as const, invalidZone: false };
    }
  }, [data, from, through, client, tasks, projects]);

  return <section className="card report" aria-label="Raport czasu">
    <div className="section-top"><div><p className="section-kicker">PODSUMOWANIE PRACY</p><h2>Raport czasu</h2></div><button type="button" className="secondary report-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Zamknij raport' : 'Otwórz raport'}</button></div>
    {open && <>
      <p className="muted">Czas według dni w strefie {data?.time_zone || 'raportowania'}. Zmiana strefy komputera nie zmienia raportu.</p>
      {data && <details className="report-zone"><summary>Zmień strefę raportowania</summary><p className="muted">Podaj nazwę strefy IANA, np. Europe/Warsaw, Europe/London lub America/New_York. Zmiana przeliczy przypisanie wcześniejszych pomiarów do dni, bez zmiany zapisanych pomiarów.</p><label>Strefa raportowania<input value={zoneDraft} list="report-time-zones" onChange={e => { setZoneDraft(e.target.value); setZoneError(''); }} /></label><datalist id="report-time-zones"><option value="Europe/Warsaw" /><option value="Europe/London" /><option value="Europe/Berlin" /><option value="America/New_York" /><option value="UTC" /></datalist>{' '}<button className="secondary report-button" type="button" disabled={zoneSaving || !loaded} onClick={() => { if (!validTimeZone(zoneDraft)) { setZoneError('Podaj poprawną nazwę strefy IANA, np. Europe/Warsaw.'); return; } setZoneSaving(true); setZoneError(''); void invoke('set_report_timezone', { expectedTimeZone: data.time_zone, timeZone: zoneDraft }).then(() => setRefresh(n => n + 1)).catch(e => { setZoneError(`Nie udało się zapisać strefy: ${String(e)}`); setRefresh(n => n + 1); }).finally(() => setZoneSaving(false)); }}>Zapisz strefę</button>{zoneError && <div role="alert" className="alert error">{zoneError}</div>}</details>}
      <div className="selectors report-filters"><label>Od<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Do<input type="date" value={through} onChange={e => setThrough(e.target.value)} /></label><label>Klient<select value={client} onChange={e => setClient(e.target.value)}><option value="">Wszyscy klienci</option>{clients.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}</select></label></div>
      {!loaded && <p role="status">Odśwież dane aplikacji, aby wyświetlić raport.</p>}
      {error && <div role="alert" className="alert error">{error} <button type="button" onClick={() => setRefresh(n => n + 1)}>Ponów</button></div>}
      {loaded && !data && !error && <p role="status">Wczytywanie raportu…</p>}
      {result?.invalidZone && <div role="alert" className="alert error">Zapisana strefa raportu nie jest obsługiwana. Wybierz poprawną strefę przed wyświetleniem wyników.</div>}
      {result && 'invalidRange' in result && result.invalidRange && <div role="alert" className="alert error">Podaj poprawny zakres dat od 1970 roku; data końcowa nie może być wcześniejsza niż początkowa.</div>}
      {result && !result.invalidZone && 'invalidRange' in result && !result.invalidRange && <>
        {(result.combined.excludedEntryIds.length > 0 || result.missingRelations) && <div role="alert" className="alert error"><strong>Raport jest niepełny.</strong> {result.combined.excludedEntryIds.length > 0 && <>Nie można bezpiecznie przypisać czasu do dni dla wpisów: {result.combined.excludedEntryIds.join(', ')}. Sprawdź je w historii. </>}{result.missingRelations && 'Brakuje powiązania części wpisów z klientem.'}</div>}
        {result.overlaps.entryIds.length > 0 && <div role="alert" className="alert error"><strong>Wykryto nakładające się pomiary.</strong> Suma może uwzględniać ten sam czas więcej niż raz. Sprawdź wpisy: {result.overlaps.entryIds.map(id => `#${id}`).join(', ')}{result.overlaps.truncated ? ' i być może kolejne' : ''}. <div className="actions">{data?.entries.filter(entry => result.overlaps.entryIds.includes(entry.id)).map(entry => <button type="button" className="secondary" key={entry.id} onClick={() => onEditEntry(entry)}>Popraw wpis #{entry.id}</button>)}</div>{result.active && result.overlaps.entryIds.includes(result.active.id) && <p>Zatrzymaj aktywny pomiar, aby go poprawić.</p>}</div>}
        {result.active?.unresolved && <div role="alert" className="alert error">Aktywny pomiar wymaga weryfikacji lub sprawdzenia zegara. Nie jest doliczany do raportu.</div>}
        <div className="report-summary"><div><small>Łącznie{result.combined.excludedEntryIds.length || result.missingRelations ? ' — niepełne' : ''}</small><strong>{duration(result.combined.totalSeconds)}</strong></div><div><small>Średnio na dzień z pracą</small><strong>{result.combined.averageSeconds === null ? 'Brak danych' : duration(result.combined.averageSeconds)}</strong></div><div><small>Czas rozliczalny</small><strong>{duration(result.billableSeconds)}</strong><small>{result.combined.totalSeconds ? `${new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 }).format(100 * result.billableSeconds / result.combined.totalSeconds)}% czasu` : 'Brak danych'}</small></div><div><small>W tym aktywny pomiar · orientacyjnie</small><strong>{duration(result.activeSeconds)}</strong></div></div>
        {result.active && !result.active.unresolved && <p className="muted">Aktywny pomiar jest tymczasowy i aktualizuje się co kilka sekund.</p>}
        {result.combined.days.length === 0 ? <p className="muted">Brak zakończonych lub aktywnych pomiarów w wybranym zakresie.</p> : <div className="table-wrap"><table><thead><tr><th>Dzień</th><th>Czas</th></tr></thead><tbody>{result.combined.days.map(day => <tr key={day.date}><td>{day.date}</td><td className="duration">{duration(day.seconds)}</td></tr>)}</tbody></table></div>}
      </>}
    </>}
  </section>;
}
