import { useState } from 'react';
import type { CalendarClockEntry } from './calendarModel';
import type { ReportCatalog } from './reportScope';
import type { AllClientsReport } from './useAllClientsReport';
import type { EditorCloseRequest } from './App';
import CalendarWeek from './CalendarWeek';
import CalendarMonth from './CalendarMonth';

// DEV-25: the calendar shell with its Tydzień | Miesiąc switch. Both views share the report read, the
// filters (saved together) and the live clock; the month leads to the week of a chosen day.
type Props = {
  report: AllClientsReport; catalog: ReportCatalog; loaded: boolean; now: number;
  snapshotActive: CalendarClockEntry | null; snapshotFresh: boolean;
  /** DEV-26: the week adds and edits entries; the month stays read only. */
  editable: boolean; onEntrySaved: () => Promise<void>;
  closeReady: boolean; closeRequest: EditorCloseRequest | null;
  onResolveClose: (requestId: number, proceed: boolean) => Promise<void>;
  onEditorState: (open: boolean, dirty: boolean) => void | Promise<void>;
};
type Mode = 'week' | 'month';
const MODE_KEY = 'trackermaster.calendar.mode.v1';

export default function CalendarShell({ closeReady, closeRequest, onResolveClose, onEditorState, ...shared }: Props) {
  const [mode, setMode] = useState<Mode>(() => { try { return window.localStorage.getItem(MODE_KEY) === 'month' ? 'month' : 'week'; } catch { return 'week'; } });
  const [weekOf, setWeekOf] = useState<string | undefined>(undefined);
  function show(next: Mode, date?: string) {
    setWeekOf(date);
    setMode(next);
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* convenience only */ }
  }
  const viewSwitch = <div className="calendar-mode" role="group" aria-label="Zakres kalendarza">
    <button type="button" aria-pressed={mode === 'week'} onClick={() => show('week')}>Tydzień</button>
    <button type="button" aria-pressed={mode === 'month'} onClick={() => show('month')}>Miesiąc</button>
  </div>;
  return mode === 'month'
    ? <CalendarMonth {...shared} viewSwitch={viewSwitch} onOpenWeek={date => show('week', date)} />
    : <CalendarWeek key={weekOf ?? 'saved'} {...shared} closeReady={closeReady} closeRequest={closeRequest} onResolveClose={onResolveClose} onEditorState={onEditorState} initialWeek={weekOf} viewSwitch={viewSwitch} />;
}
