import { filterByClient } from './reportClientFilter.ts';
import { reportByDay, reportOverlaps } from './reportTime.ts';
import type { ReportDay, ReportEntry } from './reportTime.ts';
import type { ExportEntry, ExportRow } from './reportCsv.ts';
import type { ReportCatalog, ReportScope } from './reportScope.ts';

export type CompletedReportEntry = ReportEntry & { task_id: number | null; project_id: number; billable: boolean; description: string };
export type ActiveReportEntry = Omit<CompletedReportEntry, 'ended_at' | 'duration_seconds'> & {
  ended_at: string | null;
  duration_seconds: number | null;
  unresolved: boolean;
};
export type ReportDetailRow = ExportRow & { status: 'finalized' | 'running' | 'pending'; pendingSeconds: number };
export type ReportSortField = 'start' | 'end' | 'duration' | 'contribution';
type ReportData = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };

export function makeReportView(data: ReportData, catalog: ReportCatalog, scope: ReportScope, from: string, through: string) {
  const filtered = filterByClient(data.entries, data.active, catalog.projects, scope.clientId?.toString() ?? '');
  const inScope = (entry: CompletedReportEntry | ActiveReportEntry) =>
    (scope.projectId === null || entry.project_id === scope.projectId) &&
    (scope.taskId === null || entry.task_id === scope.taskId);
  const clients = new Map(catalog.clients.map(item => [String(item.id), item]));
  const projects = new Map(catalog.projects.map(item => [String(item.id), item]));
  const tasks = new Map(catalog.tasks.map(item => [String(item.id), item]));
  let missingRelations = filtered.missingRelations;
  const sources = new Map<number, ExportEntry>();
  const eligible: CompletedReportEntry[] = [];

  function addRecord(entry: CompletedReportEntry) {
    const project = projects.get(String(entry.project_id));
    const owner = project && clients.get(String(project.client_id));
    const task = entry.task_id === null ? null : tasks.get(String(entry.task_id));
    if (!project || !owner || (entry.task_id !== null && (!task || String(task.project_id) !== String(project.id)))) {
      missingRelations = true;
      return;
    }
    eligible.push(entry);
    sources.set(entry.id, { ...entry, client: owner.name, project: project.name, task: task?.name ?? '' });
  }

  for (const entry of filtered.entries) if (inScope(entry)) addRecord(entry);
  const active = filtered.active && inScope(filtered.active) ? filtered.active : null;
  if (active && !active.unresolved && active.ended_at !== null && active.duration_seconds !== null) {
    addRecord({ ...active, ended_at: active.ended_at, duration_seconds: active.duration_seconds });
  }
  const report = reportByDay(eligible, from, through, data.time_zone);
  const overlaps = reportOverlaps(eligible, from, through, data.time_zone);
  const rows: ReportDetailRow[] = [];
  const finalizedRows: ExportRow[] = [];
  const days = new Map<string, number>();
  let finalizedSeconds = 0;
  let activeSeconds = 0;
  let billableSeconds = 0;
  let awaitingSeconds = 0;
  for (const item of report.contributions) {
    const source = sources.get(item.id);
    if (!source) continue;
    const status = item.id === active?.id ? 'running' : item.hasPendingSleep ? 'pending' : 'finalized';
    rows.push({ source, status, contribution: item.seconds, pendingSeconds: item.pendingSeconds });
    if (status === 'pending') {
      awaitingSeconds += item.seconds;
      continue;
    }
    if (status === 'running') activeSeconds += item.seconds;
    else {
      finalizedSeconds += item.seconds;
      finalizedRows.push({ source, contribution: item.seconds });
    }
    if (source.billable) billableSeconds += item.seconds;
    for (const day of item.days) days.set(day.date, (days.get(day.date) ?? 0) + day.seconds);
  }
  const liveSeconds = finalizedSeconds + activeSeconds;
  const liveDays: ReportDay[] = Array.from(days, ([date, seconds]) => ({ date, seconds }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    rows, finalizedRows, liveDays, finalizedSeconds, liveSeconds, activeSeconds, billableSeconds, awaitingSeconds,
    active, overlaps, missingRelations, excludedEntryIds: report.excludedEntryIds,
    pendingSeconds: report.pendingSeconds, averageSeconds: days.size ? liveSeconds / days.size : null,
  };
}

export function sortReportRows(rows: readonly ReportDetailRow[], field: ReportSortField, descending: boolean) {
  const value = (row: ReportDetailRow) => {
    switch (field) {
      case 'start': return Date.parse(row.source.started_at);
      case 'end': return Date.parse(row.source.ended_at);
      case 'duration': return row.source.duration_seconds;
      case 'contribution': return row.contribution;
    }
  };
  const direction = descending ? -1 : 1;
  return rows.map(row => ({ row, value: value(row) }))
    .sort((a, b) => direction * (a.value - b.value) || a.row.source.id - b.row.source.id)
    .map(item => item.row);
}
