// DEV-34: Pure drill-down helpers connecting Calendar (Month/Week), Reports Summary and Detailed.
// Enforces scope locking (AC2: drilling cannot reveal a client/project/task hidden by an active filter)
// and lossless round-trip snapshots for the "Wstecz" navigation stack.
import type { ReportPreset } from './reportPresets.ts';
import type { ReportCatalog, ReportScope } from './reportScope.ts';

export type DrillRouteSnapshot = {
  id: number;
  label: string;
  view: 'timer' | 'calendar';
  calendarMode: 'week' | 'month';
  calendarWeek?: string;
  calendarMonth?: string;
  calendarSelectedDate?: string | null;
  reportOpen: boolean;
  reportTab: 'summary' | 'details';
  reportPreset: ReportPreset | 'custom';
  reportRange: { from: string; through: string };
  reportScope: ReportScope;
  taskUnassignedOnly: boolean;
};

export type DrillTarget = {
  from: string;
  through: string;
  clientId?: number | null;
  projectId?: number | null;
  taskId?: number | null;
  unassignedTaskOnly?: boolean;
  sourceLabel: string;
};

export function resolveDrillScope(
  currentScope: ReportScope,
  target: Pick<DrillTarget, 'clientId' | 'projectId' | 'taskId' | 'unassignedTaskOnly'>,
  catalog: ReportCatalog,
): { allowed: boolean; scope: ReportScope; taskUnassignedOnly: boolean } {
  const sameId = (left: number | null | undefined, right: number | null | undefined) =>
    left !== null && left !== undefined && right !== null && right !== undefined && Number(left) === Number(right);

  if (target.clientId === undefined && target.projectId === undefined && target.taskId === undefined) {
    return { allowed: true, scope: { ...currentScope }, taskUnassignedOnly: false };
  }

  let clientId = target.clientId ?? null;
  let projectId = target.projectId ?? null;
  let taskId = target.taskId ?? null;
  let unassigned = Boolean(target.unassignedTaskOnly);

  if (taskId !== null) {
    const task = catalog.tasks.find(item => Number(item.id) === Number(taskId));
    if (!task) return { allowed: false, scope: currentScope, taskUnassignedOnly: false };
    if (projectId !== null && Number(projectId) !== Number(task.project_id)) {
      return { allowed: false, scope: currentScope, taskUnassignedOnly: false };
    }
    projectId = Number(task.project_id);
  }

  if (projectId !== null) {
    const project = catalog.projects.find(item => Number(item.id) === Number(projectId));
    if (!project) return { allowed: false, scope: currentScope, taskUnassignedOnly: false };
    if (clientId !== null && Number(clientId) !== Number(project.client_id)) {
      return { allowed: false, scope: currentScope, taskUnassignedOnly: false };
    }
    clientId = Number(project.client_id);
  } else if (taskId !== null || unassigned) {
    return { allowed: false, scope: currentScope, taskUnassignedOnly: false };
  }

  if (clientId !== null && !catalog.clients.some(item => Number(item.id) === Number(clientId))) {
    return { allowed: false, scope: currentScope, taskUnassignedOnly: false };
  }

  // Never widen an active client, project or task filter during drill-down (AC2).
  if (currentScope.clientId !== null && !sameId(clientId, currentScope.clientId)) {
    return { allowed: false, scope: currentScope, taskUnassignedOnly: false };
  }
  if (currentScope.projectId !== null) {
    if (projectId !== null && !sameId(projectId, currentScope.projectId)) {
      return { allowed: false, scope: currentScope, taskUnassignedOnly: false };
    }
    projectId = currentScope.projectId;
  }
  if (currentScope.taskId !== null) {
    if (unassigned || (taskId !== null && !sameId(taskId, currentScope.taskId))) {
      return { allowed: false, scope: currentScope, taskUnassignedOnly: false };
    }
    taskId = currentScope.taskId;
    unassigned = false;
  }

  return { allowed: true, scope: { clientId, projectId, taskId }, taskUnassignedOnly: unassigned };
}

export function projectDrillTarget(
  projectId: string,
  from: string,
  through: string,
  catalog: ReportCatalog,
): DrillTarget | null {
  if (!/^\d+$/.test(projectId)) return null;
  const numericId = Number(projectId);
  const project = catalog.projects.find(item => Number(item.id) === numericId);
  if (!project) return null;
  return {
    from,
    through,
    clientId: Number(project.client_id),
    projectId: Number(project.id),
    taskId: null,
    sourceLabel: project.name,
  };
}

export function summaryGroupDrillTarget(
  key: string,
  name: string,
  from: string,
  through: string,
  catalog: ReportCatalog,
): DrillTarget | null {
  if (key.startsWith('client:')) {
    const raw = key.slice('client:'.length);
    if (!/^\d+$/.test(raw)) return null;
    const clientId = Number(raw);
    if (!catalog.clients.some(item => Number(item.id) === clientId)) return null;
    return { from, through, clientId, projectId: null, taskId: null, sourceLabel: name };
  }
  if (key.startsWith('project:')) {
    const target = projectDrillTarget(key.slice('project:'.length), from, through, catalog);
    return target ? { ...target, sourceLabel: name } : null;
  }
  if (key.startsWith('task:none:')) {
    const target = projectDrillTarget(key.slice('task:none:'.length), from, through, catalog);
    return target ? { ...target, unassignedTaskOnly: true, sourceLabel: `${target.sourceLabel} / ${name}` } : null;
  }
  if (key.startsWith('task:')) {
    const raw = key.slice('task:'.length);
    if (!/^\d+$/.test(raw)) return null;
    const taskId = Number(raw);
    const task = catalog.tasks.find(item => Number(item.id) === taskId);
    if (!task) return null;
    const project = catalog.projects.find(item => Number(item.id) === Number(task.project_id));
    if (!project) return null;
    return {
      from,
      through,
      clientId: Number(project.client_id),
      projectId: Number(project.id),
      taskId,
      sourceLabel: name,
    };
  }
  return null;
}

export function drillBackLabel(snapshot: Pick<DrillRouteSnapshot, 'label'>): string {
  return `← Wstecz (${snapshot.label})`;
}
