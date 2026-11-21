import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { pickerGroups, pickerKey, projectColour, projectPath, taskName } from './miniTimerModel';
import type { Choice } from './miniTimerModel';

export function TimerIcon({ name }: { name: 'grip' | 'play' | 'stop' | 'pin' | 'expand' | 'collapse' | 'close' | 'search' | 'check' }) {
  const paths = {
    grip: <path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" strokeWidth="3" />,
    play: <path d="m9 5 11 7-11 7z" fill="currentColor" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />,
    pin: <path d="M15 3l6 6-2 2-3-1-4 4v3l-2 2-5-5 2-2h3l4-4-1-3zM7.5 16.5 3 21" />,
    expand: <path d="m6 9 6 6 6-6" />,
    collapse: <path d="m6 15 6-6 6 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 5 5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

type PickerProps = {
  input: RefObject<HTMLInputElement>;
  choices: Choice[];
  recent: Choice[];
  selected: string | undefined;
  onSelect: (key: string) => void;
  disabled: boolean;
};

export function MiniTimerTaskPicker({ input, choices, recent, selected, onSelect, disabled }: PickerProps) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const listId = useId();
  const activeOption = useRef<HTMLDivElement>(null);
  const groups = pickerGroups(choices, recent, query, showAll);
  const keys = groups.flatMap(group => group.items.map(choice => choice.key));
  const current = cursor !== null && keys.includes(cursor) ? cursor : null;
  const optionId = (key: string) => `${listId}-${key}`;
  useEffect(() => { if (current) activeOption.current?.scrollIntoView({ block: 'nearest' }); }, [current]);
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || disabled) return;
    const next = pickerKey(keys, current, event.key);
    if (!next) return; // Tab moves out; Escape is handled by the panel owner.
    event.preventDefault();
    if ('select' in next && next.select) { onSelect(next.select); setCursor(null); }
    else if ('highlight' in next && next.highlight) setCursor(next.highlight);
  }
  return <div className="qp-picker">
    <label className="qp-field-label" htmlFor={`${listId}-search`}>Projekt lub zadanie</label>
    <div className="qp-search"><TimerIcon name="search" /><input id={`${listId}-search`} ref={input} type="text" role="combobox" aria-autocomplete="list" aria-controls={listId} aria-expanded="true" aria-activedescendant={current ? optionId(current) : undefined} placeholder="Szukaj zadania, projektu lub klienta" autoComplete="off" disabled={disabled} value={query} onChange={event => { setQuery(event.target.value); setCursor(null); }} onKeyDown={keyDown} /></div>
    <div className="qp-results" id={listId} role="listbox" tabIndex={-1} aria-label="Projekty i zadania" aria-disabled={disabled}>
      {groups.map(group => <div key={group.id} role="group" aria-label={group.label}>
        <div className="qp-group" aria-hidden="true">{group.id !== 'recent' && <span className="qp-dot" data-project-colour={projectColour(group.id)} />}<span>{group.label}</span></div>
        {group.items.map(choice => <div key={choice.key} id={optionId(choice.key)} ref={current === choice.key ? activeOption : null} role="option" aria-selected={selected === choice.key} aria-label={`${taskName(choice)} — ${projectPath(choice)}`} data-current={current === choice.key} className="qp-option" title={`${taskName(choice)} — ${projectPath(choice)}`} onMouseDown={event => event.preventDefault()} onClick={() => { if (!disabled) { onSelect(choice.key); setCursor(null); } }}>
          <span className="qp-option-name">{taskName(choice)}{group.id === 'recent' && <small><span className="qp-dot" data-project-colour={projectColour(choice.project.id)} aria-hidden="true" />{projectPath(choice)}</small>}</span>{selected === choice.key && <TimerIcon name="check" />}
        </div>)}
      </div>)}
    </div>
    {!keys.length && <p className="qp-hint" role="status">{choices.length ? 'Brak pasujących wyników.' : 'Dodaj klienta i projekt w pełnej aplikacji.'}</p>}
    {!!recent.length && !query.trim() && <button type="button" className="qp-text-button" onClick={() => { setShowAll(!showAll); setCursor(null); input.current?.focus(); }} disabled={disabled}>{showAll ? 'Pokaż ostatnio używane' : 'Pokaż wszystkie projekty i zadania'}</button>}
  </div>;
}
