import { useMemo } from 'react';
import type { CalendarBillable } from './calendarModel';
import { changeReportScope } from './reportScope';
import type { ReportCatalog, ReportScope, resolveReportScope } from './reportScope';
import { clientLabels } from './clientLabels';

// Shared by the week (DEV-24) and the month (DEV-25): client, project, task and billability. The same
// report scope rules as the report (changeReportScope), so both views count what the report counts.
type Props = {
  catalog: ReportCatalog; scope: ReportScope; billable: CalendarBillable;
  resolved: ReturnType<typeof resolveReportScope>;
  onScope: (scope: ReportScope, message: string) => void;
  onBillable: (billable: CalendarBillable) => void;
};

export default function CalendarFilters({ catalog, scope, billable, resolved, onScope, onBillable }: Props) {
  const clientLabelById = useMemo(() => clientLabels(catalog.clients as { id: number | string; name: string }[]), [catalog.clients]);
  function changeScope(field: keyof ReportScope, value: string) {
    const next = changeReportScope(scope, field, value ? Number(value) : null, catalog);
    onScope(next.scope, next.message);
  }
  const projectChoices = catalog.projects.filter(item => Number(item.client_id) === scope.clientId);
  const taskChoices = catalog.tasks.filter(item => Number(item.project_id) === scope.projectId);
  return <div className="calendar-filters" role="group" aria-label="Filtry kalendarza">
    <select aria-label="Klient" title="Klient" value={scope.clientId ?? ''} onChange={event => changeScope('clientId', event.target.value)}>
      <option value="">Wszyscy klienci</option>
      {catalog.clients.map(item => <option key={item.id} value={item.id}>{clientLabelById.get(String(item.id)) ?? item.name}{item.archived ? ' (archiwum)' : ''}</option>)}
    </select>
    <select aria-label="Projekt" title="Projekt" value={scope.projectId ?? ''} disabled={!resolved.client} onChange={event => changeScope('projectId', event.target.value)}>
      <option value="">{resolved.client ? 'Wszystkie projekty' : 'Projekt: najpierw klient'}</option>
      {projectChoices.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (archiwum)' : ''}</option>)}
    </select>
    <select aria-label="Zadanie" title="Zadanie" value={scope.taskId ?? ''} disabled={!resolved.project} onChange={event => changeScope('taskId', event.target.value)}>
      <option value="">{resolved.project ? 'Wszystkie zadania' : 'Zadanie: najpierw projekt'}</option>
      {taskChoices.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (archiwum)' : ''}</option>)}
    </select>
    <select aria-label="Rozliczalność" title="Rozliczalność" value={billable} onChange={event => onBillable(event.target.value as CalendarBillable)}>
      <option value="all">Rozliczalne i nie</option><option value="billable">Tylko rozliczalne</option><option value="nonbillable">Tylko nierozliczalne</option>
    </select>
  </div>;
}
