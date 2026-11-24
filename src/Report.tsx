import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dateInZone, validTimeZone } from './reportTime';
import { reportPresetRange, reportPresets } from './reportPresets';
import type { ReportPreset } from './reportPresets';
import { readReportFilter, validReportFilter } from './reportFilterStorage';
import type { SavedReportFilter } from './reportFilterStorage';
import ReportExport from './ReportExport';
import ReportDetails from './ReportDetails';
import ReportTimezone from './ReportTimezone';
import { formatDuration as duration } from './reportCsv';
import { makeReportView } from './reportView';
import type { ActiveReportEntry, CompletedReportEntry } from './reportView';
import { allReportClients, changeReportScope, resolveReportScope } from './reportScope';
import type { ReportCatalog, ReportScope } from './reportScope';
import { clientLabels } from './clientLabels';
import ReportGlance from './ReportGlance';
import ReportSummary from './ReportSummary';
import { entryRelations } from './reportSummaryModel';
import type { AllClientsReport } from './useAllClientsReport';

type Data = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };
type Props = ReportCatalog & {
  loaded: boolean;
  revision: number;
  /** The main window's shared all-clients read for the closed-report card (one source, no second poll). */
  summary: AllClientsReport;
  hasUnsavedEdit: () => boolean;
  onEditEntry: (entryId: number) => void;
  onShowHistory: (entryId: number) => void;
};

const defaultZone = 'Europe/Warsaw';
const archivedName = (name: string, archived?: boolean) => archived ? `${name} (Zarchiwizowany)` : name;

export default function Report({ clients, projects, tasks, loaded, revision, summary, hasUnsavedEdit, onEditEntry, onShowHistory }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'summary' | 'details'>('summary');
  const [initialFilter] = useState(() => { try { return readReportFilter(window.localStorage); } catch { return { filter: null, problem: true }; } });
  const [customRange, setCustomRange] = useState(() => initialFilter.filter?.kind === 'custom'
    ? { from: initialFilter.filter.from, through: initialFilter.filter.through }
    : reportPresetRange('today', Date.now(), defaultZone));
  const [preset, setPreset] = useState<ReportPreset | 'custom'>(() => initialFilter.filter?.kind ?? 'today');
  const [filterReady, setFilterReady] = useState(false);
  const [dateReadProblem, setDateReadProblem] = useState(false);
  const [dateSaveProblem, setDateSaveProblem] = useState(false);
  const [scopeReady, setScopeReady] = useState(false);
  const [scopeReadProblem, setScopeReadProblem] = useState('');
  const [scopeSaveProblem, setScopeSaveProblem] = useState(false);
  const [scopeNotice, setScopeNotice] = useState('');
  const [filterChangeBlocked, setFilterChangeBlocked] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [reportScope, setReportScope] = useState(allReportClients);
  const [snapshot, setSnapshot] = useState<{ request: string; data: Data } | null>(null);
  const [failure, setFailure] = useState<{ request: string; message: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const request = JSON.stringify([revision, refresh, reportScope]);
  const [lastZone, setLastZone] = useState(defaultZone);
  const pendingFilterSave = useRef(Promise.resolve());
  const pendingScopeSave = useRef(Promise.resolve());
  const catalog = useMemo(() => ({ clients, projects, tasks }), [clients, projects, tasks]);
  const resolved = useMemo(() => resolveReportScope(reportScope, catalog), [reportScope, catalog]);
  const scopeProblem = scopeReadProblem || (loaded ? resolved.problem : '');
  const customInvalid = preset === 'custom' && !validReportFilter({ kind: 'custom', ...customRange });
  const canQuery = open && loaded && filterReady && scopeReady && !scopeProblem && !dateReadProblem && !customInvalid;
  const data = canQuery && snapshot?.request === request ? snapshot.data : null;
  const error = canQuery && failure?.request === request ? failure.message : '';
  const range = preset === 'custom' ? customRange : reportPresetRange(preset, now, lastZone);

  useEffect(() => {
    let disposed = false;
    void invoke<SavedReportFilter | null>('get_report_filter', { legacyFilter: initialFilter.filter })
      .then(filter => {
        if (disposed) return;
        if (filter) {
          setNow(Date.now());
          setPreset(filter.kind);
          if (filter.kind === 'custom') {
            setCustomRange({ from: filter.from, through: filter.through });
          }
        }
        setDateReadProblem(!filter && initialFilter.problem);
      })
      .catch(() => { if (!disposed) setDateReadProblem(true); })
      .finally(() => { if (!disposed) setFilterReady(true); });
    return () => { disposed = true; };
  }, [initialFilter]);

  useEffect(() => {
    let disposed = false;
    void invoke<ReportScope | null>('get_report_scope')
      .then(scope => { if (!disposed && scope) setReportScope(scope); })
      .catch(problem => { if (!disposed) setScopeReadProblem(String(problem)); })
      .finally(() => { if (!disposed) setScopeReady(true); });
    return () => { disposed = true; };
  }, []);

  function rememberFilter(filter: SavedReportFilter) {
    if (!validReportFilter(filter)) return;
    setDateReadProblem(false);
    setDateSaveProblem(false);
    pendingFilterSave.current = pendingFilterSave.current
      .then(() => invoke<void>('set_report_filter', { filter }))
      .then(() => setDateSaveProblem(false), () => setDateSaveProblem(true));
  }

  function choosePeriod(kind: ReportPreset | 'custom') {
    setNow(Date.now());
    setPreset(kind);
    if (kind === 'custom') {
      setCustomRange(range);
      rememberFilter({ kind, ...range });
    } else {
      rememberFilter({ kind });
    }
  }

  function changeRange(field: 'from' | 'through', value: string) {
    if (!allowFilterChange()) return;
    const next = { ...range, [field]: value };
    setPreset('custom');
    setCustomRange(next);
    rememberFilter({ kind: 'custom', ...next });
  }

  function rememberScope(scope: ReportScope, message = '') {
    setReportScope(scope);
    setScopeNotice(message);
    if (resolveReportScope(scope, catalog).problem) return;
    setScopeReadProblem('');
    setScopeSaveProblem(false);
    pendingScopeSave.current = pendingScopeSave.current
      .then(() => invoke<void>('set_report_scope', { scope }))
      .then(() => setScopeSaveProblem(false), () => setScopeSaveProblem(true));
  }

  useEffect(() => {
    if (!canQuery) { setSnapshot(null); return; }
    let cancelled = false;
    let timer: number | undefined;
    async function update() {
      try {
        const next = await invoke<Data>('get_report_data', { scope: reportScope });
        if (!cancelled) {
          setSnapshot({ request, data: next });
          setFailure(null);
          if (validTimeZone(next.time_zone)) setLastZone(next.time_zone);
        }
      } catch (e) {
        if (!cancelled) { setSnapshot(null); setFailure({ request, message: `Nie można odczytać raportu: ${String(e)}` }); }
      } finally {
        if (!cancelled) timer = window.setTimeout(update, 5000);
      }
    }
    void update();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [canQuery, request, reportScope]);

  useEffect(() => {
    const zone = data?.time_zone ?? '';
    if (!open || preset === 'custom' || !zone || !validTimeZone(zone)) return;
    function updateToday() {
      if (hasUnsavedEdit()) return;
      const current = Date.now();
      setNow(previous => dateInZone(previous, zone) === dateInZone(current, zone) ? previous : current);
    }
    updateToday();
    const timer = window.setInterval(updateToday, 1000);
    window.addEventListener('focus', updateToday);
    document.addEventListener('visibilitychange', updateToday);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', updateToday);
      document.removeEventListener('visibilitychange', updateToday);
    };
  }, [open, preset, data?.time_zone, hasUnsavedEdit]);

  const result = useMemo(() => {
    if (!data) return null;
    if (!validTimeZone(data.time_zone)) return { error: 'Zapisana strefa raportu nie jest obsługiwana.' };
    if (!validReportFilter({ kind: 'custom', ...range })) {
      return { error: 'Podaj poprawny zakres dat od 1970 roku. Data końcowa nie może być wcześniejsza niż początkowa.' };
    }
    try {
      return { view: makeReportView(data, catalog, reportScope, range.from, range.through) };
    } catch (problem) {
      return { error: problem instanceof Error ? problem.message : 'Nie udało się obliczyć raportu.' };
    }
  }, [data, range.from, range.through, catalog, reportScope]);
  const view = result?.view;
  const incomplete = !!view && (view.excludedEntryIds.length > 0 || view.missingRelations);
  const viewKey = JSON.stringify([reportScope, range.from, range.through, data?.time_zone]);
  const projectChoices = projects.filter(item => Number(item.client_id) === reportScope.clientId);
  const taskChoices = tasks.filter(item => Number(item.project_id) === reportScope.projectId);
  const validProject = projectChoices.some(item => Number(item.id) === reportScope.projectId);
  const validTask = taskChoices.some(item => Number(item.id) === reportScope.taskId);
  const clientArchived = resolved.client?.archived;
  const projectArchived = clientArchived || resolved.project?.archived;
  const clientLabelById = useMemo(() => clientLabels(clients), [clients]);
  const selectedClientLabel = resolved.client ? clientLabelById.get(String(resolved.client.id)) : undefined;
  const relations = useMemo(() => entryRelations([...(data?.entries ?? []), ...(data?.active ? [data.active] : [])]), [data]);
  const clientLabelByEntry = useMemo(() => {
    const projectOwners = new Map(projects.map(project => [String(project.id), String(project.client_id)]));
    const labels = new Map<number, string>();
    for (const entry of [...(data?.entries ?? []), ...(data?.active ? [data.active] : [])]) {
      const ownerId = projectOwners.get(String(entry.project_id));
      const label = ownerId ? clientLabelById.get(ownerId) : undefined;
      if (label) labels.set(entry.id, label);
    }
    return labels;
  }, [data, projects, clientLabelById]);

  function changeScope(field: keyof ReportScope, value: string) {
    if (!allowFilterChange()) return;
    const next = changeReportScope(reportScope, field, value ? Number(value) : null, catalog);
    rememberScope(next.scope, next.message);
  }

  function allowFilterChange() {
    const blocked = hasUnsavedEdit();
    setFilterChangeBlocked(blocked);
    return !blocked;
  }

  return <section className="card report" aria-label="Raport czasu">
    <div className="section-top"><div><p className="section-kicker">PODSUMOWANIE PRACY</p><h2>Raport czasu</h2></div><button type="button" className="secondary report-button" aria-expanded={open} onClick={() => {
      if (!open && !hasUnsavedEdit()) setNow(Date.now());
      setOpen(!open);
    }}>{open ? 'Zamknij raport' : 'Otwórz raport'}</button></div>
    {!open && <ReportGlance catalog={catalog} loaded={loaded} summary={summary} />}
    {open && <>
      <p className="muted">Czas według dni w strefie {data?.time_zone || 'raportowania'}. Zmiana strefy komputera nie zmienia raportu.</p>
      {data && <ReportTimezone currentZone={data.time_zone} canChange={allowFilterChange}
        onApply={async (expectedTimeZone, timeZone) => {
          await invoke('set_report_timezone', { expectedTimeZone, timeZone });
          setNow(Date.now());
          setRefresh(previous => previous + 1);
        }} />}
      <div className="selectors report-filters" role="group" aria-label="Okres raportu">
        <div><label htmlFor="report-period">Zakres dat</label><select id="report-period" value={dateReadProblem ? '' : preset} disabled={!filterReady}
          onChange={event => { if (allowFilterChange()) choosePeriod(event.target.value as ReportPreset | 'custom'); }}>
          {dateReadProblem && <option value="" disabled>Wybierz okres</option>}
          {reportPresets.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          <option value="custom">Zakres własny</option>
        </select></div>
        <label>Od<input type="date" disabled={!filterReady} aria-invalid={customInvalid || undefined} value={range.from}
          onChange={event => changeRange('from', event.target.value)} /></label>
        <label>Do<input type="date" disabled={!filterReady} aria-invalid={customInvalid || undefined} value={range.through}
          onChange={event => changeRange('through', event.target.value)} /></label>
      </div>
      <div className="selectors report-filters" role="group" aria-label="Zakres danych raportu">
        <div><label htmlFor="report-client">Klient</label><select id="report-client" disabled={!loaded || !scopeReady} value={scopeReadProblem ? 'unknown' : reportScope.clientId ?? ''}
          onChange={event => changeScope('clientId', event.target.value)}>
          {scopeReadProblem && <option value="unknown" disabled>Wybierz klienta</option>}
          {reportScope.clientId !== null && !resolved.client &&
            <option value={reportScope.clientId} disabled>Zapisany klient jest niedostępny</option>}
          <option value="">Wszyscy klienci</option>
          {clients.map(item => <option key={item.id} value={item.id}>{archivedName(clientLabelById.get(String(item.id)) ?? item.name, item.archived)}</option>)}
        </select></div>
        <div><label htmlFor="report-project">Projekt</label><select id="report-project" disabled={!loaded || !scopeReady || !!scopeReadProblem || !resolved.client} value={reportScope.projectId ?? ''}
          onChange={event => changeScope('projectId', event.target.value)}>
          {reportScope.projectId !== null && !validProject &&
            <option value={reportScope.projectId} disabled>Zapisany projekt jest niedostępny</option>}
          <option value="">{!resolved.client ? 'Najpierw wybierz klienta' : projectChoices.length ? 'Wszystkie projekty' : 'Brak projektów'}</option>
          {projectChoices.map(item => <option key={item.id} value={item.id}>{archivedName(item.name, clientArchived || item.archived)}</option>)}
        </select></div>
        <div><label htmlFor="report-task">Zadanie</label><select id="report-task" disabled={!loaded || !scopeReady || !!scopeReadProblem || !validProject}
          value={reportScope.taskId ?? ''} onChange={event => changeScope('taskId', event.target.value)}>
          {reportScope.taskId !== null && !validTask &&
            <option value={reportScope.taskId} disabled>Zapisane zadanie jest niedostępne</option>}
          <option value="">{!validProject ? 'Najpierw wybierz projekt' : taskChoices.length ? 'Wszystkie zadania i wpisy bez zadania' : 'Wpisy bez zadania'}</option>
          {taskChoices.map(item => <option key={item.id} value={item.id}>{archivedName(item.name, projectArchived || item.archived)}</option>)}
        </select></div>
      </div>
      <button className="secondary report-button" type="button" disabled={!loaded || !scopeReady || !filterReady} onClick={() => {
        if (!allowFilterChange()) return;
        choosePeriod('today');
        rememberScope(allReportClients);
      }}>Wyczyść filtry</button>
      {filterChangeBlocked && hasUnsavedEdit() && <p role="alert" className="alert error">Masz niezapisane zmiany. Zapisz lub anuluj edycję wpisu, aby zmienić filtr.</p>}
      {scopeNotice && <p role="status">{scopeNotice}</p>}
      {scopeProblem && <p role="alert" className="alert error">{scopeProblem} Popraw filtr, aby wyświetlić raport i przygotować CSV.</p>}
      {dateReadProblem && <p role="alert" className="alert error">Nie udało się odczytać zakresu dat. Wybierz okres, aby wyświetlić raport.</p>}
      {customInvalid && <p role="alert" className="alert error">Podaj poprawny zakres dat od 1970 roku. Data końcowa nie może być wcześniejsza niż początkowa.</p>}
      {(dateSaveProblem || scopeSaveProblem) && <p role="alert" className="alert error">Nie udało się zapamiętać wyboru filtrów. Po ponownym uruchomieniu aplikacja odczyta ostatni zapis.</p>}
      {!loaded && <p role="status">Odśwież dane aplikacji, aby wyświetlić raport.</p>}
      {error && <div role="alert" className="alert error">{error} <button type="button" onClick={() => setRefresh(n => n + 1)}>Ponów</button></div>}
      {loaded && (!scopeReady || !filterReady || (canQuery && !data && !error)) && <p role="status">Wczytywanie raportu…</p>}
      {result?.error && <div role="alert" className="alert error">{result.error}</div>}
      {view && data && <>
        <ul className="report-scope-summary" aria-label="Aktywne filtry raportu">
          <li>{resolved.client ? archivedName(selectedClientLabel ?? resolved.client.name, clientArchived) : 'Wszyscy klienci'}</li>
          {resolved.project && <li>{archivedName(resolved.project.name, projectArchived)}</li>}
          {resolved.task && <li>{archivedName(resolved.task.name, projectArchived || resolved.task.archived)}</li>}
        </ul>
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
        {view.pendingPeriodCount > 0 && <p role="status" className="alert">
          Okresy uśpienia do rozstrzygnięcia ({view.pendingPeriodCount}) <strong>{duration(view.pendingSeconds)}</strong>
        </p>}
        {view.awaitingSeconds > 0 && <p role="status" className="alert">
          W łącznym czasie uwzględniono <strong>{duration(view.awaitingSeconds)}</strong> pracy z wpisów oczekujących na decyzję o uśpieniu. Wpisy będą dostępne w CSV po rozstrzygnięciu przerw.
        </p>}
        {view.active?.unresolved && <div role="alert" className="alert error">Aktywny pomiar wymaga weryfikacji lub sprawdzenia zegara.</div>}
        <div className="report-presets" role="group" aria-label="Widok raportu">
          <button type="button" className="secondary report-button" aria-pressed={tab === 'summary'} onClick={() => setTab('summary')}>Podsumowanie</button>
          <button type="button" className="secondary report-button" aria-pressed={tab === 'details'} onClick={() => setTab('details')}>Szczegóły</button>
        </div>
        {tab === 'summary' ? <>
          <ReportSummary key={`summary:${viewKey}`} view={view} relations={relations} catalog={catalog} clientLabelById={clientLabelById}
            from={range.from} through={range.through} incomplete={incomplete} />
          {view.liveDays.length === 0 ? <p className="muted">Brak czasu pracy w wybranym zakresie.</p> :
            <div className="table-wrap"><table><thead><tr><th scope="col">Dzień</th><th scope="col">Czas z aktywnym pomiarem</th></tr></thead>
              <tbody>{view.liveDays.map(day => <tr key={day.date}><td>{day.date}</td><td className="duration">{duration(day.seconds)}</td></tr>)}</tbody></table></div>}
        </> : <ReportDetails key={`details:${viewKey}`} rows={view.rows} clientLabelByEntry={clientLabelByEntry}
          finalizedSeconds={view.finalizedSeconds} liveSeconds={view.liveSeconds} zone={data.time_zone} onEdit={onEditEntry} onHistory={onShowHistory} />}
        <ReportExport key={`export:${viewKey}`} scope={reportScope} from={range.from}
          through={range.through} zone={data.time_zone} expectedRows={view.finalizedRows} incomplete={incomplete} clientLabel={selectedClientLabel} clientName={resolved.client?.name} />
      </>}
    </>}
  </section>;
}
