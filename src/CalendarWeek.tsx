import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { calendarWeek, clockText, DAY_MINUTES, MIN_BLOCK_PX, pieceRange, shiftWeek, validCalendarDate, weekLabel, weekStartOf } from './calendarModel';
import type { CalendarBillable, CalendarBlock, CalendarClockEntry, CalendarFilter } from './calendarModel';
import { formatDuration as duration } from './reportCsv';
import { dateInZone } from './reportTime';
import { allReportClients, resolveReportScope } from './reportScope';
import type { ReportCatalog, ReportScope } from './reportScope';
import type { AllClientsReport } from './useAllClientsReport';
import CalendarFilters from './CalendarFilters';
import CalendarEntryDialog from './CalendarEntryDialog';
import type { CalendarEntryRequest } from './CalendarEntryDialog';
import { defaultEnd, keyboardRange, minuteAt, slotStart } from './calendarEntry';
import { useCalendarMove } from './useCalendarMove';
import './calendar.css';

type Props = {
  report: AllClientsReport; catalog: ReportCatalog; loaded: boolean; now: number;
  snapshotActive: CalendarClockEntry | null; snapshotFresh: boolean;
  /** DEV-25: open on the week of this day (from the month view); the Tydzień | Miesiąc switch. */
  initialWeek?: string; viewSwitch?: ReactNode;
  /** DEV-26: adding and editing is possible (data current, no other write running). */
  editable: boolean;
  /** DEV-26: after a saved entry; refreshes the shared data (calendar, History, report). Throws when the refresh fails. */
  onEntrySaved: () => Promise<void>;
};
/** DEV-26: finished work blocks open the edit form; running, sleep-to-decide and to-verify ones only show details. */
const editableBlock = (block: CalendarBlock, all: readonly CalendarBlock[]) => block.kind === 'work' && !block.running && block.entryEndMs !== null
  && !all.some(other => other.entryId === block.entryId && other.kind !== 'work');

// Convenience only (DEV-28): the last week and filters. Never a source of data; failures are ignored.
const STORAGE_KEY = 'trackermaster.calendar.v1';
export type Saved = { week?: string; month?: string; scope?: ReportScope; billable?: CalendarBillable };
export function readSaved(): Saved {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return {};
    const id = (item: unknown) => item === null || (Number.isSafeInteger(item) && (item as number) > 0);
    const scope = value.scope && id(value.scope.clientId) && id(value.scope.projectId) && id(value.scope.taskId) ? value.scope as ReportScope : undefined;
    return { week: validCalendarDate(value.week) ? weekStartOf(value.week) : undefined, month: typeof value.month === 'string' ? value.month : undefined, scope,
      billable: ['all', 'billable', 'nonbillable'].includes(value.billable) ? value.billable : undefined };
  } catch { return {}; }
}
// Week and month keep each other's last position and share the filters (DEV-25).
export function save(value: Saved) { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readSaved(), ...value })); } catch { /* convenience only */ } }

// 40 px per hour: about 10 hours of the axis at 1280×720 and 6 at 125 % DPI (PO, PR #63 review).
const HOUR_PX = 40;
const MINUTE_PX = HOUR_PX / 60;
const MIN_MINUTES = Math.ceil(MIN_BLOCK_PX / MINUTE_PX);
/** Smallest height of the scrolling grid when the window is very low; the page scrolls below that. */
const MIN_GRID_PX = 240;
const weekday = new Intl.DateTimeFormat('pl-PL', { weekday: 'short', timeZone: 'UTC' });
const dayNumber = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
const utc = (date: string) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fullDate = (ms: number, zone: string) => new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(ms);
const kindLabel = { work: '', pending: 'Uśpienie do rozstrzygnięcia, nie wliczone do sum', unverified: 'Pomiar do weryfikacji, nie wliczony do sum' };

function scopeNote(filtered: boolean, zone: string | undefined): string {
  return `${filtered ? 'Sumy dotyczą wybranych filtrów, tak jak raport z tymi samymi filtrami.' : 'Sumy dla wszystkich klientów, tak jak w raporcie.'} Dni w strefie raportu${zone ? ` (${zone})` : ''}. Uśpienie do rozstrzygnięcia i pomiar do weryfikacji nie wliczają się do sum. Kliknij puste miejsce, aby dodać wpis, albo wpis, aby go poprawić. Zakończony wpis możesz przeciągnąć (co 15 minut) albo zmienić jego początek lub koniec uchwytem; z klawiatury: Alt+strzałki przesuwają, Alt+Shift+strzałki zmieniają koniec, Enter zapisuje, Esc anuluje.`;
}

function blockLabel(block: CalendarBlock): string {
  const state = block.kind !== 'work' ? kindLabel[block.kind] : block.running ? `w trakcie, ${duration(block.seconds)} w tym dniu` : duration(block.seconds);
  return `${block.title} — ${block.path}, ${pieceRange(block)}, ${state}`;
}

export default function CalendarWeek({ report, catalog, loaded, now, snapshotActive, snapshotFresh, initialWeek, viewSwitch, editable, onEntrySaved }: Props) {
  const [saved] = useState(readSaved);
  const zone = report.read?.data.time_zone;
  const today = zone ? (() => { try { return dateInZone(now, zone); } catch { return null; } })() : null;
  const [week, setWeek] = useState<string | null>(initialWeek && validCalendarDate(initialWeek) ? weekStartOf(initialWeek) : saved.week ?? null);
  const [scope, setScope] = useState<ReportScope>(saved.scope ?? allReportClients);
  const [billable, setBillable] = useState<CalendarBillable>(saved.billable ?? 'all');
  const [selected, setSelected] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [gridHeight, setGridHeight] = useState<number | null>(null);
  const shownWeek = week ?? (today ? weekStartOf(today) : null);
  const blockRefs = useRef(new Map<string, HTMLButtonElement>());
  const body = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef('');
  // DEV-26: the add/edit form, the control that opened it (focus returns there) and the message after it.
  const [entryForm, setEntryForm] = useState<CalendarEntryRequest | null>(null);
  const [entryNote, setEntryNote] = useState<{ text: string; problem: boolean } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (shownWeek) save({ week: shownWeek, scope, billable }); }, [shownWeek, scope, billable]);

  const resolved = useMemo(() => resolveReportScope(scope, catalog), [scope, catalog]);
  const filter: CalendarFilter = { scope, billable };
  const view = useMemo(() => {
    if (!report.read || !shownWeek || resolved.problem) return null;
    try { return calendarWeek({ data: report.read.data, catalog, filter, weekStart: shownWeek, now, snapshotActive, snapshotFresh, minMinutes: MIN_MINUTES }); }
    catch { return null; }
  }, [report.read, catalog, scope, billable, shownWeek, now, snapshotActive, snapshotFresh, resolved.problem]);
  const blocks = view ? view.days.flatMap(day => day.blocks) : [];
  const chosen = blocks.find(block => block.key === selected) ?? null;
  const filtered = scope.clientId !== null || billable !== 'all';
  // DEV-38: drag, resize and Alt+arrows; saved through the same correction as the form.
  const move = useCalendarMove({ view, blocks, data: report.read?.data, editable: editable && !entryForm, now, active: snapshotActive, canvas, body,
    minutePx: MINUTE_PX, minBlockPx: MIN_BLOCK_PX, onSaved: message => entrySaved(message), onOutcome: () => setEntryNote(null) });

  // Scroll once per week: this week to two hours before now, other weeks to about 08:00.
  useLayoutEffect(() => {
    if (!view || !body.current || scrolledFor.current === view.from) return;
    scrolledFor.current = view.from;
    const minute = view.nowMinute !== null ? view.nowMinute - 120 : 8 * 60 - 30;
    body.current.scrollTop = Math.max(0, minute) * MINUTE_PX;
  });
  // The grid fills the rest of the window and scrolls inside; the day header stays on top (sticky).
  useLayoutEffect(() => {
    function fit() {
      const node = body.current;
      if (!node) return;
      const top = node.getBoundingClientRect().top + window.scrollY;
      const card = node.closest('.calendar');
      const below = card ? card.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom : 0;
      const next = Math.max(MIN_GRID_PX, Math.floor(window.innerHeight - top - below - 8));
      setGridHeight(current => current === next ? current : next);
    }
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
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
  function openForm(request: CalendarEntryRequest, from: HTMLElement | null) {
    if (!editable || entryForm) return;
    opener.current = from; setSelected(null); setEntryNote(null); setEntryForm(request);
  }
  function closeForm(note?: string) {
    setEntryForm(null);
    if (note) setEntryNote({ text: note, problem: false });
    const from = opener.current;
    opener.current = null;
    window.setTimeout(() => (from?.isConnected ? from : addButton.current)?.focus(), 0);
  }
  async function entrySaved(message: string) {
    try { await onEntrySaved(); setEntryNote({ text: message, problem: false }); }
    catch (error) { setEntryNote({ text: `${message} Nie udało się odświeżyć widoku: ${String(error)} Odśwież dane w widoku Timer.`, problem: true }); }
  }
  function openBlock(block: CalendarBlock, node: HTMLElement) {
    if (editableBlock(block, blocks)) openForm({ mode: 'edit', entryId: block.entryId }, node);
    else setSelected(block.key === selected ? null : block.key);
  }
  function addAt(date: string, event: ReactMouseEvent<HTMLDivElement>) {
    if (move.consumeClick() || !view || (event.target as Element).closest('.calendar-block')) return;
    const box = event.currentTarget.getBoundingClientRect();
    const minute = minuteAt(event.clientY - box.top, box.height);
    if (minute === null) return;
    const start = slotStart(date, minute);
    openForm({ mode: 'new', start, end: defaultEnd(start, view.zone) }, null);
  }

  return <section className="card calendar" aria-label="Kalendarz">
    <div className="calendar-toolbar">
      {viewSwitch}
      <div className="calendar-nav" role="group" aria-label="Wybór tygodnia">
        <button type="button" className="secondary" aria-label="Poprzedni tydzień" disabled={!shownWeek} onClick={() => shownWeek && go(shiftWeek(shownWeek, -1))}>‹</button>
        <button type="button" className="secondary" aria-label="Następny tydzień" disabled={!shownWeek} onClick={() => shownWeek && go(shiftWeek(shownWeek, 1))}>›</button>
        <button type="button" className="secondary" disabled={!today || (!!shownWeek && !!today && weekStartOf(today) === shownWeek)} onClick={() => go(null)}>Dziś</button>
        <input type="date" className="calendar-date" aria-label="Przejdź do dnia" title="Przejdź do dnia" value={shownWeek ?? ''} min="1970-01-05"
          onChange={event => { if (validCalendarDate(event.target.value)) go(weekStartOf(event.target.value)); }} />
        <button type="button" ref={addButton} className="secondary calendar-add" aria-label="Dodaj wpis" title="Dodaj wpis (albo kliknij puste miejsce w kalendarzu)"
          disabled={!view || !editable || !shownWeek} onClick={event => { if (view && shownWeek) openForm({ mode: 'new', ...keyboardRange(shownWeek, today, now, view.zone) }, event.currentTarget); }}>+ Wpis</button>
      </div>
      <h2 className="calendar-range">{view ? weekLabel(view.from, view.through) : 'Tydzień'}</h2>
      <CalendarFilters catalog={catalog} scope={scope} billable={billable} resolved={resolved}
        onScope={(next, message) => { setScope(next); setScopeNotice(message); }} onBillable={setBillable} />
      <p className="calendar-total"><span>{filtered ? 'Suma (filtry)' : 'Suma'}</span> <strong className="calendar-week-total" aria-live="off">{view ? duration(view.weekSeconds) : '—'}</strong>
        <button type="button" className="secondary calendar-info" aria-label="Jak liczone są sumy" aria-expanded={noteOpen} aria-controls="calendar-scope-note" title={scopeNote(filtered, zone)} onClick={() => setNoteOpen(open => !open)}><span aria-hidden="true">i</span></button></p>
    </div>
    {noteOpen && <p id="calendar-scope-note" role="note" className="helper calendar-scope-note">{scopeNote(filtered, zone)}</p>}
    {scopeNotice && <p role="status" className="helper">{scopeNotice}</p>}
    {move.status}
    {entryNote && <p role={entryNote.problem ? 'alert' : 'status'} className={entryNote.problem ? 'alert error calendar-entry-note' : 'alert success calendar-entry-note'}>{entryNote.text}</p>}
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
          <div className="calendar-body" ref={body} tabIndex={-1} style={gridHeight ? { height: gridHeight } : undefined}>
          <div className="calendar-head" aria-hidden="true">
            <span />
            {view.days.map(day => <span key={day.date} className={day.isToday ? 'calendar-day-head is-today' : 'calendar-day-head'}>
              <small>{weekday.format(utc(day.date))}</small> <strong>{dayNumber.format(utc(day.date))}</strong>
              <span className="calendar-day-total">{duration(day.seconds)}</span></span>)}
          </div>
            <div className="calendar-canvas" ref={canvas} style={{ height: DAY_MINUTES * MINUTE_PX }}>
              <div className="calendar-hours" aria-hidden="true">{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: hour * HOUR_PX }}>{String(hour).padStart(2, '0')}:00</span>)}</div>
              {view.days.map(day => <div key={day.date} className={day.isToday ? 'calendar-column is-today' : 'calendar-column'} role="group"
                aria-label={`${new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utc(day.date))}: ${duration(day.seconds)}, wpisów ${day.blocks.length}`}
                data-date={day.date} data-addable={editable || undefined} onClick={event => addAt(day.date, event)}>
                {day.blocks.length === 0 && <span className="calendar-empty-day">Brak wpisów</span>}
                {day.blocks.map(block => <button key={block.key} type="button" ref={node => { if (node) blockRefs.current.set(block.key, node); else blockRefs.current.delete(block.key); }}
                  className="calendar-block" data-kind={block.kind} data-size={(block.bottom - block.top) * MINUTE_PX < 44 ? "short" : undefined} data-running={block.running || undefined} data-project-colour={block.colour}
                  aria-label={blockLabel(block) + (move.movable(block) ? '. Alt+strzałki przesuwają wpis, Alt+Shift+strzałki zmieniają koniec' : '')} title={`${block.title}\n${block.path}\n${pieceRange(block)}`} aria-haspopup="dialog" aria-expanded={selected === block.key}
                  aria-keyshortcuts={move.movable(block) ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown' : undefined}
                  data-movable={move.movable(block) || undefined} data-moving={move.movingKey === block.key || move.savingId === block.entryId || undefined}
                  style={{ top: block.top * MINUTE_PX, height: (block.bottom - block.top) * MINUTE_PX, left: `${(100 * block.lane) / block.lanes}%`, width: `${100 / block.lanes}%` }}
                  onPointerDown={event => move.onPointerDown(block, event)} onKeyDown={event => { move.onKeyDown(block, event); }}
                  onClick={event => { if (!move.consumeClick()) openBlock(block, event.currentTarget); }}>
                  {move.movable(block) && block.startMs === block.entryStartMs && <span className="calendar-handle" data-edge="start" aria-hidden="true" title="Przeciągnij, aby zmienić początek" />}
                  {move.movable(block) && block.endMs === block.entryEndMs && <span className="calendar-handle" data-edge="end" aria-hidden="true" title="Przeciągnij, aby zmienić koniec" />}
                  {(block.bottom - block.top) * MINUTE_PX < 44
                    ? <strong>{block.title} <small>{pieceRange(block)}</small></strong>
                    : <><strong>{block.title}</strong><span>{block.path}</span><small>{pieceRange(block)}</small></>}
                </button>)}
                {move.ghosts(day.date)}
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
          <p className="helper">{chosen.running ? 'Trwającego pomiaru nie edytuje się w kalendarzu.' : 'Tego wpisu nie można edytować w kalendarzu, dopóki ma okres do rozstrzygnięcia lub weryfikacji.'}</p>
        </div>}
        {entryForm && report.read && <CalendarEntryDialog request={entryForm} zone={view.zone} now={now} catalog={catalog} data={report.read.data}
          active={snapshotActive} enabled={editable} onClose={closeForm} onSaved={entrySaved} />}
      </>}
  </section>;
}
