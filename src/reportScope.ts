type Id = number | string;
export type ReportClient = { id: Id; name: string; archived?: boolean };
export type ReportProject = { id: Id; client_id: Id; name: string; archived?: boolean };
export type ReportTask = { id: Id; project_id: Id; name: string; archived?: boolean };
export type ReportCatalog = { clients: ReportClient[]; projects: ReportProject[]; tasks: ReportTask[] };
export type ReportScope = { clientId: number | null; projectId: number | null; taskId: number | null };
export const allReportClients: ReportScope = { clientId: null, projectId: null, taskId: null };

export function resolveReportScope(scope: ReportScope, catalog: ReportCatalog) {
  const client = catalog.clients.find(item => Number(item.id) === scope.clientId);
  const project = catalog.projects.find(item => Number(item.id) === scope.projectId);
  const task = catalog.tasks.find(item => Number(item.id) === scope.taskId);
  let problem = '';
  if (scope.clientId !== null && !client) problem = 'Nie istnieje zapisany klient.';
  else if (scope.projectId !== null) {
    if (!project) problem = 'Nie istnieje zapisany projekt.';
    else if (!client || Number(project.client_id) !== scope.clientId) problem = 'Zapisany projekt nie należy do wybranego klienta.';
  }
  if (!problem && scope.taskId !== null) {
    if (!task) problem = 'Nie istnieje zapisane zadanie.';
    else if (!project || Number(task.project_id) !== scope.projectId) problem = 'Zapisane zadanie nie należy do wybranego projektu.';
  }
  return { client, project, task, problem };
}

export function changeReportScope(scope: ReportScope, field: keyof ReportScope, id: number | null, catalog: ReportCatalog) {
  const next = { ...scope, [field]: id };
  if (field === 'clientId' && next.projectId !== null
    && !catalog.projects.some(item => Number(item.id) === next.projectId && Number(item.client_id) === id)) {
    next.projectId = null;
  }
  if (field !== 'taskId' && next.taskId !== null
    && !catalog.tasks.some(item => Number(item.id) === next.taskId && Number(item.project_id) === next.projectId)) {
    next.taskId = null;
  }
  const clearedProject = scope.projectId !== null && next.projectId === null && field === 'clientId';
  const clearedTask = scope.taskId !== null && next.taskId === null && field !== 'taskId';
  const cleared = clearedProject && clearedTask ? 'projekt i zadanie' : clearedProject ? 'projekt' : clearedTask ? 'zadanie' : '';
  return { scope: next, message: cleared ? `Wyczyszczono filtr obejmujący ${cleared}, ponieważ wybór zmienił zakres raportu.` : '' };
}
