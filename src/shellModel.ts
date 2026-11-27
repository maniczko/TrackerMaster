import { projectColour } from './miniTimerModel.ts';

export type AppSection = 'timer' | 'calendar' | 'reports' | 'projects' | 'clients' | 'settings';

export type SectionDescriptor = {
  id: AppSection;
  label: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  group: 'primary' | 'secondary';
};

export const SECTION_STORAGE_KEY = 'trackermaster.view.v1';

export const SHELL_SECTIONS: readonly SectionDescriptor[] = [
  {
    id: 'timer',
    label: 'Timer',
    eyebrow: 'POMIAR CZASU',
    title: 'Rejestracja czasu',
    subtitle: 'Wybierz projekt i skup się na pracy. Resztą zajmie się licznik.',
    group: 'primary',
  },
  {
    id: 'calendar',
    label: 'Kalendarz',
    eyebrow: 'PLAN I HARMONOGRAM',
    title: 'Kalendarz',
    subtitle: 'Przegląd tygodnia i miesiąca w strefie raportu.',
    group: 'primary',
  },
  {
    id: 'reports',
    label: 'Raporty',
    eyebrow: 'ZESTAWIENIA',
    title: 'Raporty czasu',
    subtitle: 'Podsumowanie pracy, wykres projektów oraz eksport CSV i XLSX.',
    group: 'primary',
  },
  {
    id: 'projects',
    label: 'Projekty',
    eyebrow: 'STRUKTURA PRACY',
    title: 'Projekty i zadania',
    subtitle: 'Kolory projektów, domyślna rozliczalność, zadania i archiwum.',
    group: 'primary',
  },
  {
    id: 'clients',
    label: 'Klienci',
    eyebrow: 'STRUKTURA PRACY',
    title: 'Klienci',
    subtitle: 'Lista klientów, aktywne projekty oraz zmiana nazw.',
    group: 'primary',
  },
  {
    id: 'settings',
    label: 'Ustawienia',
    eyebrow: 'KONFIGURACJA',
    title: 'Ustawienia i bezpieczeństwo',
    subtitle: 'Skrót globalny, kopia zapasowa i diagnostyka lokalnej bazy danych.',
    group: 'secondary',
  },
] as const;

export function sectionMeta(section: AppSection): SectionDescriptor {
  return SHELL_SECTIONS.find(item => item.id === section) ?? SHELL_SECTIONS[0];
}

export function sameId(a: number | string | undefined | null, b: number | string | undefined | null): boolean {
  return a != null && b != null && String(a) === String(b);
}

export function parseStoredSection(raw: string | null | undefined): AppSection {
  if (!raw) return 'timer';
  return SHELL_SECTIONS.some(item => item.id === raw) ? (raw as AppSection) : 'timer';
}

export type WorkspaceVisibility = {
  showTimerWorkspace: boolean;
  showTimerHeading: boolean;
  showTimerCard: boolean;
  showSleepPending: boolean;
  showDescribeCard: boolean;
  showReportCard: boolean;
  forceReportOpen: boolean;
  showHistoryCard: boolean;
  showSettingsPanel: boolean;
  forceSettingsOpen: boolean;
  showSetupCard: boolean;
  showCalendar: boolean;
  directoryMode: 'clients' | 'projects' | null;
  showSectionHeading: boolean;
};

/** Computes per-section visibility while keeping Timer/Report/History mounted to avoid timer/SQLite resets. */
export function resolveWorkspaceVisibility(section: AppSection): WorkspaceVisibility {
  const showTimerWorkspace = section === 'timer' || section === 'reports' || section === 'settings';
  return {
    showTimerWorkspace,
    showTimerHeading: section === 'timer',
    showTimerCard: section === 'timer',
    showSleepPending: section === 'timer',
    showDescribeCard: section === 'timer',
    showReportCard: section === 'timer' || section === 'reports',
    forceReportOpen: section === 'reports',
    showHistoryCard: section === 'timer',
    showSettingsPanel: section === 'timer' || section === 'settings',
    forceSettingsOpen: section === 'settings',
    showSetupCard: section === 'timer',
    showCalendar: section === 'calendar',
    directoryMode: section === 'projects' ? 'projects' : section === 'clients' ? 'clients' : null,
    showSectionHeading: section === 'reports' || section === 'projects' || section === 'clients' || section === 'settings',
  };
}

export type GlobalTimerInput = {
  loaded: boolean;
  active: {
    id: number | string;
    project_id: number | string;
    task_id: number | string | null;
    recovered?: boolean;
    uncertain?: boolean;
  } | null;
  clientLabel?: string;
  projectName?: string;
  taskName?: string;
  clockText: string;
};

export type GlobalTimerSummary = {
  statusKind: 'running' | 'pending' | 'idle' | 'unknown';
  statusLabel: string;
  clockText: string;
  clockUnknown: boolean;
  title: string;
  subtitle: string;
  colour: number | null;
  canStop: boolean;
};

/** Derives consistent topbar timer status, color marker, and action state across every shell view. */
export function buildGlobalTimerSummary(input: GlobalTimerInput): GlobalTimerSummary {
  if (!input.loaded) {
    return {
      statusKind: 'unknown',
      statusLabel: 'Brak danych',
      clockText: '—:—:—',
      clockUnknown: true,
      title: 'Stan pomiaru niedostępny',
      subtitle: 'Ponów odczyt w głównym widoku',
      colour: null,
      canStop: false,
    };
  }
  if (!input.active) {
    return {
      statusKind: 'idle',
      statusLabel: 'Zatrzymany',
      clockText: '00:00:00',
      clockUnknown: false,
      title: 'Brak aktywnego pomiaru',
      subtitle: 'Timer gotowy do startu',
      colour: null,
      canStop: false,
    };
  }
  const needsReview = Boolean(input.active.recovered || input.active.uncertain);
  const title = input.active.task_id === null
    ? 'Bez zadania'
    : input.taskName || 'Nieznane zadanie';
  const subtitle = [input.clientLabel || '—', input.projectName || '—'].join(' / ');
  const colour = projectColour(input.active.project_id);
  if (needsReview) {
    return {
      statusKind: 'pending',
      statusLabel: 'Do weryfikacji',
      clockText: '—:—:—',
      clockUnknown: true,
      title,
      subtitle,
      colour,
      canStop: false,
    };
  }
  return {
    statusKind: 'running',
    statusLabel: 'W trakcie',
    clockText: input.clockText,
    clockUnknown: false,
    title,
    subtitle,
    colour,
    canStop: true,
  };
}
