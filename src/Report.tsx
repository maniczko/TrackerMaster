import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dateInZone, validTimeZone } from './reportTime';
import { reportPresetRange } from './reportPresets';
import type { ReportPreset } from './reportPresets';
import { readReportFilter, validReportFilter } from './reportFilterStorage';
import type { SavedReportFilter } from './reportFilterStorage';
import ReportExport from './ReportExport';
import ReportDetails from './ReportDetails';
import { formatDuration as duration } from './reportCsv';
import { makeReportView } from './reportView';
import type { ActiveReportEntry, CompletedReportEntry, ReportClient, ReportProject, ReportTask } from './reportView';

type Data = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };
type Props = {
  clients: ReportClient[];
  projects: ReportProject[];
  tasks: ReportTask[];
  loaded: boolean;
  revision: number;
  hasUnsavedEdit: () => boolean;
  onEditEntry: (entryId: number) => void;
  onShowHistory: (entryId: number) => void;
};

function todayWarsaw() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (name: string) => parts.find(p => p.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export default function Report({ clients, projects, tasks, loaded, revision, hasUnsavedEdit, onEditEntry, onShowHistory }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'summary' | 'details'>('summary');
  const [initialFilter] = useState(() => { try { return readReportFilter(window.localStorage); } catch { return { filter: null, problem: true }; } });
  const [from, setFrom] = useState(() => initialFilter.filter?.kind === 'custom' ? initialFilter.filter.from : todayWarsaw().slice(0, 8) + '01');
  const [through, setThrough] = useState(() => initialFilter.filter?.kind === 'custom' ? initialFilter.filter.through : todayWarsaw());
  const [preset, setPreset] = useState<ReportPreset | 'custom'>(() => initialFilter.filter?.kind ?? 'custom');
  const [filterReady, setFilterReady] = useState(false);
  const [filterStorageProblem, setFilterStorageProblem] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [client, setClient] = useState('');
  const [snapshot, setSnapshot] = useState<{ request: string; data: Data } | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = `${revision}:${refresh}`;
  const data = snapshot?.request === request ? snapshot.data : null;
  const [zoneDraft, setZoneDraft] = useState('');
  const [zoneError, setZoneError] = useState('');
  const [zoneSaving, setZoneSaving] = useState(false);
  const zoneInitialised = useRef(false);
  const hasUserChoice = useRef(initialFilter.filter !== null);
  const pendingFilterSave = useRef(Promise.resolve());

  useEffect(() => {
    let disposed = false;
    void invoke<SavedReportFilter | null>('get_report_filter', { legacyFilter: initialFilter.filter })
      .then(filter => {
        if (disposed) return;
        if (filter) {
          hasUserChoice.current = true;
          setNow(Date.now());
          setPreset(filter.kind);
          if (filter.kind === 'custom') {
            setFrom(filter.from);
            setThrough(filter.through);
          }
        }
        setFilterStorageProblem(!filter && initialFilter.problem);
      })
      .catch(() => { if (!disposed) setFilterStorageProblem(true); })
      .finally(() => { if (!disposed) setFilterReady(true); });
    return () => { disposed = true; };
  }, [initialFilter]);

  function rememberFilter(filter: SavedReportFilter) {
    hasUserChoice.current = true;
    if (!validReportFilter(filter)) return;
    pendingFilterSave.current = pendingFilterSave.current
      .then(() => invoke<void>('set_report_filter', { filter }))
      .then(() => setFilterStorageProblem(false), () => setFilterStorageProblem(true));
  }

  useEffect(() => {
    if (!open || !loaded || !filterReady) { setSnapshot(null); return; }
    let cancelled = false;
    let timer: number | undefined;
    async function update() {
      try {
        const next = await invoke<Data>('get_report_data');
        if (!cancelled) { setSnapshot({ request, data: next }); setError(''); if (!zoneInitialised.current) { setZoneDraft(next.time_zone); if (!hasUserChoice.current && validTimeZone(next.time_zone)) { const today = dateInZone(Date.now(), next.time_zone); setFrom(today.slice(0, 8) + '01'); setThrough(today); } zoneInitialised.current = true; } }
      } catch (e) {
        if (!cancelled) { setSnapshot(null); setError(`Nie można odczytać raportu: ${String(e)}`); }
      } finally {
        if (!cancelled) timer = window.setTimeout(update, 5000);
      }
    }
    void update();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [open, loaded, request, filterReady]);

  useEffect(() => {
    const zone = data?.time_zone;
    if (!open || preset === 'custom' || !zone || !validTimeZone(zone)) return;
    const timer = window.setInterval(() => {
      if (hasUnsavedEdit()) return;
      const current = Date.now();
      setNow(previous => dateInZone(previous, zone) === dateInZone(current, zone) ? previous : current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, preset, data?.time_zone, hasUnsavedEdit]);

  const range = useMemo(() => preset !== 'custom' && data && validTimeZone(data.time_zone)
    ? reportPresetRange(preset, now, data.time_zone) : { from, through }, [preset, now, data, from, through]);

  const result = useMemo(() => {
    if (!data) return null;
    if (!validTimeZone(data.time_zone)) return { error: 'Zapisana strefa raportu nie jest obsługiwana.' };
    if (!validReportFilter({ kind: 'custom', ...range })) {
      return { error: 'Podaj poprawny zakres dat od 1970 roku. Data końcowa nie może być wcześniejsza niż początkowa.' };
    }
    try {
      return { view: makeReportView(data, { clients, projects, tasks }, client, range.from, range.through) };
    } catch (problem) {
      return { error: problem instanceof Error ? problem.message : 'Nie udało się obliczyć raportu.' };
    }
  }, [data, range, client, clients, projects, tasks]);
  const view = result?.view;
  const incomplete = !!view && (view.excludedEntryIds.length > 0 || view.missingRelations);
  const scope = JSON.stringify([client, range.from, range.through, data?.time_zone]);

  return <section className="card report" aria-label="Raport czasu">
    <div className="section-top"><div><p className="section-kicker">PODSUMOWANIE PRACY</p><h2>Raport czasu</h2></div><button type="button" className="secondary report-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Zamknij raport' : 'Otwórz raport'}</button></div>
    {open && <>
      <p className="muted">Czas według dni w strefie {data?.time_zone || 'raportowania'}. Zmiana strefy komputera nie zmienia raportu.</p>
      {data && <details className="report-zone"><summary>Zmień strefę raportowania</summary><p className="muted">Podaj nazwę strefy IANA, np. Europe/Warsaw, Europe/London lub America/New_York. Zmiana przeliczy przypisanie wcześniejszych pomiarów do dni, bez zmiany zapisanych pomiarów.</p><label>Strefa raportowania<input value={zoneDraft} disabled={zoneSaving} list="report-time-zones" onChange={e => { setZoneDraft(e.target.value); setZoneError(''); }} /></label><datalist id="report-time-zones"><option value="Europe/Warsaw" /><option value="Europe/London" /><option value="Europe/Berlin" /><option value="America/New_York" /><option value="UTC" /></datalist>{' '}<button className="secondary report-button" type="button" disabled={zoneSaving || !loaded} onClick={() => { if (!validTimeZone(zoneDraft)) { setZoneError('Podaj poprawną nazwę strefy IANA, np. Europe/Warsaw.'); return; } setZoneSaving(true); setZoneError(''); void invoke('set_report_timezone', { expectedTimeZone: data.time_zone, timeZone: zoneDraft }).then(() => { setNow(Date.now()); setRefresh(n => n + 1); }).catch(e => { setZoneError(`Nie udało się zapisać strefy: ${String(e)}`); setRefresh(n => n + 1); }).finally(() => setZoneSaving(false)); }}>Zapisz strefę</button>{zoneError && <div role="alert" className="alert error">{zoneError}</div>}</details>}
      <div className="report-presets" aria-label="Szybki wybór zakresu"><button type="button" className="secondary report-button" aria-pressed={preset === 'today'} disabled={!filterReady || !data || !validTimeZone(data.time_zone)} onClick={() => { setNow(Date.now()); setPreset('today'); rememberFilter({ kind: 'today' }); }}>Dzisiaj</button><button type="button" className="secondary report-button" aria-pressed={preset === 'week'} disabled={!filterReady || !data || !validTimeZone(data.time_zone)} onClick={() => { setNow(Date.now()); setPreset('week'); rememberFilter({ kind: 'week' }); }}>Ten tydzień</button></div>
      <div className="selectors report-filters"><label>Od<input type="date" disabled={!filterReady} value={range.from} onChange={e => { const value = e.target.value; setFrom(value); setThrough(range.through); setPreset('custom'); rememberFilter({ kind: 'custom', from: value, through: range.through }); }} /></label><label>Do<input type="date" disabled={!filterReady} value={range.through} onChange={e => { const value = e.target.value; setFrom(range.from); setThrough(value); setPreset('custom'); rememberFilter({ kind: 'custom', from: range.from, through: value }); }} /></label><label>Klient<select value={client} onChange={e => setClient(e.target.value)}><option value="">Wszyscy klienci</option>{clients.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}</select></label></div>
      {filterStorageProblem && <div role="alert" className="alert error">Nie udało się odczytać lub zapisać zakresu raportu. Możesz nadal korzystać z raportu, ale wybór może nie zostać zapamiętany po zamknięciu aplikacji.</div>}
      {!loaded && <p role="status">Odśwież dane aplikacji, aby wyświetlić raport.</p>}
      {error && <div role="alert" className="alert error">{error} <button type="button" onClick={() => setRefresh(n => n + 1)}>Ponów</button></div>}
      {loaded && !data && !error && <p role="status">Wczytywanie raportu…</p>}
      {result?.error && <div role="alert" className="alert error">{result.error}</div>}
      {view && data && <>
        {incomplete && <div role="alert" className="alert error">
          <strong>Raport jest niepełny.</strong> {view.excludedEntryIds.length > 0 && <>Nie można bezpiecznie przypisać czasu do dni dla wpisów {view.excludedEntryIds.join(', ')}. </>}
          {view.missingRelations && 'Sprawdź powiązanie wpisów z klientem, projektem i zadaniem.'}
        </div>}
        {view.overlaps.entryIds.length > 0 && <div role="alert" className="alert error">
          <strong>Wykryto nakładające się pomiary.</strong> Suma może uwzględniać ten sam czas więcej niż raz.
          <div className="actions">
            {data.entries.filter(entry => view.overlaps.entryIds.includes(entry.id)).map(entry =>
              <button type="button" className="secondary" key={entry.id} onClick={() => onEditEntry(entry.id)}>Popraw wpis #{entry.id}</button>)}
          </div>
          {view.overlaps.truncated && <p>Wyświetlono tylko część powiązanych wpisów.</p>}
          {view.active && view.overlaps.entryIds.includes(view.active.id) && <p>Zatrzymaj aktywny pomiar, aby go poprawić.</p>}
        </div>}
        {view.pendingSeconds > 0 && <p role="status" className="alert">Uśpienie do rozstrzygnięcia <strong>{duration(view.pendingSeconds)}</strong></p>}
        {view.awaitingSeconds > 0 && <p role="status" className="alert">
          Praca we wpisach z nierozstrzygniętą przerwą <strong>{duration(view.awaitingSeconds)}</strong>. Pojawi się w zatwierdzonej sumie po rozstrzygnięciu przerwy.
        </p>}
        {view.active?.unresolved && <div role="alert" className="alert error">Aktywny pomiar wymaga weryfikacji lub sprawdzenia zegara.</div>}
        <div className="report-presets" role="group" aria-label="Widok raportu">
          <button type="button" className="secondary report-button" aria-pressed={tab === 'summary'} onClick={() => setTab('summary')}>Podsumowanie</button>
          <button type="button" className="secondary report-button" aria-pressed={tab === 'details'} onClick={() => setTab('details')}>Szczegóły</button>
        </div>
        {tab === 'summary' ? <>
          <div className="report-summary">
            <div><small>Zatwierdzony czas{incomplete ? ' · suma niepełna' : ''}</small><strong>{duration(view.finalizedSeconds)}</strong></div>
            <div><small>Aktywny pomiar · orientacyjnie</small><strong>{duration(view.activeSeconds)}</strong></div>
            <div><small>Łącznie z aktywnym pomiarem</small><strong>{duration(view.liveSeconds)}</strong></div>
            <div><small>Średnio na dzień z pracą</small><strong>{view.averageSeconds === null ? 'Brak danych' : duration(view.averageSeconds)}</strong></div>
            <div><small>Czas rozliczalny</small><strong>{duration(view.billableSeconds)}</strong>
              <small>{view.liveSeconds ? `${new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 }).format(100 * view.billableSeconds / view.liveSeconds)}% czasu` : 'Brak danych'}</small></div>
          </div>
          {view.liveDays.length === 0 ? <p className="muted">Brak zatwierdzonego lub aktywnego czasu w wybranym zakresie.</p> :
            <div className="table-wrap"><table><thead><tr><th scope="col">Dzień</th><th scope="col">Czas z aktywnym pomiarem</th></tr></thead>
              <tbody>{view.liveDays.map(day => <tr key={day.date}><td>{day.date}</td><td className="duration">{duration(day.seconds)}</td></tr>)}</tbody></table></div>}
        </> : <ReportDetails key={`details:${scope}`} rows={view.rows}
          finalizedSeconds={view.finalizedSeconds} zone={data.time_zone} onEdit={onEditEntry} onHistory={onShowHistory} />}
        <ReportExport key={`export:${scope}`} client={client} from={range.from}
          through={range.through} zone={data.time_zone} expectedRows={view.finalizedRows} incomplete={incomplete} />
      </>}
    </>}
  </section>;
}
