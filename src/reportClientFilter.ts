type Id = string | number;
type Project = { id: Id; client_id: Id };
type ProjectEntry = { project_id: Id };

// A time entry belongs to a client through its project, whether or not it has
// an associated task. Keep missing relations visible to the report's warning.
export function filterByClient<E extends ProjectEntry, A extends ProjectEntry>(entries: E[], active: A | null, projects: Project[], client: string) {
  const projectClients = new Map(projects.map(project => [String(project.id), String(project.client_id)]));
  const relation = (entry: ProjectEntry) => projectClients.get(String(entry.project_id));
  const missingRelations = !!client && [...entries, ...(active ? [active] : [])].some(entry => !relation(entry));
  return { entries: entries.filter(entry => !client || relation(entry) === client), active: active && (!client || relation(active) === client) ? active : null, missingRelations };
}
