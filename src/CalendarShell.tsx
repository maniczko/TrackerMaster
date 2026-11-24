import { useState } from 'react';
import type { CalendarClockEntry } from './calendarModel';
import type { ReportCatalog } from './reportScope';
import type { AllClientsReport } from './useAllClientsReport';
import CalendarWeek from './CalendarWeek';
import CalendarMonth from './CalendarMonth';

// DEV-25: the calendar shell with its Tydzień | Miesiąc switch. Both views share the report read, the
// filters (saved together) and the live clock; the month leads to the week of a chosen day.
type Props = {
  report: AllClientsReport; catalog: ReportCatalog; loaded: boolean; now: number;
  snapshotActive: CalendarClockEntry | null; snapshotFresh: boolean;
};
type Mode = 'week' | 'month';
const MODE_KEY = 'trackermaster.calendar.mode.v1';

export default function CalendarShell(props: Props) {
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
    ? <CalendarMonth {...props} viewSwitch={viewSwitch} onOpenWeek={date => show('week', date)} />
    : <CalendarWeek key={weekOf ?? 'saved'} {...props} initialWeek={weekOf} viewSwitch={viewSwitch} />;
}
