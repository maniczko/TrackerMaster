import type { Snapshot } from './App';

type Entry = NonNullable<Snapshot['active']>;
export type Choice = {
  key: string;
  project: Snapshot['projects'][number];
  client: Snapshot['clients'][number];
  task: Snapshot['tasks'][number] | null;
};

const keyOf = (entry: Entry) => entry.task_id === null ? `project:${entry.project_id}` : `task:${entry.task_id}`;
export const taskName = (choice: Choice) => choice.task?.name ?? 'Bez zadania';
export const projectPath = (choice: Choice) => `${choice.client.name} / ${choice.project.name}`;

export function choicesFor(snapshot: Snapshot | null): Choice[] {
  if (!snapshot) return [];
  const clients = new Map(snapshot.clients.filter(client => !client.archived).map(client => [String(client.id), client]));
  const tasks = new Map<string, Snapshot['tasks']>();
  for (const task of snapshot.tasks) {
    if (task.archived) continue;
    const id = String(task.project_id);
    if (!tasks.has(id)) tasks.set(id, []);
    tasks.get(id)!.push(task);
  }
  return snapshot.projects.flatMap((project): Choice[] => {
    const client = clients.get(String(project.client_id));
    if (project.archived || !client) return [];
    return [{ key: `project:${project.id}`, project, client, task: null }, ...(tasks.get(String(project.id)) ?? []).map(task => ({ key: `task:${task.id}`, project, client, task }))];
  });
}

export function recentChoices(choices: Choice[], entries: Entry[], limit = 4): Choice[] {
  const byKey = new Map(choices.map(choice => [choice.key, choice]));
  const recent: Choice[] = [];
  for (const entry of entries) {
    if (recent.length >= limit) break;
    const key = keyOf(entry);
    const choice = byKey.get(key);
    if (choice && String(choice.project.id) === String(entry.project_id)) {
      recent.push(choice);
      byKey.delete(key);
    }
  }
  return recent;
}

const fold = (text: string) => text.toLocaleLowerCase('pl').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');
export function pickerGroups(choices: Choice[], recent: Choice[], query: string, showAll: boolean) {
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length && recent.length && !showAll) return [{ id: 'recent', label: 'Ostatnio używane', items: recent }];
  const groups = new Map<string, { id: string; label: string; items: Choice[] }>();
  for (const choice of choices) {
    const text = fold(`${taskName(choice)} ${projectPath(choice)}`);
    if (!words.every(word => text.includes(word))) continue;
    const id = String(choice.project.id);
    if (!groups.has(id)) groups.set(id, { id, label: projectPath(choice), items: [] });
    groups.get(id)!.items.push(choice);
  }
  return [...groups.values()];
}

export function pickerKey(keys: string[], current: string | null, key: string) {
  const index = current === null ? -1 : keys.indexOf(current);
  if (!keys.length) return null;
  if (key === 'ArrowDown') return { highlight: keys[Math.min(index + 1, keys.length - 1)] };
  if (key === 'ArrowUp') return { highlight: keys[index < 0 ? keys.length - 1 : Math.max(0, index - 1)] };
  if (key === 'Enter') return { select: keys[index < 0 ? 0 : index] };
  return null;
}

export function activeContext(snapshot: Snapshot, entry: Entry) {
  const project = snapshot.projects.find(item => String(item.id) === String(entry.project_id));
  const client = snapshot.clients.find(item => project && String(item.id) === String(project.client_id));
  const task = snapshot.tasks.find(item => entry.task_id !== null && String(item.id) === String(entry.task_id));
  return { title: entry.task_id === null ? 'Bez zadania' : task?.name ?? 'Nieznane zadanie', path: `${client?.name ?? 'Nieznany klient'} / ${project?.name ?? 'Nieznany projekt'}` };
}

export function durationText(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(n => String(n).padStart(2, '0')).join(':');
}

export function clockState(snapshot: Snapshot | null, now: number) {
  if (!snapshot) return { mode: 'unavailable', text: '––:––:––' } as const;
  const active = snapshot.active;
  if (!active) return { mode: 'idle', text: '00:00:00' } as const;
  if (active.recovered) return { mode: 'recovered', text: '––:––:––' } as const;
  const start = Date.parse(active.started_at);
  if (!Number.isFinite(start)) return { mode: 'unavailable', text: '––:––:––' } as const;
  return { mode: 'running', text: durationText((now - start) / 1000) } as const;
}

export function toggleCommand(mode: ReturnType<typeof clockState>['mode'], active: Entry | null, choice: Choice | undefined, draft: string) {
  if (mode === 'running' && active) return { name: 'widget_stop', args: { entryId: Number(active.id) } };
  if (mode === 'idle' && choice) return { name: 'widget_project_start', args: { projectId: Number(choice.project.id), taskId: choice.task ? Number(choice.task.id) : null, description: draft } };
  return null;
}

export type DescriptionDraft = { entryId: string; expected: string; value: string };
export function descriptionCommand(active: Entry | null, draft: DescriptionDraft | null) {
  if (!active || active.recovered || !draft || draft.entryId !== String(active.id) || draft.expected !== active.description || draft.value === draft.expected) return null;
  return { name: 'set_entry_description', args: { entryId: Number(active.id), expected: draft.expected, description: draft.value } };
}

export function createRequestGate() {
  let writing = false;
  let read = 0;
  return {
    get writing() { return writing; },
    beginWrite() { if (writing) return false; writing = true; read++; return true; },
    endWrite() { writing = false; },
    beginRead() { return ++read; },
    isCurrent(ticket: number) { return ticket === read; },
  };
}

export const pinKey = 'widget-on-top';
export const readPin = (storage: Pick<Storage, 'getItem'>) => storage.getItem(pinKey) === 'true';
