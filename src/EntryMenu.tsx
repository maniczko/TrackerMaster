import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { menuStep } from './historyFormat';
import type { MenuKey } from './historyFormat';

export type EntryMenuItem = { key: string; label: string; ariaLabel: string; disabled?: boolean; danger?: boolean; onSelect: () => void };
const moves: readonly string[] = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

/**
 * "⋯" menu button for a History row (WAI-ARIA menu button). Presentation only: each item keeps the
 * handler, disabled rule and accessible name of the row button it replaces. Items stay in the DOM while
 * closed (hidden), so they keep their names for scripts and assistive tools that look them up.
 */
export default function EntryMenu({ label, items }: { label: string; items: EntryMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState<MenuKey | null>(null);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = items.map(item => !item.disabled);

  const focusAt = (index: number) => (index < 0 ? menu.current : buttons.current[index])?.focus();
  const show = (key: MenuKey) => { setOpen(true); setFocusOnOpen(key); };
  const hide = (returnFocus: boolean) => { setOpen(false); setFocusOnOpen(null); if (returnFocus) trigger.current?.focus(); };

  useEffect(() => {
    if (!open || !focusOnOpen) return;
    focusAt(menuStep(enabled, -1, focusOnOpen === 'ArrowUp' ? 'End' : 'Home'));
    setFocusOnOpen(null);
  });
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) hide(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function onTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key); }
  }
  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(true); return; }
    if (event.key === 'Tab') { hide(false); return; }
    if (!moves.includes(event.key)) return;
    event.preventDefault();
    const current = buttons.current.findIndex(button => button === document.activeElement);
    focusAt(menuStep(enabled, current, event.key as MenuKey));
  }

  return <div className="entry-menu" ref={root} onBlur={event => {
    if (open && event.relatedTarget && !root.current?.contains(event.relatedTarget as Node)) hide(false);
  }}>
    <button type="button" ref={trigger} className="secondary entry-menu-trigger" aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onClick={() => open ? hide(true) : show('Home')} onKeyDown={onTriggerKey}><span aria-hidden="true">⋯</span></button>
    <div id={id} ref={menu} role="menu" aria-label={label} tabIndex={-1} className="entry-menu-list" hidden={!open} onKeyDown={onMenuKey}>
      {items.map((item, index) => <button key={item.key} type="button" role="menuitem" tabIndex={-1} ref={node => { buttons.current[index] = node; }}
        className={item.danger ? 'entry-menu-item danger-text' : 'entry-menu-item'} disabled={item.disabled} aria-label={item.ariaLabel}
        onClick={() => { hide(true); item.onSelect(); }}>{item.label}</button>)}
    </div>
  </div>;
}
