import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { CalendarClockEntry } from './calendarModel';
import type { ReportCatalog, ReportScope } from './reportScope';
import type { AllClientsReport } from './useAllClientsReport';
import CalendarWeek from './CalendarWeek';
import CalendarMonth from './CalendarMonth';

// DEV-25 / DEV-34: the calendar shell with its Tydzień | Miesiąc switch and drill-down hooks.
export type CalendarRestore = {
  key: number;
  mode: 'week' | 'month';
  week?: string;
  month?: string;
  selectedDate?: string | null;
};

type Props = {
  report: AllClientsReport; catalog: ReportCatalog; loaded: boolean; now: number;
  snapshotActive: CalendarClockEntry | null; snapshotFresh: boolean;
  /** DEV-26: the week adds and edits entries; the month stays read only. */
  editable: boolean; onEntrySaved: () => Promise<void>;
  backButton?: ReactNode;
  restore?: CalendarRestore | null;
  onMonthToWeek?: (date: string, fromMonth?: string) => void;
  onOpenReport?: (date: string, scope: ReportScope, state: { mode: 'week' | 'month'; week?: string; month?: string; selectedDate?: string | null }) => void;
};
type Mode = 'week' | 'month';
const MODE_KEY = 'trackermaster.calendar.mode.v1';

export default function CalendarShell({ backButton, restore, onMonthToWeek, onOpenReport, ...props }: Props) {
  const [mode, setMode] = useState<Mode>(() => { try { return window.localStorage.getItem(MODE_KEY) === 'month' ? 'month' : 'week'; } catch { return 'week'; } });
  const [weekOf, setWeekOf] = useState<string | undefined>(undefined);
  function show(next: Mode, date?: string) {
    setWeekOf(date);
    setMode(next);
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* convenience only */ }
  }
  useEffect(() => {
    if (!restore?.key) return;
    setWeekOf(restore.week);
    setMode(restore.mode);
    try { window.localStorage.setItem(MODE_KEY, restore.mode); } catch { /* convenience only */ }
  }, [restore?.key]);
  const viewSwitch = <div className="calendar-mode" role="group" aria-label="Zakres kalendarza">
    <button type="button" aria-pressed={mode === 'week'} onClick={() => show('week')}>Tydzień</button>
    <button type="button" aria-pressed={mode === 'month'} onClick={() => show('month')}>Miesiąc</button>
  </div>;
  return mode === 'month'
    ? <CalendarMonth {...props} backButton={backButton} viewSwitch={viewSwitch}
      initialRestore={restore ? { key: restore.key, month: restore.month, selected: restore.selectedDate } : undefined}
      onOpenWeek={(date, fromMonth) => { onMonthToWeek?.(date, fromMonth); show('week', date); }}
      onOpenReport={onOpenReport ? (date, scope, state) => onOpenReport(date, scope, { mode: 'month', ...state }) : undefined} />
    : <CalendarWeek key={weekOf ?? 'saved'} {...props} backButton={backButton} initialWeek={weekOf} viewSwitch={viewSwitch}
      onOpenReport={onOpenReport ? (date, scope, week) => onOpenReport(date, scope, { mode: 'week', week }) : undefined} />;
}
