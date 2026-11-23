// Quick start in the main window: the same project/task choice as the mini timer (choicesFor,
// recentChoices) mapped onto the main window's client/project/task selection. Pure, no I/O.
import type { Choice } from './miniTimerModel.ts';

type Id = number | string;
type Named = { id: Id; archived: boolean };
type ActiveEntry = { project_id: Id; task_id: Id | null; recovered?: boolean };

export type TimerSelection = { clientId: string; projectId: string; taskId: string };

/** Picker key for the current selection ("task:7", "project:3"), or undefined when nothing is chosen. */
export function selectionKey(projectId: string, taskId: string): string | undefined {
  if (taskId) return `task:${taskId}`;
  return projectId ? `project:${projectId}` : undefined;
}

/** Selection the main window stores when a picker choice is made; null for an unknown key. */
export function selectionFor(choices: readonly Choice[], key: string): TimerSelection | null {
  const choice = choices.find(item => item.key === key);
  if (!choice) return null;
  return { clientId: String(choice.client.id), projectId: String(choice.project.id), taskId: choice.task ? String(choice.task.id) : '' };
}

/**
 * The Start/Switch button rule, unchanged from the lists: a project is required, nothing archived,
 * no recovered timer, and the running project/task is not started a second time.
 */
export function startBlocked(state: {
  busy: boolean; loaded: boolean; projectId: string; taskId: string;
  client?: Named; project?: Named; task?: Named; active: ActiveEntry | null;
}): boolean {
  const { busy, loaded, projectId, taskId, client, project, task, active } = state;
  if (busy || !loaded || !projectId) return true;
  if (client?.archived || project?.archived || task?.archived) return true;
  if (active?.recovered) return true;
  if (active && String(active.project_id) === projectId &&
      (taskId ? active.task_id !== null && String(active.task_id) === taskId : active.task_id === null)) return true;
  return false;
}

export type MainAction = { kind: 'stop' | 'start' | 'choose'; disabled: boolean };

/**
 * The one main action under the clock, in the same place in every state: Stop while a timer runs,
 * otherwise Start. Without a chosen project Start is "choose": it stays clickable and leads to the
 * project search instead of being a disabled button without an explanation. A Start with a project
 * keeps the startBlocked rule; Stop stays disabled for a recovered timer (it needs its end time).
 */
export function mainAction(state: Parameters<typeof startBlocked>[0]): MainAction {
  const { busy, loaded, projectId, active } = state;
  if (active) return { kind: 'stop', disabled: busy || !loaded || !!active.recovered };
  if (!projectId) return { kind: 'choose', disabled: busy || !loaded };
  return { kind: 'start', disabled: startBlocked(state) };
}
