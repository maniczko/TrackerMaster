import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildGlobalTimerSummary,
  parseStoredSection,
  resolveWorkspaceVisibility,
  sectionMeta,
  SHELL_SECTIONS,
} from '../src/shellModel.ts';

test('sidebar sections include all DEV-23 primary destinations plus settings', () => {
  assert.deepEqual(
    SHELL_SECTIONS.filter(item => item.group === 'primary').map(item => item.label),
    ['Timer', 'Kalendarz', 'Raporty', 'Projekty', 'Klienci'],
  );
  assert.deepEqual(
    SHELL_SECTIONS.filter(item => item.group === 'secondary').map(item => item.label),
    ['Ustawienia'],
  );
  assert.equal(parseStoredSection('calendar'), 'calendar');
  assert.equal(parseStoredSection('reports'), 'reports');
  assert.equal(parseStoredSection('projects'), 'projects');
  assert.equal(parseStoredSection('clients'), 'clients');
  assert.equal(parseStoredSection('settings'), 'settings');
  assert.equal(parseStoredSection('unknown'), 'timer');
  assert.equal(parseStoredSection(null), 'timer');
  assert.equal(sectionMeta('reports').title, 'Raporty czasu');
});

test('workspace visibility separates sections while keeping timer shell mounted', () => {
  const timer = resolveWorkspaceVisibility('timer');
  assert.equal(timer.showTimerWorkspace, true);
  assert.equal(timer.showTimerCard, true);
  assert.equal(timer.showHistoryCard, true);
  assert.equal(timer.showReportCard, true);
  assert.equal(timer.forceReportOpen, false);
  assert.equal(timer.showCalendar, false);
  assert.equal(timer.directoryMode, null);

  const calendar = resolveWorkspaceVisibility('calendar');
  assert.equal(calendar.showTimerWorkspace, false);
  assert.equal(calendar.showCalendar, true);

  const reports = resolveWorkspaceVisibility('reports');
  assert.equal(reports.showTimerWorkspace, true);
  assert.equal(reports.showTimerCard, false);
  assert.equal(reports.showHistoryCard, false);
  assert.equal(reports.showReportCard, true);
  assert.equal(reports.forceReportOpen, true);

  const projects = resolveWorkspaceVisibility('projects');
  assert.equal(projects.directoryMode, 'projects');
  assert.equal(projects.showSectionHeading, true);

  const clients = resolveWorkspaceVisibility('clients');
  assert.equal(clients.directoryMode, 'clients');
  assert.equal(clients.showSectionHeading, true);

  const settings = resolveWorkspaceVisibility('settings');
  assert.equal(settings.showSettingsPanel, true);
  assert.equal(settings.forceSettingsOpen, true);
  assert.equal(settings.showSetupCard, false);
});

test('global timer bar summary reflects unloaded, idle, pending and running states cleanly', () => {
  const unloaded = buildGlobalTimerSummary({ loaded: false, active: null, clockText: '00:00:00' });
  assert.equal(unloaded.statusKind, 'unknown');
  assert.equal(unloaded.canStop, false);

  const idle = buildGlobalTimerSummary({ loaded: true, active: null, clockText: '00:00:00' });
  assert.equal(idle.statusKind, 'idle');
  assert.equal(idle.clockText, '00:00:00');
  assert.equal(idle.canStop, false);

  const recovered = buildGlobalTimerSummary({
    loaded: true,
    active: { id: 7, project_id: 3, task_id: null, recovered: true },
    clientLabel: 'ACME',
    projectName: 'Platform',
    clockText: '00:05:10',
  });
  assert.equal(recovered.statusKind, 'pending');
  assert.equal(recovered.clockUnknown, true);
  assert.equal(recovered.canStop, false);

  const running = buildGlobalTimerSummary({
    loaded: true,
    active: { id: 8, project_id: 10, task_id: 2 },
    clientLabel: 'ACME',
    projectName: 'Platform',
    taskName: 'Shell',
    clockText: '01:02:03',
  });
  assert.equal(running.statusKind, 'running');
  assert.equal(running.clockText, '01:02:03');
  assert.equal(running.title, 'Shell');
  assert.equal(running.subtitle, 'ACME / Platform');
  assert.equal(running.colour, 3);
  assert.equal(running.canStop, true);
});

test('App.tsx wires sidebar, global timer strip and responsive breakpoints without extra top-level stop selectors', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  assert.match(app, /<AppSidebar\b/);
  assert.match(app, /<GlobalTimerBar\b/);
  assert.match(app, /<DirectoryViews\b/);
  assert.match(css, /\.app-sidebar\b/);
  assert.match(css, /\.global-timer-strip\b/);
  assert.match(css, /@media \(max-width: 1119px\)/);
  assert.doesNotMatch(
    readFileSync(new URL('../src/SidebarShell.tsx', import.meta.url), 'utf8'),
    /\btimer-stop\b|\btimer-start\b/,
    'global timer strip must not hijack timer-card Playwright/CDP selectors',
  );
});
