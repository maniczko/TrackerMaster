import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { sectionMeta, SHELL_SECTIONS } from './shellModel';
import type { AppSection, GlobalTimerSummary } from './shellModel';

function SectionIcon({ id }: { id: AppSection }) {
  switch (id) {
    case 'timer':
      return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10" cy="11" r="6.5" /><path d="M10 7.5V11l2.5 1.5M8 2.5h4" /></svg>;
    case 'calendar':
      return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="2" /><path d="M3 8.5h14M7 2.5v3M13 2.5v3" /></svg>;
    case 'reports':
      return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 16V10M10 16V4M16 16V7" /></svg>;
    case 'projects':
      return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H8l1.6 1.8h5.9A1.5 1.5 0 0 1 17 8.3v6.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" /></svg>;
    case 'clients':
      return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7.5" cy="7" r="2.75" /><path d="M3 16c0-2.4 2-4 4.5-4s4.5 1.6 4.5 4" /><circle cx="14" cy="7.5" r="2" /><path d="M14 11.5c1.8 0 3.2 1.2 3.2 3.2" /></svg>;
    case 'settings':
      return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="2.6" /><path d="M10 3v1.6M10 15.4V17M3 10h1.6M15.4 10H17M5.1 5.1l1.1 1.1M13.8 13.8l1.1 1.1M14.9 5.1l-1.1 1.1M6.2 13.8l-1.1 1.1" /></svg>;
  }
}

type SidebarProps = {
  section: AppSection;
  onSelect: (next: AppSection) => void;
};

export function AppSidebar({ section, onSelect }: SidebarProps) {
  const navRef = useRef<HTMLElement>(null);
  const primary = SHELL_SECTIONS.filter(item => item.group === 'primary');
  const secondary = SHELL_SECTIONS.filter(item => item.group === 'secondary');

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('button.app-sidebar-btn') ?? []);
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    let target = current;
    if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = buttons.length - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') target = (current + 1) % buttons.length;
    else target = (current - 1 + buttons.length) % buttons.length;
    buttons[target]?.focus();
  }

  return (
    <aside className="app-sidebar" aria-label="Nawigacja główna">
      <nav ref={navRef} aria-label="Sekcje aplikacji" className="app-sidebar-nav" onKeyDown={handleKeyDown}>
        <div className="app-sidebar-group">
          <p className="app-sidebar-kicker" id="sidebar-workspace-label">Obszar pracy</p>
          <ul className="app-sidebar-list" aria-labelledby="sidebar-workspace-label">
            {primary.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  className="app-sidebar-btn"
                  data-section={item.id}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => onSelect(item.id)}
                >
                  <SectionIcon id={item.id} />
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="app-sidebar-group app-sidebar-secondary">
          <p className="app-sidebar-kicker" id="sidebar-system-label">Konfiguracja</p>
          <ul className="app-sidebar-list" aria-labelledby="sidebar-system-label">
            {secondary.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  className="app-sidebar-btn"
                  data-section={item.id}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => onSelect(item.id)}
                >
                  <SectionIcon id={item.id} />
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="app-sidebar-footer">
        <strong>Quiet Precision</strong>
        <small>Nawigacja zachowuje aktywny pomiar i stan roboczych kart.</small>
      </div>
    </aside>
  );
}

type GlobalTimerBarProps = {
  summary: GlobalTimerSummary;
  busy: boolean;
  onStop: () => void;
  onFocusTimer: () => void;
};

export function GlobalTimerBar({ summary, busy, onStop, onFocusTimer }: GlobalTimerBarProps) {
  const pillClass = summary.statusKind === 'running'
    ? 'status running'
    : summary.statusKind === 'pending'
      ? 'status pending'
      : 'status';

  return (
    <div className="global-timer-strip" role="region" aria-label="Globalny pasek timera">
      <span className={pillClass} data-global-status={summary.statusKind}>
        <span />
        {summary.statusLabel}
      </span>
      <span className={summary.clockUnknown ? 'global-timer-clock is-unknown' : 'global-timer-clock'} aria-live="off">
        {summary.clockText}
      </span>
      <div className="global-timer-context" title={`${summary.title} · ${summary.subtitle}`}>
        {summary.colour !== null && <span className="qp-dot" data-project-colour={summary.colour} aria-hidden="true" />}
        <div className="global-timer-labels">
          <strong>{summary.title}</strong>
          <small>{summary.subtitle}</small>
        </div>
      </div>
      {summary.canStop ? (
        <button type="button" className="global-bar-stop" disabled={busy} onClick={onStop} aria-label="Zatrzymaj aktywny pomiar z paska górnego">
          <span aria-hidden="true">■</span> Zatrzymaj
        </button>
      ) : (
        <button type="button" className="secondary global-bar-goto" onClick={onFocusTimer}>
          Otwórz timer
        </button>
      )}
    </div>
  );
}

export function SectionHeading({ section, dateText }: { section: AppSection; dateText: string }) {
  const meta = sectionMeta(section);
  return (
    <div className="heading">
      <div>
        <p className="eyebrow">{meta.eyebrow}</p>
        <h1>{meta.title}</h1>
        <p className="subtitle">{meta.subtitle}</p>
      </div>
      <div className="date">{dateText}</div>
    </div>
  );
}
