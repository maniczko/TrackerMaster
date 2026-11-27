import { useState } from 'react';
import type { CalendarClockEntry, CalendarSpan } from './calendarModel';
import type { ReportCatalog } from './reportScope';
import type { AllClientsReport } from './useAllClientsReport';
import CalendarWeek from './CalendarWeek';
import CalendarMonth from './CalendarMonth';

// DEV-25 / DEV-37: the calendar shell with Dzień | 5 dni | Tydzień | Miesiąc modes sharing the report read,
// filters and live clock; the month leads to the week of a chosen day.
type Props = {
  report: AllClientsReport; catalog: ReportCatalog; loaded: boolean; now: number;
  snapshotActive: CalendarClockEntry | null; snapshotFresh: boolean;
  /** DEV-26: the timeline views add and edit entries; the month stays read only. */
  editable: boolean; onEntrySaved: () => Promise<void>;
};
type Mode = CalendarSpan | 'month';
const MODE_KEY = 'trackermaster.calendar.mode.v1';
const readMode = (): Mode => {
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    return saved === 'day' || saved === 'five' || saved === 'week' || saved === 'month' ? saved : 'week';
  } catch { return 'week'; }
};

export default function CalendarShell(props: Props) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [weekJump, setWeekJump] = useState<{ key: number; date: string } | null>(null);
  function show(next: Mode, jumpDate?: string) {
    if (jumpDate) setWeekJump(prev => ({ key: (prev?.key ?? 0) + 1, date: jumpDate }));
    setMode(next);
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* convenience only */ }
  }
  const viewSwitch = <div className="calendar-mode" role="group" aria-label="Zakres kalendarza">
    <button type="button" aria-pressed={mode === 'day'} onClick={() => show('day')}>Dzień</button>
    <button type="button" aria-pressed={mode === 'five'} onClick={() => show('five')}>5 dni</button>
    <button type="button" aria-pressed={mode === 'week'} onClick={() => show('week')}>Tydzień</button>
    <button type="button" aria-pressed={mode === 'month'} onClick={() => show('month')}>Miesiąc</button>
  </div>;
  return mode === 'month'
    ? <CalendarMonth {...props} viewSwitch={viewSwitch} onOpenWeek={date => show('week', date)} />
    : <CalendarWeek key={weekJump?.key ?? 0} {...props} span={mode} initialWeek={weekJump?.date} viewSwitch={viewSwitch} />;
}
