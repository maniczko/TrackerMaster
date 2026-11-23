// PREVIEW ONLY: in-memory stand-in for the Tauri backend. Fictional data; nothing is persisted.
type Id = number;
type Entry = { id: Id; task_id: Id | null; project_id: Id; started_at: string; ended_at: string | null; duration_seconds?: number | null;
  recovered?: boolean; uncertain?: boolean; has_sleep?: boolean; excluded_sleep_ms?: number; manually_resolved?: boolean; billable: boolean; description: string;
  sleep_periods?: { id: number; entryId: number; startedMs: number; endedMs: number | null; decision: 'pending' | 'included' | 'excluded' }[] };

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'running';
// ?view=calendar|timer opens that view (preview convenience; the app remembers the last view in localStorage).
const previewView = params.get('view');
if (previewView === 'calendar' || previewView === 'timer') { try { localStorage.setItem('trackermaster.view.v1', previewView); localStorage.removeItem('trackermaster.calendar.v1'); } catch { /* ignore */ } }
// ?week=YYYY-MM-DD opens the calendar on the week of that day.
const previewWeek = params.get('week');
if (previewWeek && /^\d{4}-\d{2}-\d{2}$/.test(previewWeek)) { try { localStorage.setItem('trackermaster.calendar.v1', JSON.stringify({ week: previewWeek })); } catch { /* ignore */ } }
const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000, M = 60_000;
const dayStart = (() => { const d = new Date(); d.setHours(8, 30, 0, 0); return d.getTime(); })();

const clients = [
  { id: 1, name: 'Klient Alfa', archived: false },
  { id: 2, name: 'Fundacja Źródło Zieleni — oddział Łódź Północ', archived: false },
  { id: 3, name: 'Archiwalny Klient Beta', archived: true },
];
const projects = [
  { id: 11, client_id: 1, name: 'Strona internetowa', archived: false, billable: true },
  { id: 12, client_id: 1, name: 'Wsparcie techniczne', archived: false, billable: false },
  { id: 21, client_id: 2, name: 'Kampania zimowa 2026 — materiały dla wolontariuszy', archived: false, billable: true },
  { id: 31, client_id: 3, name: 'Stary projekt', archived: true, billable: false },
];
const tasks = [
  { id: 111, project_id: 11, name: 'Projekt graficzny', archived: false },
  { id: 112, project_id: 11, name: 'Wdrożenie', archived: false },
  { id: 211, project_id: 21, name: 'Przygotowanie ulotek', archived: false },
];
let nextId = 100;
const entries: Entry[] = [
  { id: 1, task_id: 111, project_id: 11, started_at: iso(dayStart), ended_at: iso(dayStart + 1.5 * H), duration_seconds: 5400, billable: true, description: 'Makiety strony głównej' },
  { id: 2, task_id: null, project_id: 12, started_at: iso(dayStart + 1.75 * H), ended_at: iso(dayStart + 2.25 * H), duration_seconds: 1800, billable: false, description: 'Odpowiedź na zgłoszenie' },
  { id: 3, task_id: 211, project_id: 21, started_at: iso(dayStart - 22 * H), ended_at: iso(dayStart - 19 * H), duration_seconds: 10800, billable: true, description: 'Teksty ulotek — wersja z długim opisem, żeby sprawdzić zawijanie w tabeli' },
];
// Crosses local midnight: History shows it in both days (TECH-09 day pieces).
const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
entries.push({ id: 4, task_id: 112, project_id: 11, started_at: iso(midnight - 0.5 * H), ended_at: iso(midnight + 0.75 * H), duration_seconds: 4500, billable: true, description: 'Nocne wdrożenie poprawek' });
// Calendar (DEV-24): entries on each of the 7 days before today (a full week whatever the weekday), one with sleep still to decide.
const weekMonday = midnight - 7 * 24 * H + 2 * H; // a moment on the day a week ago (DST-safe); the loop starts at that day
let weekId = 60;
for (const day = new Date(weekMonday); day.setHours(0, 0, 0, 0), day.getTime() < midnight; day.setDate(day.getDate() + 1)) {
  const at = (hours: number) => { const d = new Date(day); d.setHours(Math.floor(hours), Math.round((hours % 1) * 60), 0, 0); return d.getTime(); };
  const id = weekId++;
  const sleep = id === 60 ? [{ id: 9, entryId: id, startedMs: at(14.5), endedMs: at(14.75), decision: 'pending' as const }] : undefined;
  entries.push({ id, task_id: 111, project_id: 11, started_at: iso(at(14)), ended_at: iso(at(15.5)), duration_seconds: sleep ? 4500 : 5400, billable: true,
    description: sleep ? 'Projekt graficzny — z uśpieniem do rozstrzygnięcia' : 'Projekt graficzny — iteracja', ...(sleep ? { sleep_periods: sleep } : {}) });
  entries.push({ id: weekId++, task_id: null, project_id: 12, started_at: iso(at(16)), ended_at: iso(at(16.75)), duration_seconds: 2700, billable: false, description: 'Wsparcie klienta' });
}
// ?scenario=empty: first run without clients, projects or entries.
if (scenario === 'empty') { clients.length = 0; projects.length = 0; tasks.length = 0; entries.length = 0; }
let active: Entry | null = null;
type Pending = { id: number; entryId: number; startedMs: number; endedMs: number | null; client: string; project: string; task: string | null; manualResume: boolean };
let pending: Pending[] = [];

if (scenario === 'running') active = { id: 50, task_id: 112, project_id: 11, started_at: iso(now() - 25 * M), ended_at: null, billable: true, description: 'Poprawki po przeglądzie' };
if (scenario === 'recovered' || scenario === 'sleep') {
  active = { id: 51, task_id: null, project_id: 21, started_at: iso(now() - 5 * H), ended_at: null, billable: true, description: 'Pomiar przerwany przez zakończenie procesu',
    recovered: scenario === 'recovered', uncertain: scenario === 'sleep', has_sleep: true };
  pending = [
    { id: 1, entryId: 51, startedMs: now() - 4 * H, endedMs: now() - 3.5 * H, client: clients[1].name, project: projects[2].name, task: null, manualResume: false },
    { id: 2, entryId: 51, startedMs: now() - 2 * H, endedMs: null, client: clients[1].name, project: projects[2].name, task: null, manualResume: false },
  ];
}

const snapshot = () => ({ clients, projects, tasks, active: active && { ...active }, entries: [...entries].reverse() });
const health = () => ({ schema_version: 13, clients: clients.length, projects: projects.length, tasks: tasks.length, completed_entries: entries.length, open_entries: active ? 1 : 0 });
const close = (end: number) => {
  if (!active) throw 'Brak aktywnego pomiaru.';
  const start = Date.parse(active.started_at);
  entries.push({ ...active, recovered: undefined, uncertain: undefined, ended_at: iso(end), duration_seconds: Math.max(0, Math.round((end - start) / 1000)) });
  active = null;
};
const start = (projectId: number, taskId: number | null, description = '') => {
  if (active) close(now());
  const project = projects.find(p => p.id === projectId);
  if (!project) throw 'Wybierz projekt.';
  active = { id: nextId++, task_id: taskId, project_id: projectId, started_at: iso(now()), ended_at: null, billable: project.billable, description };
};
const reportData = () => ({
  entries: entries.map(e => ({ ...e, project_id: Number(e.project_id) })),
  active: active && !active.recovered && !active.uncertain ? { ...active, ended_at: iso(now()), duration_seconds: Math.round((now() - Date.parse(active.started_at)) / 1000), unresolved: false } : null,
  time_zone: 'Europe/Warsaw',
});
const exportData = (scope: { clientId?: number | null; projectId?: number | null; taskId?: number | null }) => {
  const clientId = Number(scope?.clientId);
  const client = clients.find(c => c.id === clientId);
  if (!client) throw 'Wybierz klienta do eksportu.';
  const rows = entries.filter(e => projects.find(p => p.id === e.project_id)?.client_id === clientId)
    .filter(e => scope.projectId == null || e.project_id === scope.projectId).filter(e => scope.taskId == null || e.task_id === scope.taskId)
    .map(e => ({ id: e.id, client: client.name, project: projects.find(p => p.id === e.project_id)!.name, task: tasks.find(t => t.id === e.task_id)?.name ?? '',
      description: e.description, started_at: e.started_at, ended_at: e.ended_at!, duration_seconds: e.duration_seconds ?? 0, billable: e.billable }));
  return { client_id: clientId, client: client.name, time_zone: 'Europe/Warsaw', entries: rows };
};
const resize = (expanded: boolean) => { try { window.parent?.postMessage({ type: 'tm-preview-widget', expanded }, '*'); } catch { /* standalone */ } };

const handlers: Record<string, (a: any) => unknown> = {
  get_snapshot: snapshot,
  get_report_data: reportData,
  get_client_export_data: a => exportData(a?.scope ?? {}),
  get_pending_sleep: () => pending.map(p => ({ ...p })),
  set_sleep_resume: a => { const p = pending.find(x => x.id === a.periodId); if (p) { p.endedMs = Date.parse(a.endedAt); p.manualResume = true; } },
  resolve_sleep_period: a => { pending = pending.filter(x => x.id !== a.periodId); if (active && !pending.length) active.has_sleep = false; },
  start_project_timer: a => { start(a.projectId, a.taskId ?? null, a.description ?? ''); return snapshot(); },
  resume_entry: a => {
    if (active && active.id !== a.expectedActiveId) throw 'Pomiar uległ zmianie. Sprawdź aktualny stan.';
    const source = entries.find(e => e.id === a.sourceId);
    if (!source) throw 'Wpis do wznowienia nie istnieje lub został usunięty.';
    start(source.project_id, source.task_id, source.description); return snapshot();
  },
  widget_project_start: a => { start(a.projectId, a.taskId ?? null, a.description ?? ''); return snapshot(); },
  stop_timer: () => { if (active?.recovered) throw 'Pomiar wymaga ręcznego zakończenia.'; close(now()); return snapshot(); },
  widget_stop: () => { if (active?.recovered || active?.uncertain) throw 'Pomiar wymaga weryfikacji w aplikacji.'; close(now()); return snapshot(); },
  // D4 rule from #50: the end may precede recorded sleep; later periods no longer belong
  // to the entry and an unfinished period is clipped to the end. Never adds time.
  recover_timer: a => {
    if (!active) throw 'Nie ma pomiaru do odzyskania.';
    const end = Date.parse(a.endedAt), start = Date.parse(active.started_at);
    if (!Number.isFinite(end)) throw 'Podaj poprawną datę zakończenia.';
    if (end > now()) throw 'Zakończenie nie może być w przyszłości.';
    if (end < start) throw 'Zakończenie nie może być przed rozpoczęciem pomiaru.';
    const id = active.id;
    pending = pending.filter(p => p.entryId !== id || p.startedMs < end)
      .map(p => p.entryId === id && (p.endedMs === null || p.endedMs > end) ? { ...p, endedMs: end } : p);
    close(end); return snapshot();
  },
  set_entry_description: a => { const e = entries.find(x => x.id === a.entryId) ?? (active?.id === a.entryId ? active : null); if (e) e.description = a.description; return snapshot(); },
  set_entry_billable: a => { const e = entries.find(x => x.id === a.entryId) ?? (active?.id === a.entryId ? active : null); if (e) e.billable = a.billable; return snapshot(); },
  shortcut_status: () => ({ registered: true, message: '', shortcut: 'Ctrl+Shift+Space' }),
  set_global_shortcut: a => ({ registered: true, message: '', shortcut: a.shortcut }),
  get_report_filter: () => null, get_report_scope: () => null, get_draft_sort: () => 'newest',
  get_entry_drafts: () => ({ drafts: [], unreadable: 0 }),
  restore_widget_on_top: () => false, set_widget_on_top: () => null,
  diagnose_database: health, create_backup: () => 'C:\\Users\\(podgląd)\\backups\\tracker-podglad.sqlite3',
  entry_revisions: () => [], billing_revisions: () => [], description_revisions: () => [], deleted_entries: () => [],
  widget_panel: a => resize(!!a?.expanded),
};

// Harmless window and preference calls made while screens load. Everything else that
// the preview does not model is rejected, so the UI never shows a fake success.
const noOps = new Set(['set_entry_editor_guard', 'resolve_entry_editor_close', 'widget_shortcut_ready', 'set_shortcut_task',
  'set_report_scope', 'set_report_filter', 'set_draft_sort', 'widget_drag', 'close_widget', 'show_main', 'open_widget']);
export const UNAVAILABLE = 'Ta akcja nie jest dostępna w podglądzie interfejsu (brak prawdziwego backendu).';

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise(r => setTimeout(r, 60));
  const handler = handlers[cmd];
  if (!handler) {
    if (noOps.has(cmd)) return null as T;
    console.info('[podgląd] akcja niedostępna:', cmd, args);
    return Promise.reject(UNAVAILABLE);
  }
  try { return handler(args ?? {}) as T; }
  catch (error) { return Promise.reject(typeof error === 'string' ? error : String(error)); }
}
export const isTauri = () => false;
