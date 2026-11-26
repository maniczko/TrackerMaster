import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from './App';
import { MiniTimerTaskPicker, TimerIcon } from './MiniTimerPanel';
import { activeContext, barContext, choicesFor, clockState, createActionSettle, createRequestGate, descriptionCommand, projectColour, projectPath, readLegacyPin, recentChoices, switchChoices, switchCommand, taskName, toggleCommand } from './miniTimerModel';
import type { DescriptionDraft } from './miniTimerModel';
import AttentionBanner from './AttentionBanner';
import { openIdleLabel } from './attentionSchedule';
import { useAttention } from './useAttention';
import { defaultShortcut, matchesShortcut, shortcutLabel } from './shortcut';
import './miniTimer.css';

type ShortcutStatus = { registered: boolean; message: string; shortcut: string };
type Notice = { text: string; tone: 'error' | 'warn' | 'quiet'; action?: string; run?: () => void };

export default function Widget() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState('');
  const [edit, setEdit] = useState<DescriptionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState(false);
  const [notice, setNotice] = useState('');
  const [windowError, setWindowError] = useState('');
  const [onTop, setOnTop] = useState(false);
  const [pinPending, setPinPending] = useState(true);
  const [shortcut, setShortcut] = useState<ShortcutStatus | null>(null);
  const [shortcutError, setShortcutError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const [panelPending, setPanelPending] = useState(false);
  const [details, setDetails] = useState(false);
  const gate = useRef(createRequestGate()).current;
  // The round toggle (and the shortcut) and quick switching change meaning in place: no second action right after one.
  const settle = useRef(createActionSettle()).current;
  const connecting = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const description = useRef<HTMLTextAreaElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const contextButton = useRef<HTMLButtonElement>(null);
  const fullContext = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<'context' | 'disclosure' | null>(null);
  const panelLock = useRef(false);
  const pinLock = useRef(true);
  const pinRestore = useRef<Promise<boolean> | null>(null);
  const toggleRef = useRef<() => void>(() => {});

  const refresh = useCallback(async (afterWrite = false) => {
    if ((gate.writing || connecting.current) && !afterWrite) return false;
    const ticket = gate.beginRead();
    connecting.current = true;
    try {
      const next = await invoke<Snapshot>('get_snapshot');
      if (gate.isCurrent(ticket)) { setData(next); setNow(Date.now()); }
      return gate.isCurrent(ticket);
    } catch {
      if (gate.isCurrent(ticket)) setData(null);
      return false;
    } finally {
      connecting.current = false;
      if (gate.isCurrent(ticket)) setLoadedOnce(true);
    }
  }, [gate]);
  useEffect(() => {
    void refresh();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const sync = window.setInterval(() => void refresh(), 2500);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(clock); window.clearInterval(sync); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    pinRestore.current ??= invoke<boolean>('restore_widget_on_top', { legacyOnTop: readLegacyPin() });
    void pinRestore.current.then(pinned => { if (!disposed) setOnTop(pinned); })
      .catch(() => { if (!disposed) setWindowError('Nie przywrócono przypięcia.'); })
      .finally(() => { if (!disposed) { pinLock.current = false; setPinPending(false); } });
    return () => { disposed = true; };
  }, []);

  const choices = useMemo(() => choicesFor(data), [data]);
  const recent = useMemo(() => recentChoices(choices, data?.entries ?? []), [choices, data]);
  const choice = selected ? choices.find(item => item.key === selected) : recent[0];
  const active = data?.active ?? null;
  const attention = useAttention(Boolean(data), 'Europe/Warsaw', now, async () => { await refresh(true); });
  const openIdleStartedMs = attention.state.openIdle && active && String(attention.state.openIdle.entryId) === String(active.id) && !active.recovered && !active.uncertain
    ? attention.state.openIdle.startedMs
    : null;
  const context = data && active ? activeContext(data, active) : { title: choice ? taskName(choice) : 'Wybierz projekt lub zadanie', path: choice ? projectPath(choice) : data ? 'Gotowy do nowego pomiaru' : 'Mini timer' };
  const bar = barContext(data, active, choice);
  const clock = clockState(data, now, openIdleStartedMs);
  const retainedEdit = edit !== null && edit.entryId !== String(active?.id);
  const dirtyEdit = edit !== null && edit.value !== edit.expected && !retainedEdit;
  const conflict = dirtyEdit && edit !== null && active?.description !== edit.expected;
  const command = toggleCommand(clock.mode, active, choice, draft);
  const controlsLocked = !data || busy || verify || clock.mode === 'recovered' || clock.mode === 'unavailable';
  // Two rows fill the space above "Rozliczalny" in the 440×390 panel without scrolling.
  const quickSwitch = useMemo(() => switchChoices(recent, active, 2), [recent, active]);
  const shortcutChoice = active ? choices.find(item => String(item.project.id) === String(active.project_id) && (item.task === null ? active.task_id === null : String(item.task.id) === String(active.task_id))) : choice;
  const shortcutProjectId = shortcutChoice?.project.id;
  const shortcutTaskId = shortcutChoice?.task?.id;
  useEffect(() => {
    void invoke('set_shortcut_task', { projectId: shortcutProjectId == null ? null : Number(shortcutProjectId), taskId: shortcutTaskId == null ? null : Number(shortcutTaskId) })
      .catch(() => setShortcutError('Nie zapisano wyboru dla skrótu.'));
  }, [shortcutProjectId, shortcutTaskId]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const check = () => { void invoke<ShortcutStatus>('shortcut_status').then(next => { if (!disposed) setShortcut(next); }).catch(() => {}); };
    check();
    const poll = window.setInterval(check, 1500);
    void listen('tracker-shortcut', () => toggleRef.current()).then(async remove => {
      if (disposed) { remove(); return; }
      unlisten = remove;
      await invoke('widget_shortcut_ready');
      check();
    }).catch(() => { if (!disposed) setShortcutError('Skrót nie jest gotowy. Użyj Start / Stop.'); });
    return () => { disposed = true; unlisten?.(); window.clearInterval(poll); };
  }, []);

  async function write(name: string, args: Record<string, unknown>, nextSnapshot: boolean, landed?: () => void) {
    if (!gate.beginWrite()) return;
    setBusy(true); setNotice(''); setWindowError('');
    try {
      const next = await invoke<Snapshot>(name, args);
      landed?.();
      if (nextSnapshot) { setData(next); setNow(Date.now()); }
      else if (!await refresh(true)) { setNotice('Zapis potwierdzony. Ponów odczyt.'); return; }
      setNotice(name === 'widget_project_start' ? '' : name === 'start_project_timer' ? 'Przełączono.' : 'Zapisano.');
    } catch {
      setVerify(true);
      await refresh(true);
    } finally { gate.endWrite(); setBusy(false); }
  }
  async function checkState() {
    if (await refresh()) setVerify(false);
  }
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const setPanel = useCallback(async (expanded: boolean, from: 'context' | 'disclosure' = 'disclosure') => {
    if (panelLock.current) return;
    if (expanded === open) {
      if (expanded && from === 'context') { setDetails(true); fullContext.current?.focus(); }
      return;
    }
    panelLock.current = true; setPanelPending(true); setWindowError('');
    try {
      await invoke('widget_panel', { expanded });
      if (expanded) { returnFocus.current = from; setDetails(from === 'context'); }
      setOpen(expanded);
    } catch { setWindowError('Nie zmieniono rozmiaru okna.'); }
    finally { panelLock.current = false; setPanelPending(false); }
  }, [open]);
  toggleRef.current = () => {
    if (controlsLocked || dirtyEdit) return;
    if (!command) {
      if (open) search.current?.focus();
      else void setPanel(true);
      return;
    }
    if (!settle.allows(Date.now())) return;
    settle.mark(Date.now());
    void write(command.name, command.args, true, command.name === 'widget_project_start' ? () => setDraft('') : undefined).finally(() => settle.mark(Date.now()));
  };
  useEffect(() => {
    if (open) {
      if (returnFocus.current === 'context') fullContext.current?.focus();
      else (search.current && !search.current.disabled ? search.current : fullContext.current)?.focus();
    } else if (returnFocus.current) {
      (returnFocus.current === 'context' ? contextButton : disclosure).current?.focus();
      returnFocus.current = null;
    }
  }, [open]);
  useEffect(() => { if (open && details) fullContext.current?.focus(); }, [open, details]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (event.key === 'Escape' && open) { event.preventDefault(); void setPanel(false); }
      if (shortcut?.registered === false && matchesShortcut(event, shortcut.shortcut)) {
        event.preventDefault();
        void invoke<ShortcutStatus>('shortcut_status').then(next => {
          setShortcut(next);
          if (!next.registered && next.shortcut === shortcut.shortcut) toggleRef.current();
        }).catch(() => setShortcutError('Nie udało się sprawdzić skrótu. Użyj Start / Stop.'));
      } else if (event.code === 'Space' && (event.ctrlKey || event.altKey || event.metaKey) &&
                 event.target instanceof HTMLButtonElement) {
        // The WebView can otherwise click the focused button using a retired shortcut.
        event.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setPanel, shortcut]);

  async function changePin() {
    if (pinLock.current) return;
    pinLock.current = true; setPinPending(true); setWindowError('');
    try {
      const next = !onTop;
      await invoke('set_widget_on_top', { onTop: next });
      setOnTop(next);
    } catch { setWindowError('Nie zmieniono przypięcia.'); }
    finally { pinLock.current = false; setPinPending(false); }
  }
  const showApp = () => { void invoke('show_main').catch(() => setWindowError('Nie otwarto aplikacji.')); };
  const close = () => { if (!gate.writing) void invoke('close_widget').catch(() => setWindowError('Nie zamknięto mini timera.')); };
  const saveDescription = () => {
    const change = descriptionCommand(active, edit);
    if (change && !controlsLocked) void write(change.name, change.args, false, () => setEdit(null));
  };
  const cancelEdit = () => setEdit(null);
  const switchTo = (item: (typeof quickSwitch)[number]) => {
    const change = switchCommand(clock.mode, active, item);
    if (!change || controlsLocked || dirtyEdit || !settle.allows(Date.now())) return;
    settle.mark(Date.now());
    void write(change.name, change.args, true).finally(() => settle.mark(Date.now()));
  };
  const selectedChoice = (key: string) => {
    if (gate.writing || controlsLocked || active || !choices.some(item => item.key === key)) return;
    setSelected(key);
    description.current?.focus();
  };

  let status: Notice | undefined;
  if (busy) status = { text: 'Zapisywanie…', tone: 'quiet' };
  else if (clock.mode === 'recovered') status = { text: 'Czas wymaga weryfikacji', tone: 'warn', action: 'Rozstrzygnij czas', run: showApp };
  else if (!data) status = loadedOnce ? { text: 'Brak odczytu danych', tone: 'error', action: 'Ponów odczyt', run: () => void checkState() } : { text: 'Łączenie z aplikacją…', tone: 'quiet' };
  else if (verify) status = { text: 'Nie potwierdzono zapisu', tone: 'error', action: 'Sprawdź stan', run: () => void checkState() };
  else if (clock.mode === 'unavailable') status = { text: 'Czas jest niedostępny', tone: 'warn', action: 'Otwórz aplikację', run: showApp };
  else if (dirtyEdit) status = { text: conflict ? 'Opis zmieniono w innym oknie' : 'Niezapisany opis', tone: 'warn', action: open ? undefined : 'Pokaż opis', run: () => void setPanel(true) };
  else if (openIdleStartedMs !== null) status = { text: openIdleLabel(openIdleStartedMs, now, 'Europe/Warsaw'), tone: 'warn' };
  else if (windowError || shortcutError || shortcut?.message) status = { text: windowError || shortcutError || shortcut!.message, tone: 'error' };
  else if (notice) status = { text: notice, tone: 'quiet' };
  const toggleLabel = active ? 'Zatrzymaj pomiar' : 'Rozpocznij pomiar';
  const pinLabel = onTop ? 'Odepnij od wierzchu' : 'Przypnij na wierzchu';
  const expandLabel = open ? 'Zwiń panel' : 'Rozwiń panel';

  return <main className="qp-mini" data-mode={clock.mode} aria-label="TrackerMaster – mini timer">
    <header className="qp-bar">
      <span className="qp-grip" title="Przeciągnij okno" aria-hidden="true" onMouseDown={event => { if (event.button === 0) void invoke('widget_drag').catch(() => setWindowError('Nie przesunięto mini timera.')); }}><TimerIcon name="grip" /></span>
      <button type="button" ref={contextButton} className="qp-context" title={bar.full} aria-label={`${bar.full}. Pokaż pełne informacje`} aria-expanded={open && details} aria-controls={open ? 'qp-panel' : undefined} onClick={() => void setPanel(true, 'context')}>
        <strong>{bar.title}</strong><small>{bar.colour !== null && <span className="qp-dot" data-project-colour={bar.colour} aria-hidden="true" />}<span>{bar.subtitle}</span></small>
      </button>
      {clock.mode === 'recovered' || clock.mode === 'unavailable'
        ? <span className="qp-clock qp-clock-unknown" role="img" title={clock.mode === 'recovered' ? 'Czas do weryfikacji' : 'Czas niedostępny'} aria-label={clock.mode === 'recovered' ? 'Czas do weryfikacji' : 'Czas niedostępny'} aria-live="off">{clock.text.split(':').map((part, index) => <span key={index}>{index > 0 && <span className="qp-clock-sep">:</span>}{part}</span>)}</span>
        : <span className="qp-clock" title={clock.mode === 'running' ? 'Czas pomiaru · zapisze się przy zatrzymaniu' : 'Czas pomiaru'} aria-live="off">{clock.text}</span>}
      <button type="button" className={`qp-toggle${clock.mode === 'running' ? ' qp-running' : ''}`} aria-label={toggleLabel} title={`${toggleLabel} · ${shortcutLabel(shortcut?.shortcut || defaultShortcut)}${shortcut?.registered ? ' (globalnie)' : ' (w tym oknie)'}`} aria-disabled={controlsLocked || dirtyEdit} onClick={() => toggleRef.current()}><TimerIcon key={active ? 'stop' : 'play'} name={active ? 'stop' : 'play'} /></button>
      <div className="qp-tools">
        <button type="button" className="qp-icon" aria-label="Przypięcie na wierzchu" aria-pressed={onTop} title={pinLabel} aria-disabled={pinPending} onClick={() => void changePin()}><TimerIcon name="pin" /></button>
        <button type="button" className="qp-icon" ref={disclosure} aria-label={expandLabel} title={expandLabel} aria-expanded={open} aria-controls={open ? 'qp-panel' : undefined} aria-disabled={panelPending} onClick={() => void setPanel(!open)}><TimerIcon name={open ? 'collapse' : 'expand'} /></button>
        <button type="button" className="qp-icon" aria-label="Zamknij mini timer" title="Zamknij mini timer (pomiar trwa dalej)" aria-disabled={busy} onClick={close}><TimerIcon name="close" /></button>
      </div>
    </header>
    {status && <div className="qp-status" data-tone={status.tone}>
      <span role={status.tone === 'quiet' ? 'status' : 'alert'} title={status.text}>{status.text}</span>
      {status.action && <button type="button" className="qp-text-button" onClick={status.run}>{status.action}</button>}
    </div>}
    <AttentionBanner compact attention={attention} reportZone="Europe/Warsaw" now={now} hasActiveTimer={Boolean(active)}
      onOpenApp={showApp} onStartFocus={() => { if (!open) void setPanel(true); else search.current?.focus(); }} />
    {open && <section id="qp-panel" className="qp-panel" aria-label="Panel mini timera">
      <div className="qp-panel-header"><strong>{active ? 'Bieżący pomiar' : 'Nowy pomiar'}</strong><button type="button" className="qp-text-button" onClick={showApp}>Otwórz aplikację</button></div>
      <div className="qp-full" ref={fullContext} tabIndex={-1} aria-label="Pełny kontekst pomiaru">
        {(details || !!active) && <><strong>{context.title}</strong><span>{context.path}</span></>}
        {active && <p className="qp-hint">Przypisanie zostaje bez zmian do końca pomiaru.</p>}
        {clock.mode === 'recovered' && <p className="qp-hint">Mini timer nie wylicza czasu z nierozstrzygniętej przerwy. Sprawdź zakończenie pomiaru w aplikacji.</p>}
        {!data && <p className="qp-hint">Dane pojawią się po połączeniu z aplikacją. Szkic nie został usunięty.</p>}
        {verify && !!data && clock.mode !== 'recovered' && <p className="qp-hint">Przed kolejną zmianą sprawdź aktualny stan. Nie ponawiamy zapisu automatycznie.</p>}
        {(windowError || shortcutError || shortcut?.message) && <p className="qp-hint">{windowError || shortcutError || shortcut!.message}</p>}
      </div>
      {retainedEdit && <div className="qp-lost-edit"><label className="qp-field-label" htmlFor="qp-retained">Zachowany szkic opisu poprzedniego wpisu</label><textarea id="qp-retained" readOnly value={edit.value} rows={2} /><button type="button" className="qp-text-button" onClick={cancelEdit}>Usuń szkic z mini timera</button></div>}
      {!active && <MiniTimerTaskPicker input={search} choices={choices} recent={recent} selected={choice?.key} disabled={controlsLocked} onSelect={selectedChoice} />}
      <div className="qp-fields">
        <label className="qp-field-label" htmlFor="qp-description">{active ? 'Opis pomiaru' : 'Opis nowego pomiaru (opcjonalnie)'}</label>
        <textarea id="qp-description" className="qp-autosize" ref={description} rows={2} maxLength={2000} value={active ? (!retainedEdit && edit ? edit.value : active.description) : draft} readOnly={controlsLocked || (!!active && retainedEdit)} placeholder="Nad czym pracujesz?" onChange={event => {
          const value = event.target.value;
          if (active) setEdit(current => {
            const entryId = String(active.id);
            const expected = current?.entryId === entryId ? current.expected : active.description;
            return value === expected ? null : { entryId, expected, value };
          });
          else setDraft(value);
        }} />
        {conflict && <p className="qp-hint qp-current">Aktualnie zapisany opis: {active!.description || '(brak opisu)'}</p>}
        {dirtyEdit && <div className="qp-field-actions">
          {!conflict && <button type="button" className="qp-save" disabled={controlsLocked} onClick={saveDescription}>Zapisz opis</button>}
          {conflict && <button type="button" className="qp-save" disabled={controlsLocked} onClick={() => setEdit(edit!.value === active!.description ? null : { ...edit!, expected: active!.description })}>Użyj aktualnego opisu jako podstawy</button>}
          <button type="button" className="qp-text-button" disabled={busy} onClick={cancelEdit}>Odrzuć szkic</button>
        </div>}
        {quickSwitch.length > 0 && <div className="qp-recent" role="group" aria-labelledby="qp-recent-label">
          <span id="qp-recent-label" className="qp-field-label">Ostatnio używane</span>
          {quickSwitch.map(item => <button key={item.key} type="button" className="qp-recent-item" title={`Przełącz na: ${taskName(item)} — ${projectPath(item)}`} aria-label={`Przełącz na: ${taskName(item)} — ${projectPath(item)}`} aria-disabled={controlsLocked || dirtyEdit || clock.mode !== 'running'} onClick={() => switchTo(item)}>
            <span className="qp-dot" data-project-colour={projectColour(item.project.id)} aria-hidden="true" /><span className="qp-recent-name">{taskName(item)} <small>· {projectPath(item)}</small></span>
          </button>)}
        </div>}
        {active && <label className="qp-billing"><input type="checkbox" role="switch" className="qp-switch" checked={active.billable} disabled={controlsLocked} onChange={event => {
          if (!controlsLocked) void write('set_entry_billable', { entryId: Number(active.id), expected: active.billable, billable: event.target.checked }, false);
        }} /> Rozliczalny</label>}
        {!active && choice && <p className="qp-hint qp-billing-note">{choice.project.billable ? 'Rozliczalny' : 'Nierozliczalny'} · według ustawień projektu</p>}
      </div>
    </section>}
  </main>;
}
