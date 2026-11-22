import type { Snapshot } from './App';
import { clientLabels } from './clientLabels.ts';

type Entry = NonNullable<Snapshot['active']>;
export type Choice = {
  key: string;
  project: Snapshot['projects'][number];
  client: Snapshot['clients'][number];
  clientLabel: string;
  task: Snapshot['tasks'][number] | null;
};

const keyOf = (entry: Entry) => entry.task_id === null ? `project:${entry.project_id}` : `task:${entry.task_id}`;
export const taskName = (choice: Choice) => choice.task?.name ?? 'Bez zadania';
export const projectPath = (choice: Choice) => `${choice.clientLabel} / ${choice.project.name}`;

export function choicesFor(snapshot: Snapshot | null): Choice[] {
  if (!snapshot) return [];
  const labels = clientLabels(snapshot.clients);
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
    const clientLabel = labels.get(String(client.id)) ?? client.name;
    return [{ key: `project:${project.id}`, project, client, clientLabel, task: null }, ...(tasks.get(String(project.id)) ?? []).map(task => ({ key: `task:${task.id}`, project, client, clientLabel, task }))];
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
  const label = client ? clientLabels(snapshot.clients).get(String(client.id)) : undefined;
  return { title: entry.task_id === null ? 'Bez zadania' : task?.name ?? 'Nieznane zadanie', path: `${label ?? 'Nieznany klient'} / ${project?.name ?? 'Nieznany projekt'}` };
}

/** Number of decorative project colours (--project-1 … --project-8 in app.css). */
export const PROJECT_COLOURS = 8;
/** Deterministic, decorative colour slot 1…8 for a project ID. The project name is always shown as text too. */
export function projectColour(projectId: string | number): number {
  const text = String(projectId).trim();
  if (/^\d+$/.test(text)) return Number(BigInt(text) % BigInt(PROJECT_COLOURS)) + 1;
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  return (hash % PROJECT_COLOURS) + 1;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
export type BarContext = { title: string; subtitle: string; full: string; colour: number | null };
/**
 * Presentation-only text for the compact bar: title is the description, otherwise the task, otherwise the project;
 * the second line is "client · project" without repeating the title. `full` keeps every name for title/aria-label.
 */
export function barContext(snapshot: Snapshot | null, entry: Entry | null, choice: Choice | undefined): BarContext {
  if (snapshot && entry) {
    const project = snapshot.projects.find(item => String(item.id) === String(entry.project_id));
    const clientRecord = snapshot.clients.find(item => project && String(item.id) === String(project.client_id));
    const client = clientRecord ? clientLabels(snapshot.clients).get(String(clientRecord.id)) ?? clientRecord.name : 'Nieznany klient';
    const context = activeContext(snapshot, entry);
    const task = entry.task_id === null ? null : context.title;
    const projectName = project?.name ?? 'Nieznany projekt';
    const description = oneLine(entry.description ?? '');
    const title = description || task || projectName;
    const subtitle = title === projectName && !description && !task ? client : `${client} · ${projectName}`;
    return { title, subtitle, full: [description, `${context.title} — ${context.path}`].filter(Boolean).join(' — '), colour: project ? projectColour(project.id) : null };
  }
  if (choice) {
    return {
      title: choice.task?.name ?? choice.project.name,
      subtitle: choice.task ? `${choice.clientLabel} · ${choice.project.name}` : choice.clientLabel,
      full: `${taskName(choice)} — ${projectPath(choice)}`,
      colour: projectColour(choice.project.id),
    };
  }
  const title = 'Wybierz projekt lub zadanie';
  const subtitle = snapshot ? 'Gotowy do nowego pomiaru' : 'Mini timer';
  return { title, subtitle, full: `${title} — ${subtitle}`, colour: null };
}

export function durationText(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(n => String(n).padStart(2, '0')).join(':');
}

export function clockState(snapshot: Snapshot | null, now: number) {
  if (!snapshot) return { mode: 'unavailable', text: '––:––:––' } as const;
  const active = snapshot.active;
  if (!active) return { mode: 'idle', text: '00:00:00' } as const;
  if (active.recovered || active.uncertain) return { mode: 'recovered', text: '––:––:––' } as const;
  const start = Date.parse(active.started_at);
  if (!Number.isFinite(start)) return { mode: 'unavailable', text: '––:––:––' } as const;
  const elapsed = now - start - (active.excluded_sleep_ms ?? 0);
  if (!Number.isFinite(elapsed)) return { mode: 'unavailable', text: '––:––:––' } as const;
  return { mode: 'running', text: durationText(elapsed / 1000) } as const;
}

export function toggleCommand(mode: ReturnType<typeof clockState>['mode'], active: Entry | null, choice: Choice | undefined, draft: string) {
  if (mode === 'running' && active) return { name: 'widget_stop', args: { entryId: Number(active.id) } };
  if (mode === 'idle' && choice) return { name: 'widget_project_start', args: { projectId: Number(choice.project.id), taskId: choice.task ? Number(choice.task.id) : null, description: draft } };
  return null;
}

export type DescriptionDraft = { entryId: string; expected: string; value: string };
export function descriptionCommand(active: Entry | null, draft: DescriptionDraft | null) {
  if (!active || active.recovered || active.uncertain || !draft || draft.entryId !== String(active.id) || draft.expected !== active.description || draft.value === draft.expected) return null;
  return { name: 'set_entry_description', args: { entryId: Number(active.id), expected: draft.expected, description: draft.value } };
}

/** Recently used targets other than the running one: quick switching in the expanded mini timer. */
export function switchChoices(recent: Choice[], active: Entry | null, limit = 3): Choice[] {
  if (!active) return [];
  const current = keyOf(active);
  return recent.filter(choice => choice.key !== current).slice(0, limit);
}

/**
 * D3, the same command as "Przełącz zadanie" in the main window: one atomic switch that names the running
 * entry, so a timer changed elsewhere is not ended. Only a running, resolved timer can be switched.
 */
export function switchCommand(mode: ReturnType<typeof clockState>['mode'], active: Entry | null, choice: Choice | undefined) {
  if (mode !== 'running' || !active || active.recovered || active.uncertain || !choice || choice.key === keyOf(active)) return null;
  return { name: 'start_project_timer', args: { projectId: Number(choice.project.id), taskId: choice.task ? Number(choice.task.id) : null, expectedActiveId: Number(active.id), description: '' } };
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

export function readLegacyPin(storage?: Pick<Storage, 'getItem'>): boolean | null {
  try {
    const saved = (storage ?? localStorage).getItem('widget-on-top');
    if (saved === 'true' || saved === 'false') return saved === 'true';
  } catch {
    // The native preference can still be restored if the old WebView profile is unavailable.
  }
  return null;
}
