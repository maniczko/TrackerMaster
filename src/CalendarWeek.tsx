import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { calendarWeek, clockText, DAY_MINUTES, pieceRange, shiftWeek, validCalendarDate, weekLabel, weekStartOf } from './calendarModel';
import type { CalendarBillable, CalendarBlock, CalendarClockEntry, CalendarFilter } from './calendarModel';
import { formatDuration as duration } from './reportCsv';
import { dateInZone } from './reportTime';
import { allReportClients, changeReportScope, resolveReportScope } from './reportScope';
import type { ReportCatalog, ReportScope } from './reportScope';
import type { AllClientsReport } from './useAllClientsReport';
import { clientLabels } from './clientLabels';
import './calendar.css';

type Props = {
  report: AllClientsReport; catalog: ReportCatalog; loaded: boolean; now: number;
  snapshotActive: CalendarClockEntry | null; snapshotFresh: boolean;
};

// Convenience only (DEV-28): the last week and filters. Never a source of data; failures are ignored.
const STORAGE_KEY = 'trackermaster.calendar.v1';
type Saved = { week?: string; scope?: ReportScope; billable?: CalendarBillable };
function readSaved(): Saved {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return {};
    const id = (item: unknown) => item === null || (Number.isSafeInteger(item) && (item as number) > 0);
    const scope = value.scope && id(value.scope.clientId) && id(value.scope.projectId) && id(value.scope.taskId) ? value.scope as ReportScope : undefined;
    return { week: validCalendarDate(value.week) ? weekStartOf(value.week) : undefined, scope,
      billable: ['all', 'billable', 'nonbillable'].includes(value.billable) ? value.billable : undefined };
  } catch { return {}; }
}
function save(value: Saved) { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* convenience only */ } }

const HOUR_PX = 60;
const MINUTE_PX = HOUR_PX / 60;
const weekday = new Intl.DateTimeFormat('pl-PL', { weekday: 'short', timeZone: 'UTC' });
const dayNumber = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
const utc = (date: string) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fullDate = (ms: number, zone: string) => new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(ms);
const kindLabel = { work: '', pending: 'Uśpienie do rozstrzygnięcia, nie wliczone do sum', unverified: 'Pomiar do weryfikacji, nie wliczony do sum' };

function blockLabel(block: CalendarBlock): string {
  const state = block.kind !== 'work' ? kindLabel[block.kind] : block.running ? `w trakcie, ${duration(block.seconds)} w tym dniu` : duration(block.seconds);
  return `${block.title} — ${block.path}, ${pieceRange(block)}, ${state}`;
}

export default function CalendarWeek({ report, catalog, loaded, now, snapshotActive, snapshotFresh }: Props) {
  const [saved] = useState(readSaved);
  const zone = report.read?.data.time_zone;
  const today = zone ? (() => { try { return dateInZone(now, zone); } catch { return null; } })() : null;
  const [week, setWeek] = useState<string | null>(saved.week ?? null);
  const [scope, setScope] = useState<ReportScope>(saved.scope ?? allReportClients);
  const [billable, setBillable] = useState<CalendarBillable>(saved.billable ?? 'all');
  const [selected, setSelected] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState('');
  const shownWeek = week ?? (today ? weekStartOf(today) : null);
  const blockRefs = useRef(new Map<string, HTMLButtonElement>());
  const body = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef('');

  useEffect(() => { if (shownWeek) save({ week: shownWeek, scope, billable }); }, [shownWeek, scope, billable]);

  const resolved = useMemo(() => resolveReportScope(scope, catalog), [scope, catalog]);
  const filter: CalendarFilter = { scope, billable };
  const view = useMemo(() => {
    if (!report.read || !shownWeek || resolved.problem) return null;
    try { return calendarWeek({ data: report.read.data, catalog, filter, weekStart: shownWeek, now, snapshotActive, snapshotFresh }); }
    catch { return null; }
  }, [report.read, catalog, scope, billable, shownWeek, now, snapshotActive, snapshotFresh, resolved.problem]);
  const blocks = view ? view.days.flatMap(day => day.blocks) : [];
  const chosen = blocks.find(block => block.key === selected) ?? null;
  const filtered = scope.clientId !== null || billable !== 'all';
  const clientLabelById = useMemo(() => clientLabels(catalog.clients as { id: number | string; name: string }[]), [catalog.clients]);

  // Scroll once per week: to the current hour this week, else to the first entry, else to 07:00.
  useLayoutEffect(() => {
    if (!view || !body.current || scrolledFor.current === view.from) return;
    scrolledFor.current = view.from;
    const first = Math.min(...blocks.map(block => block.top), Infinity);
    const minute = view.nowMinute !== null ? view.nowMinute - 120 : Number.isFinite(first) ? first - 30 : 7 * 60;
    body.current.scrollTop = Math.max(0, minute) * MINUTE_PX;
  });
  useEffect(() => { if (chosen) dialog.current?.focus(); }, [chosen?.key]);
  useEffect(() => { if (selected && !chosen) setSelected(null); }, [selected, chosen]);

  function close() {
    const key = selected;
    setSelected(null);
    if (key) window.setTimeout(() => blockRefs.current.get(key)?.focus(), 0);
  }
  function onDialogKey(event: ReactKeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); close(); } }
  function go(next: string | null) { setSelected(null); setWeek(next); }
  function changeScope(field: keyof ReportScope, value: string) {
    const next = changeReportScope(scope, field, value ? Number(value) : null, catalog);
    setScope(next.scope); setScopeNotice(next.message);
  }
  const projectChoices = catalog.projects.filter(item => Number(item.client_id) === scope.clientId);
  const taskChoices = catalog.tasks.filter(item => Number(item.project_id) === scope.projectId);

  return <section className="card calendar" aria-label="Kalendarz">
    <div className="calendar-toolbar">
      <div className="calendar-nav" role="group" aria-label="Wybór tygodnia">
        <button type="button" className="secondary" aria-label="Poprzedni tydzień" disabled={!shownWeek} onClick={() => shownWeek && go(shiftWeek(shownWeek, -1))}>‹</button>
        <button type="button" className="secondary" aria-label="Następny tydzień" disabled={!shownWeek} onClick={() => shownWeek && go(shiftWeek(shownWeek, 1))}>›</button>
        <button type="button" className="secondary" disabled={!today || (!!shownWeek && !!today && weekStartOf(today) === shownWeek)} onClick={() => go(null)}>Dziś</button>
        <label className="calendar-date">Przejdź do dnia<input type="date" value={shownWeek ?? ''} min="1970-01-05"
          onChange={event => { if (validCalendarDate(event.target.value)) go(weekStartOf(event.target.value)); }} /></label>
      </div>
      <div className="calendar-heading">
        <h2>{view ? weekLabel(view.from, view.through) : 'Tydzień'}</h2>
        <p><span>Suma tygodnia</span> <strong className="calendar-week-total" aria-live="off">{view ? duration(view.weekSeconds) : '—'}</strong></p>
      </div>
    </div>
    <div className="selectors calendar-filters" role="group" aria-label="Filtry kalendarza">
      <label>Klient<select value={scope.clientId ?? ''} onChange={event => changeScope('clientId', event.target.value)}>
        <option value="">Wszyscy klienci</option>
        {catalog.clients.map(item => <option key={item.id} value={item.id}>{clientLabelById.get(String(item.id)) ?? item.name}{item.archived ? ' (archiwum)' : ''}</option>)}
      </select></label>
      <label>Projekt<select value={scope.projectId ?? ''} disabled={!resolved.client} onChange={event => changeScope('projectId', event.target.value)}>
        <option value="">{resolved.client ? 'Wszystkie projekty' : 'Najpierw wybierz klienta'}</option>
        {projectChoices.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (archiwum)' : ''}</option>)}
      </select></label>
      <label>Zadanie<select value={scope.taskId ?? ''} disabled={!resolved.project} onChange={event => changeScope('taskId', event.target.value)}>
        <option value="">{resolved.project ? 'Wszystkie zadania i wpisy bez zadania' : 'Najpierw wybierz projekt'}</option>
        {taskChoices.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (archiwum)' : ''}</option>)}
      </select></label>
      <label>Rozliczalność<select value={billable} onChange={event => setBillable(event.target.value as CalendarBillable)}>
        <option value="all">Wszystkie wpisy</option><option value="billable">Tylko rozliczalne</option><option value="nonbillable">Tylko nierozliczalne</option>
      </select></label>
    </div>
    <p className="helper calendar-scope-note">{filtered ? 'Sumy dotyczą wybranych filtrów, tak jak w raporcie z tymi samymi filtrami.' : 'Sumy dla wszystkich klientów, tak jak w raporcie. Czas w strefie raportu'}{zone ? ` (${zone}).` : '.'}{' '}Kalendarz tylko pokazuje wpisy; edycja jest w Historii.</p>
    {scopeNotice && <p role="status" className="helper">{scopeNotice}</p>}
    {resolved.problem && <p role="alert" className="alert error">{resolved.problem} Wybierz inny filtr.</p>}
    {!loaded ? <p role="status" className="alert error">Dane nie są aktualne. Odczytaj je ponownie w widoku Timer.</p>
      : report.failed ? <p role="alert" className="alert error">Nie udało się odczytać wpisów do kalendarza. Spróbuj ponownie za chwilę.</p>
      : !report.read ? <p role="status" className="calendar-loading">Wczytywanie kalendarza…</p>
      : !view ? <p role="alert" className="alert error">Nie można przygotować tego tygodnia (strefa raportu lub data są nieprawidłowe).</p>
      : <>
        {(view.excludedEntryIds.length > 0 || view.missingRelations) && <p role="alert" className="alert error">
          <strong>Suma jest niepełna.</strong> {view.excludedEntryIds.length > 0 && <>Nie można bezpiecznie przypisać do dni wpisów {view.excludedEntryIds.join(', ')}. </>}{view.missingRelations && 'Sprawdź powiązanie wpisów z klientem i projektem.'}</p>}
        {view.overlapEntryIds.length > 0 && <p role="alert" className="alert error"><strong>Nakładające się pomiary</strong> ({view.overlapEntryIds.join(', ')}) są pokazane obok siebie. Suma może liczyć ten sam czas więcej niż raz.</p>}
        {view.pendingPeriodCount > 0 && <p role="status" className="alert">Uśpienie do rozstrzygnięcia ({view.pendingPeriodCount}) <strong>{duration(view.pendingSeconds)}</strong> jest zakreskowane i nie wlicza się do sum.</p>}
        {view.unverifiedActive && <p role="status" className="alert">Aktywny pomiar wymaga weryfikacji. Jest zakreskowany i nie wlicza się do sum.</p>}
        <div className="calendar-grid">
          <div className="calendar-body" ref={body} tabIndex={-1}>
          <div className="calendar-head" aria-hidden="true">
            <span />
            {view.days.map(day => <span key={day.date} className={day.isToday ? 'calendar-day-head is-today' : 'calendar-day-head'}>
              <small>{weekday.format(utc(day.date))}</small> <strong>{dayNumber.format(utc(day.date))}</strong>
              <span className="calendar-day-total">{duration(day.seconds)}</span></span>)}
          </div>
            <div className="calendar-canvas" style={{ height: DAY_MINUTES * MINUTE_PX }}>
              <div className="calendar-hours" aria-hidden="true">{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: hour * HOUR_PX }}>{String(hour).padStart(2, '0')}:00</span>)}</div>
              {view.days.map(day => <div key={day.date} className={day.isToday ? 'calendar-column is-today' : 'calendar-column'} role="group"
                aria-label={`${new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utc(day.date))}: ${duration(day.seconds)}, wpisów ${day.blocks.length}`}>
                {day.blocks.length === 0 && <span className="calendar-empty-day">Brak wpisów</span>}
                {day.blocks.map(block => <button key={block.key} type="button" ref={node => { if (node) blockRefs.current.set(block.key, node); else blockRefs.current.delete(block.key); }}
                  className="calendar-block" data-kind={block.kind} data-size={(block.bottom - block.top) * MINUTE_PX < 44 ? "short" : undefined} data-running={block.running || undefined} data-project-colour={block.colour}
                  aria-label={blockLabel(block)} title={`${block.title}\n${block.path}\n${pieceRange(block)}`} aria-haspopup="dialog" aria-expanded={selected === block.key}
                  style={{ top: block.top * MINUTE_PX, height: (block.bottom - block.top) * MINUTE_PX, left: `${(100 * block.lane) / block.lanes}%`, width: `${100 / block.lanes}%` }}
                  onClick={() => setSelected(block.key === selected ? null : block.key)}>
                  {(block.bottom - block.top) * MINUTE_PX < 44
                    ? <strong>{block.title} <small>{pieceRange(block)}</small></strong>
                    : <><strong>{block.title}</strong><span>{block.path}</span><small>{pieceRange(block)}</small></>}
                </button>)}
                {day.isToday && view.nowMinute !== null && <span className="calendar-now" style={{ top: view.nowMinute * MINUTE_PX }} aria-hidden="true" />}
              </div>)}
            </div>
          </div>
        </div>
        {blocks.length === 0 && <p className="muted calendar-empty">W tym tygodniu nie ma wpisów{filtered ? ' dla wybranych filtrów' : ''}.</p>}
        {chosen && view && <div className="calendar-details" role="dialog" aria-modal="false" aria-labelledby="calendar-details-title" tabIndex={-1} ref={dialog} onKeyDown={onDialogKey}>
          <div className="section-top"><h3 id="calendar-details-title">{chosen.title}</h3><button type="button" className="secondary" onClick={close}>Zamknij</button></div>
          <dl>
            <dt>Klient / projekt</dt><dd>{chosen.path}</dd>
            <dt>Wpis</dt><dd>{fullDate(chosen.entryStartMs, view.zone)} – {chosen.entryEndMs === null ? 'trwa' : fullDate(chosen.entryEndMs, view.zone)}</dd>
            <dt>Czas wpisu</dt><dd>{chosen.entrySeconds === null ? (chosen.kind === 'unverified' ? 'do weryfikacji' : 'w trakcie') : duration(chosen.entrySeconds)}</dd>
            <dt>Ten dzień</dt><dd>{pieceRange(chosen)}{chosen.kind === 'work' ? ` · ${duration(chosen.seconds)}` : ''}</dd>
            <dt>Rozliczalność</dt><dd>{chosen.billable ? 'Rozliczalny' : 'Nierozliczalny'}</dd>
          </dl>
          {chosen.kind === 'pending' && <p className="alert">Uśpienie do rozstrzygnięcia nie wlicza się do sum. Rozstrzygnij je na liście okresów uśpienia w widoku Timer.</p>}
          {chosen.kind === 'unverified' && <p className="alert">Pomiar wymaga weryfikacji i nie wlicza się do sum. Rozlicz go w widoku Timer.</p>}
          {chosen.running && chosen.kind === 'work' && <p className="helper">Pomiar trwa od {clockText(chosen.entryStartMs, view.zone)}. Czas zapisze się przy zatrzymaniu.</p>}
          <p className="helper">Edycja z kalendarza będzie w kolejnym pakiecie. Teraz popraw wpis w Historii.</p>
        </div>}
      </>}
  </section>;
}
