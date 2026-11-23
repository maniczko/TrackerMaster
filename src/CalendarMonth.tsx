import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { CalendarBillable, CalendarClockEntry, CalendarFilter } from './calendarModel';
import { calendarMonth, hoursMinutes, monthLabel, monthOf, moveDay, shiftMonth, validCalendarMonth } from './calendarMonthModel';
import type { MonthCell, MonthCellEntry } from './calendarMonthModel';
import { formatDuration as duration } from './reportCsv';
import { dateInZone } from './reportTime';
import { allReportClients, resolveReportScope } from './reportScope';
import type { ReportCatalog, ReportScope } from './reportScope';
import type { AllClientsReport } from './useAllClientsReport';
import CalendarFilters from './CalendarFilters';
import { readSaved, save } from './CalendarWeek';
import './calendar.css';
import './calendarMonth.css';

// DEV-25 / PTT-46: the month as a Mon–Sun grid of day totals (an aggregate view; hourly blocks stay
// in the week). Read only: a day opens its list of entries and leads to the week of that day.
type Props = {
  report: AllClientsReport; catalog: ReportCatalog; loaded: boolean; now: number;
  snapshotActive: CalendarClockEntry | null; snapshotFresh: boolean;
  viewSwitch?: ReactNode; onOpenWeek: (date: string) => void;
};

const weekdays = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd'];
const utc = (date: string) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const longDate = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const entryWord = (count: number) => count === 1 ? 'wpis' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'wpisy' : 'wpisów';
const kindNote = { work: '', pending: 'uśpienie do rozstrzygnięcia, nie wliczone', unverified: 'do weryfikacji, nie wliczone' };

function scopeNote(filtered: boolean, zone: string | undefined): string {
  return `${filtered ? 'Sumy dotyczą wybranych filtrów, tak jak raport z tymi samymi filtrami.' : 'Sumy dla wszystkich klientów, tak jak w raporcie.'} Dni w strefie raportu${zone ? ` (${zone})` : ''}. Suma miesiąca obejmuje tylko dni tego miesiąca. Uśpienie do rozstrzygnięcia i pomiar do weryfikacji nie wliczają się do sum. Kalendarz tylko pokazuje wpisy; edycja jest w Historii.`;
}
function cellLabel(cell: MonthCell): string {
  const count = cell.entries.length;
  return `${longDate.format(utc(cell.date))}${cell.isToday ? ' (dziś)' : ''}${cell.inMonth ? '' : ', inny miesiąc'}: ${duration(cell.seconds)}, ${count ? `${count} ${entryWord(count)}` : 'brak wpisów'}`;
}
function entryState(item: MonthCellEntry): string {
  if (item.kind !== 'work') return kindNote[item.kind];
  return item.running ? `w trakcie, ${duration(item.seconds)} w tym dniu` : duration(item.seconds);
}

export default function CalendarMonth({ report, catalog, loaded, now, snapshotActive, snapshotFresh, viewSwitch, onOpenWeek }: Props) {
  const [saved] = useState(readSaved);
  const zone = report.read?.data.time_zone;
  const today = zone ? (() => { try { return dateInZone(now, zone); } catch { return null; } })() : null;
  const [month, setMonth] = useState<string | null>(validCalendarMonth(saved.month) ? saved.month : null);
  const [scope, setScope] = useState<ReportScope>(saved.scope ?? allReportClients);
  const [billable, setBillable] = useState<CalendarBillable>(saved.billable ?? 'all');
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const shownMonth = month ?? (today ? monthOf(today) : null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const details = useRef<HTMLDivElement>(null);
  const focusAfterRender = useRef<string | null>(null);

  useEffect(() => { if (shownMonth) save({ month: shownMonth, scope, billable }); }, [shownMonth, scope, billable]);

  const resolved = useMemo(() => resolveReportScope(scope, catalog), [scope, catalog]);
  const filter: CalendarFilter = { scope, billable };
  const view = useMemo(() => {
    if (!report.read || !shownMonth || resolved.problem) return null;
    try { return calendarMonth({ data: report.read.data, catalog, filter, month: shownMonth, now, snapshotActive, snapshotFresh }); }
    catch { return null; }
  }, [report.read, catalog, scope, billable, shownMonth, now, snapshotActive, snapshotFresh, resolved.problem]);
  const allCells = view ? view.weeks.flat() : [];
  const chosen = allCells.find(cell => cell.date === selected) ?? null;
  // One cell is in the tab order (roving focus): the focused day, else the selected day, today or the 1st.
  const tabDate = [focused, selected, view && today && allCells.some(cell => cell.date === today && cell.inMonth) ? today : null, view?.from]
    .find(date => date && allCells.some(cell => cell.date === date)) ?? null;
  const filtered = scope.clientId !== null || billable !== 'all';

  useEffect(() => {
    const date = focusAfterRender.current;
    if (date && cellRefs.current.has(date)) { focusAfterRender.current = null; cellRefs.current.get(date)?.focus(); }
  });
  useEffect(() => { if (chosen) details.current?.focus(); }, [chosen?.date]);

  function go(next: string | null) { setSelected(null); setFocused(null); setMonth(next); }
  function close() {
    const date = selected;
    setSelected(null);
    if (date) { focusAfterRender.current = date; setFocused(date); }
  }
  function onGridKey(event: ReactKeyboardEvent, date: string) {
    const next = moveDay(date, event.key);
    if (!next) return;
    event.preventDefault();
    focusAfterRender.current = next;
    setFocused(next);
    // Moving past the grid's edge shows the neighbouring month (the day stays focused).
    if (!allCells.some(cell => cell.date === next)) { setSelected(null); setMonth(monthOf(next)); }
  }
  function onDetailsKey(event: ReactKeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); close(); } }

  return <section className="card calendar calendar-month" aria-label="Kalendarz">
    <div className="calendar-toolbar">
      {viewSwitch}
      <div className="calendar-nav" role="group" aria-label="Wybór miesiąca">
        <button type="button" className="secondary" aria-label="Poprzedni miesiąc" disabled={!shownMonth} onClick={() => shownMonth && go(shiftMonth(shownMonth, -1))}>‹</button>
        <button type="button" className="secondary" aria-label="Następny miesiąc" disabled={!shownMonth} onClick={() => shownMonth && go(shiftMonth(shownMonth, 1))}>›</button>
        <button type="button" className="secondary" disabled={!today || shownMonth === monthOf(today)} onClick={() => go(null)}>Dziś</button>
        <input type="month" className="calendar-date calendar-month-picker" aria-label="Wybierz miesiąc" title="Wybierz miesiąc" value={shownMonth ?? ''} min="1970-02"
          onChange={event => { if (validCalendarMonth(event.target.value)) go(event.target.value); }} />
      </div>
      <h2 className="calendar-range">{shownMonth ? monthLabel(shownMonth) : 'Miesiąc'}</h2>
      <CalendarFilters catalog={catalog} scope={scope} billable={billable} resolved={resolved}
        onScope={(next, message) => { setScope(next); setScopeNotice(message); }} onBillable={setBillable} />
      <p className="calendar-total"><span>{filtered ? 'Suma miesiąca (filtry)' : 'Suma miesiąca'}</span> <strong className="calendar-month-total" aria-live="off">{view ? duration(view.monthSeconds) : '—'}</strong>
        <button type="button" className="secondary calendar-info" aria-label="Jak liczone są sumy" aria-expanded={noteOpen} aria-controls="calendar-month-note" title={scopeNote(filtered, zone)} onClick={() => setNoteOpen(open => !open)}><span aria-hidden="true">i</span></button></p>
    </div>
    {noteOpen && <p id="calendar-month-note" role="note" className="helper calendar-scope-note">{scopeNote(filtered, zone)}</p>}
    {scopeNotice && <p role="status" className="helper">{scopeNotice}</p>}
    {resolved.problem && <p role="alert" className="alert error">{resolved.problem} Wybierz inny filtr.</p>}
    {!loaded ? <p role="status" className="alert error">Dane nie są aktualne. Odczytaj je ponownie w widoku Timer.</p>
      : report.failed ? <p role="alert" className="alert error">Nie udało się odczytać wpisów do kalendarza. Spróbuj ponownie za chwilę.</p>
      : !report.read ? <p role="status" className="calendar-loading">Wczytywanie kalendarza…</p>
      : !view ? <p role="alert" className="alert error">Nie można przygotować tego miesiąca (strefa raportu lub data są nieprawidłowe).</p>
      : <>
        {(view.excludedEntryIds.length > 0 || view.missingRelations) && <p role="alert" className="alert error">
          <strong>Suma jest niepełna.</strong> {view.excludedEntryIds.length > 0 && <>Nie można bezpiecznie przypisać do dni wpisów {view.excludedEntryIds.join(', ')}. </>}{view.missingRelations && 'Sprawdź powiązanie wpisów z klientem i projektem.'}</p>}
        {view.overlapEntryIds.length > 0 && <p role="alert" className="alert error"><strong>Nakładające się pomiary</strong> ({view.overlapEntryIds.join(', ')}). Suma może liczyć ten sam czas więcej niż raz.</p>}
        {view.pendingPeriodCount > 0 && <p role="status" className="alert">Uśpienie do rozstrzygnięcia ({view.pendingPeriodCount}) <strong>{duration(view.pendingSeconds)}</strong> nie wlicza się do sum.</p>}
        {view.unverifiedActive && <p role="status" className="alert">Aktywny pomiar wymaga weryfikacji i nie wlicza się do sum.</p>}
        <div className="month-grid" role="grid" aria-label={`${monthLabel(view.month)}, suma ${duration(view.monthSeconds)}`} aria-readonly="true">
          <div className="month-row month-head" role="row">
            {weekdays.map(day => <span key={day} role="columnheader" className="month-weekday">{day}</span>)}
          </div>
          {view.weeks.map(week => <div key={week[0].date} className="month-row" role="row">
            {week.map(cell => <div key={cell.date} role="gridcell" className="month-cell-wrap" aria-selected={selected === cell.date}>
              <button type="button" ref={node => { if (node) cellRefs.current.set(cell.date, node); else cellRefs.current.delete(cell.date); }}
                className={['month-cell', cell.inMonth ? '' : 'is-outside', cell.isToday ? 'is-today' : '', selected === cell.date ? 'is-selected' : ''].filter(Boolean).join(' ')}
                data-date={cell.date} tabIndex={cell.date === tabDate ? 0 : -1} aria-label={cellLabel(cell)} aria-haspopup="dialog" aria-expanded={selected === cell.date}
                aria-current={cell.isToday ? 'date' : undefined}
                onFocus={() => setFocused(cell.date)} onKeyDown={event => onGridKey(event, cell.date)}
                onClick={() => setSelected(cell.date === selected ? null : cell.date)}>
                <span className="month-cell-top"><span className="month-day">{Number(cell.date.slice(8))}</span>
                  <span className="month-day-total" title={duration(cell.seconds)}>{cell.seconds || cell.entries.length ? hoursMinutes(cell.seconds) : ''}</span></span>
                {cell.shown.length > 0 && <span className="month-entries" aria-hidden="true">
                  {cell.shown.map(item => <span key={item.entryId} className="month-entry" data-kind={item.kind} data-running={item.running || undefined} data-project-colour={item.colour}>{item.title}</span>)}
                  {cell.more > 0 && <span className="month-more">+{cell.more}</span>}
                </span>}
              </button>
            </div>)}
          </div>)}
        </div>
        {view.monthSeconds === 0 && allCells.every(cell => !cell.inMonth || cell.entries.length === 0) && <p className="muted calendar-empty">W tym miesiącu nie ma wpisów{filtered ? ' dla wybranych filtrów' : ''}.</p>}
        {chosen && <div className="calendar-details month-details" role="dialog" aria-modal="false" aria-labelledby="month-details-title" tabIndex={-1} ref={details} onKeyDown={onDetailsKey}>
          <div className="section-top"><h3 id="month-details-title">{longDate.format(utc(chosen.date))}</h3><button type="button" className="secondary" onClick={close}>Zamknij</button></div>
          <p className="month-details-total">Suma dnia <strong>{duration(chosen.seconds)}</strong>{filtered ? ' (filtry)' : ''}</p>
          {chosen.entries.length === 0 ? <p className="muted">Brak wpisów w tym dniu.</p>
            : <ul className="month-details-list" aria-label="Wpisy w tym dniu">
              {chosen.entries.map(item => <li key={item.entryId} data-kind={item.kind} data-project-colour={item.colour}>
                <strong>{item.title}</strong>
                <span>{item.path}</span>
                <small>{item.range} · {entryState(item)}{item.billable ? '' : ' · nierozliczalny'}</small>
              </li>)}
            </ul>}
          <div className="actions"><button type="button" className="primary" onClick={() => onOpenWeek(chosen.date)}>Pokaż tydzień</button></div>
          <p className="helper">Kalendarz tylko pokazuje wpisy. Popraw wpis w Historii.</p>
        </div>}
      </>}
  </section>;
}
