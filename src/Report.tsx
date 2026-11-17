import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dateInZone, reportByDay, reportOverlaps, validTimeZone } from './reportTime';
import type { ReportEntry } from './reportTime';
import { filterByClient } from './reportClientFilter';
import { reportPresetRange } from './reportPresets';
import type { ReportPreset } from './reportPresets';
import { readReportFilter, saveReportFilter, validReportFilter } from './reportFilterStorage';
import type { SavedReportFilter } from './reportFilterStorage';
import ReportExport from './ReportExport';

type Id = number | string;
type Client = { id: Id; name: string };
type Project = { id: Id; client_id: Id; name: string };
type Completed = ReportEntry & { task_id: number | null; project_id: number; billable: boolean };
type Active = { id: number; task_id: number | null; project_id: number; started_at: string; ended_at: string | null; duration_seconds: number | null; unresolved: boolean; billable: boolean };
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

export default function Report({ clients, projects, loaded, onEditEntry }: { clients: Client[]; projects: Project[]; loaded: boolean; onEditEntry: (entry: Completed) => void }) {
  const [open, setOpen] = useState(false);
  const [initialFilter] = useState(() => { try { return readReportFilter(window.localStorage); } catch { return { filter: null, problem: true }; } });
  const [from, setFrom] = useState(() => initialFilter.filter?.kind === 'custom' ? initialFilter.filter.from : todayWarsaw().slice(0, 8) + '01');
  const [through, setThrough] = useState(() => initialFilter.filter?.kind === 'custom' ? initialFilter.filter.through : todayWarsaw());
  const [preset, setPreset] = useState<ReportPreset | 'custom'>(() => initialFilter.filter?.kind ?? 'custom');
  const [filterStorageProblem, setFilterStorageProblem] = useState(initialFilter.problem);
  const [now, setNow] = useState(Date.now);
  const [client, setClient] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [zoneDraft, setZoneDraft] = useState('');
  const [zoneError, setZoneError] = useState('');
  const [zoneSaving, setZoneSaving] = useState(false);
  const zoneInitialised = useRef(false);
  const hasUserChoice = useRef(initialFilter.filter !== null);

  function rememberFilter(filter: SavedReportFilter) {
    hasUserChoice.current = true;
    if (!validReportFilter(filter)) return;
    try { setFilterStorageProblem(!saveReportFilter(window.localStorage, filter)); }
    catch { setFilterStorageProblem(true); }
  }

  useEffect(() => {
    if (!open || !loaded) { setData(null); return; }
    let cancelled = false;
    let timer: number | undefined;
    async function update() {
      try {
        const next = await invoke<Data>('get_report_data');
        if (!cancelled) { setData(next); setError(''); if (!zoneInitialised.current) { setZoneDraft(next.time_zone); if (!hasUserChoice.current && validTimeZone(next.time_zone)) { const today = dateInZone(Date.now(), next.time_zone); setFrom(today.slice(0, 8) + '01'); setThrough(today); } zoneInitialised.current = true; } }
      } catch (e) {
        if (!cancelled) { setData(null); setError(`Nie można odczytać raportu: ${String(e)}`); }
      } finally {
        if (!cancelled) timer = window.setTimeout(update, 5000);
      }
    }
    void update();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [open, loaded, refresh]);

  useEffect(() => {
    const zone = data?.time_zone;
    if (!open || preset === 'custom' || !zone || !validTimeZone(zone)) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(previous => dateInZone(previous, zone) === dateInZone(current, zone) ? previous : current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, preset, data?.time_zone]);

  const range = useMemo(() => preset !== 'custom' && data && validTimeZone(data.time_zone)
    ? reportPresetRange(preset, now, data.time_zone) : { from, through }, [preset, now, data, from, through]);

  const result = useMemo(() => {
    if (!data) return null;
    const { entries, active, missingRelations } = filterByClient(data.entries, data.active, projects, client);
    try {
      if (!validTimeZone(data.time_zone)) return { invalidZone: true as const };
      const completed = reportByDay(entries, range.from, range.through, data.time_zone);
      const activeEntry = active && !active.unresolved && active.ended_at !== null && active.duration_seconds !== null
        ? { id: active.id, started_at: active.started_at, ended_at: active.ended_at, duration_seconds: active.duration_seconds, billable: active.billable } : null;
      const combined = reportByDay(activeEntry ? [...entries, activeEntry] : entries, range.from, range.through, data.time_zone);
      const billableSeconds = reportByDay([...entries.filter(entry => entry.billable), ...(activeEntry?.billable ? [activeEntry] : [])], range.from, range.through, data.time_zone).totalSeconds;
      const overlaps = reportOverlaps(activeEntry ? [...entries, activeEntry] : entries, range.from, range.through, data.time_zone);
      return { completed, combined, overlaps, active, activeSeconds: combined.totalSeconds - completed.totalSeconds, billableSeconds, missingRelations, invalidRange: false, invalidZone: false };
    } catch {
      return { invalidRange: true as const, invalidZone: false };
    }
  }, [data, range.from, range.through, client, projects]);

  return <section className="card report" aria-label="Raport czasu">
    <div className="section-top"><div><p className="section-kicker">PODSUMOWANIE PRACY</p><h2>Raport czasu</h2></div><button type="button" className="secondary report-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Zamknij raport' : 'Otwórz raport'}</button></div>
    {open && <>
      <p className="muted">Czas według dni w strefie {data?.time_zone || 'raportowania'}. Zmiana strefy komputera nie zmienia raportu.</p>
      {data && <details className="report-zone"><summary>Zmień strefę raportowania</summary><p className="muted">Podaj nazwę strefy IANA, np. Europe/Warsaw, Europe/London lub America/New_York. Zmiana przeliczy przypisanie wcześniejszych pomiarów do dni, bez zmiany zapisanych pomiarów.</p><label>Strefa raportowania<input value={zoneDraft} disabled={zoneSaving} list="report-time-zones" onChange={e => { setZoneDraft(e.target.value); setZoneError(''); }} /></label><datalist id="report-time-zones"><option value="Europe/Warsaw" /><option value="Europe/London" /><option value="Europe/Berlin" /><option value="America/New_York" /><option value="UTC" /></datalist>{' '}<button className="secondary report-button" type="button" disabled={zoneSaving || !loaded} onClick={() => { if (!validTimeZone(zoneDraft)) { setZoneError('Podaj poprawną nazwę strefy IANA, np. Europe/Warsaw.'); return; } setZoneSaving(true); setZoneError(''); void invoke('set_report_timezone', { expectedTimeZone: data.time_zone, timeZone: zoneDraft }).then(() => { setNow(Date.now()); setRefresh(n => n + 1); }).catch(e => { setZoneError(`Nie udało się zapisać strefy: ${String(e)}`); setRefresh(n => n + 1); }).finally(() => setZoneSaving(false)); }}>Zapisz strefę</button>{zoneError && <div role="alert" className="alert error">{zoneError}</div>}</details>}
      <div className="report-presets" aria-label="Szybki wybór zakresu"><button type="button" className="secondary report-button" aria-pressed={preset === 'today'} disabled={!data || !validTimeZone(data.time_zone)} onClick={() => { setNow(Date.now()); setPreset('today'); rememberFilter({ kind: 'today' }); }}>Dzisiaj</button><button type="button" className="secondary report-button" aria-pressed={preset === 'week'} disabled={!data || !validTimeZone(data.time_zone)} onClick={() => { setNow(Date.now()); setPreset('week'); rememberFilter({ kind: 'week' }); }}>Ten tydzień</button></div>
      <div className="selectors report-filters"><label>Od<input type="date" value={range.from} onChange={e => { const value = e.target.value; setFrom(value); setThrough(range.through); setPreset('custom'); rememberFilter({ kind: 'custom', from: value, through: range.through }); }} /></label><label>Do<input type="date" value={range.through} onChange={e => { const value = e.target.value; setFrom(range.from); setThrough(value); setPreset('custom'); rememberFilter({ kind: 'custom', from: range.from, through: value }); }} /></label><label>Klient<select value={client} onChange={e => setClient(e.target.value)}><option value="">Wszyscy klienci</option>{clients.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}</select></label></div>
      {filterStorageProblem && <div role="alert" className="alert error">Nie udało się odczytać lub zapisać zakresu raportu. Możesz nadal korzystać z raportu, ale wybór może nie zostać zapamiętany po zamknięciu aplikacji.</div>}
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
      {data && result && !result.invalidZone && 'invalidRange' in result && !result.invalidRange && <ReportExport client={client} from={range.from} through={range.through} zone={data.time_zone} />}
    </>}
  </section>;
}
