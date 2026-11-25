// DEV-38: moving and resizing blocks in the week view, with the mouse or the keyboard.
//
// - A press becomes a drag only after DRAG_THRESHOLD_PX of travel; a plain click still opens the DEV-26
//   form, which stays the full keyboard alternative. Esc cancels a drag or a keyboard move.
// - While dragging, a ghost shows the snapped new place (red when it may not be saved and why).
// - A drop saves through the correction service (calendarMove.ts). Until the save succeeds and the data is
//   read again, the original block stays where it was; on any failure the ghost goes away (the block is
//   in its original place), the message says why, and "Spróbuj ponownie" sends the same draft revision.
// - Only finished work entries without sleep periods move (the backend refuses time changes of an entry
//   with sleep, ensure_no_sleep_periods); a running, recovered or to-verify timer and pending sleep never do.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';
import { DAY_MINUTES, entryPieces, pieceRange } from './calendarModel';
import type { CalendarBlock, CalendarClockEntry, CalendarReportData, CalendarWeek } from './calendarModel';
import { checkProposal, DRAG_THRESHOLD_PX, dropFields, keyFields, pointerMinute, proposalSeconds } from './calendarDrag';
import type { DragEntry, DragKind, DragPiece, DragProposal } from './calendarDrag';
import { wallValue } from './calendarEntry';
import type { OtherEntry } from './calendarEntry';
import { discardMove, MoveRefused, saveMove } from './calendarMove';
import type { PendingMove } from './calendarMove';
import { formatDuration as duration } from './reportCsv';
import { sentence } from './messageText';
import './calendarMove.css';

type Range = { startMs: number; endMs: number };
type Drag = {
  kind: DragKind; block: CalendarBlock; entry: DragEntry; piece: DragPiece; pointerId: number;
  x: number; y: number; grab: number; active: boolean; node: HTMLElement;
};
type Shown = { entryId: number; key: string; range: Range | null; result: DragProposal | null; via: 'pointer' | 'keyboard'; entry: DragEntry; current: Range };
type Failure = { text: string; pending: PendingMove | null; range?: Range };
type KeyAction = Parameters<typeof keyFields>[0];

const shortDay = (value: string) => `${Number(value.slice(8, 10))}.${value.slice(5, 7)}`;
const describe = (fields: { start: string; end: string }, startMs: number, endMs: number) =>
  `${shortDay(fields.start)} ${fields.start.slice(11, 16)}–${fields.end.slice(0, 10) === fields.start.slice(0, 10) ? '' : `${shortDay(fields.end)} `}${fields.end.slice(11, 16)} (${duration(proposalSeconds(startMs, endMs))})`;
const KEYS: Record<string, KeyAction | undefined> = { ArrowUp: 'earlier', ArrowDown: 'later', ArrowLeft: 'previousDay', ArrowRight: 'nextDay' };

export function useCalendarMove(input: {
  view: CalendarWeek | null; blocks: readonly CalendarBlock[]; data: CalendarReportData | undefined; editable: boolean; now: number;
  active: CalendarClockEntry | null; canvas: RefObject<HTMLDivElement | null>; body: RefObject<HTMLDivElement | null>; minutePx: number; minBlockPx: number;
  onSaved: (message: string) => Promise<void>;
}) {
  const { view, blocks, data, editable, now, active, canvas, body, minutePx, minBlockPx, onSaved } = input;
  const zone = view?.zone ?? 'UTC';
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const [shown, setShown] = useState<Shown | null>(null);
  // While saving, and after a successful save until the calendar's data is read again (the ghost stays in the
  // new place, nothing is movable, so a second move never starts from the old times).
  const [saving, setSaving] = useState<{ entryId: number; range: Range; before?: CalendarReportData } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const latest = useRef({ now, data, failure });
  latest.current = { now, data, failure };
  useEffect(() => {
    if (!saving?.before || data === saving.before) return;
    setSaving(null);
  }, [data, saving]);
  useEffect(() => {
    if (!saving?.before) return;
    const timer = window.setTimeout(() => setSaving(null), 5000);
    return () => window.clearTimeout(timer);
  }, [saving]);

  // Entries whose time may not change in the calendar (any sleep period), and the overlap candidates.
  const sleepy = useMemo(() => new Set((data?.entries ?? []).filter(entry => (entry.sleep_periods?.length ?? 0) > 0).map(entry => entry.id)), [data]);
  const others = useMemo((): OtherEntry[] => {
    const label = (id: number, startMs: number, endMs: number) => `wpis #${id}, ${shortDay(wallValue(startMs, zone))} ${wallValue(startMs, zone).slice(11, 16)}–${wallValue(endMs, zone).slice(11, 16)}`;
    const list: OtherEntry[] = (data?.entries ?? []).map(entry => {
      const startMs = Date.parse(entry.started_at), endMs = Date.parse(entry.ended_at);
      return { id: entry.id, startMs, endMs, label: Number.isFinite(startMs) && Number.isFinite(endMs) ? label(entry.id, startMs, endMs) : `wpis #${entry.id}` };
    });
    const running = active ?? data?.active;
    if (running) {
      const startMs = Date.parse(running.started_at);
      list.push({ id: Number(running.id), startMs, endMs: null, label: `trwający pomiar od ${wallValue(startMs, zone).slice(11, 16)}` });
    }
    return list.filter(entry => Number.isFinite(entry.startMs));
  }, [data, active, zone]);

  const busy = !!saving;
  function movable(block: CalendarBlock): boolean {
    return editable && !busy && block.kind === 'work' && !block.running && block.entryEndMs !== null && !sleepy.has(block.entryId)
      && !blocks.some(other => other.entryId === block.entryId && other.kind !== 'work');
  }
  const entryOf = (block: CalendarBlock): DragEntry => ({ id: block.entryId, startMs: block.entryStartMs, endMs: block.entryEndMs! });
  const pieceOf = (block: CalendarBlock): DragPiece => ({ date: block.date, startMs: block.startMs, endMs: block.endMs });

  function columns() {
    return Array.from(canvas.current?.querySelectorAll<HTMLElement>('.calendar-column[data-date]') ?? []).map(node => ({ date: node.dataset.date!, box: node.getBoundingClientRect() }));
  }
  /** The proposal for a pointer position; computed again at the release, never read back from React state. */
  function propose(current: Drag, x: number, y: number): Shown | null {
    const all = columns();
    if (all.length === 0) return null;
    const own = all.find(column => column.date === current.piece.date) ?? all[0];
    const column = current.kind === 'move' ? all.reduce((best, item) => Math.abs(item.box.left + item.box.width / 2 - x) < Math.abs(best.box.left + best.box.width / 2 - x) ? item : best) : own;
    const minute = pointerMinute(y - column.box.top, column.box.height) - (current.kind === 'move' ? current.grab : 0);
    const dropped = dropFields(current.kind, current.entry, current.piece, { date: column.date, minute }, zone);
    const result = checkProposal(dropped, current.entry, zone, latest.current.now, others);
    const range = 'problem' in dropped ? null : { startMs: dropped.startMs, endMs: dropped.endMs };
    const next: Shown = { entryId: current.entry.id, key: current.block.key, range, result, via: 'pointer', entry: current.entry, current: range ?? current.entry };
    setShown(next);
    return next;
  }

  function cancel(message?: string) {
    const current = drag.current;
    drag.current = null;
    if (current?.active) swallowClick.current = true;
    if (current) { try { current.node.releasePointerCapture(current.pointerId); } catch { /* already released */ } }
    setShown(null);
    if (message) setFailure({ text: message, pending: null });
  }

  async function commit(entry: DragEntry, result: DragProposal) {
    if (!result.ok) { setFailure({ text: `Nie przesunięto wpisu #${entry.id}: ${result.problem.message} Wpis został na swoim miejscu.`, pending: null }); setShown(null); return; }
    if (!result.changed) { setShown(null); setFailure(null); return; }
    await run({ entry, fields: result.fields, zone, source: null, draft: null }, { startMs: result.startMs, endMs: result.endMs });
  }

  async function run(pending: PendingMove, range: Range) {
    // A new move replaces an unsaved earlier one: its draft is discarded (it would otherwise block a move of
    // the same entry and stay in History). If that fails, saveMove refuses the move because of the draft.
    const previous = latest.current.failure?.pending;
    setFailure(null);
    if (previous && previous !== pending) await discardMove(previous).catch(() => undefined);
    setSaving({ entryId: pending.entry.id, range });
    setShown(null);
    try {
      await saveMove(pending);
    } catch (error) {
      setSaving(null);
      const refused = error instanceof MoveRefused;
      setFailure({ text: `Nie przesunięto wpisu #${pending.entry.id}: ${sentence(error)} ${refused ? '' : 'Nic nie zostało zmienione; wpis jest na swoim miejscu. Możesz spróbować ponownie.'}`.trim(), pending: refused ? null : pending, range });
      return;
    }
    const message = `Przesunięto wpis #${pending.entry.id}: ${describe(pending.fields, range.startMs, range.endMs)}.`;
    const before = latest.current.data;
    try {
      await onSaved(message);
      // Cleared by the effect above when the data read after the save arrives (at the latest after 5 s).
      setSaving(current => current && before && latest.current.data === before ? { ...current, before } : null);
    } catch (error) { setSaving(null); throw error; }
  }

  // Window listeners only while a press is held.
  useEffect(() => {
    function onMove(event: PointerEvent) {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!current.active) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD_PX) return;
        // The previous message stays until the drop: removing it now would shift the grid under the pointer.
        current.active = true;
      }
      event.preventDefault();
      // Autoscroll near the visible edges of the day axis (the window may cut the scroll area at 125 %).
      const area = body.current?.getBoundingClientRect();
      if (area && body.current) {
        if (event.clientY < Math.max(area.top, 0) + 32) body.current.scrollTop -= 12;
        else if (event.clientY > Math.min(area.bottom, window.innerHeight) - 32) body.current.scrollTop += 12;
      }
      propose(current, event.clientX, event.clientY);
    }
    function onUp(event: PointerEvent) {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      drag.current = null;
      try { current.node.releasePointerCapture(current.pointerId); } catch { /* already released */ }
      if (!current.active) { setShown(null); return; }
      swallowClick.current = true;
      const result = propose(current, event.clientX, event.clientY)?.result;
      if (!result) { setShown(null); return; }
      void commit(current.entry, result);
    }
    function onCancel(event: PointerEvent) { if (drag.current && event.pointerId === drag.current.pointerId) cancel(); }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel('Przeciąganie anulowane. Wpis został na swoim miejscu.'); }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
    };
  });

  function onPointerDown(block: CalendarBlock, event: ReactPointerEvent<HTMLElement>) {
    swallowClick.current = false;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || !movable(block) || drag.current) return;
    const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge;
    const kind: DragKind = edge === 'start' ? 'start' : edge === 'end' ? 'end' : 'move';
    const box = event.currentTarget.closest('.calendar-column')?.getBoundingClientRect();
    const pointer = box ? pointerMinute(event.clientY - box.top, box.height) : block.startMinute;
    drag.current = { kind, block, entry: entryOf(block), piece: pieceOf(block), pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      grab: pointer - block.startMinute, active: false, node: event.currentTarget };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    if (edge) event.preventDefault();
  }

  /** Alt+arrows propose a move (Shift: the end); Enter saves it, Esc cancels. Returns true when handled. */
  function onKeyDown(block: CalendarBlock, event: ReactKeyboardEvent<HTMLElement>): boolean {
    const pending = shown && shown.via === 'keyboard' && shown.key === block.key ? shown : null;
    if (pending && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setShown(null); setFailure({ text: 'Przesunięcie anulowane. Wpis został na swoim miejscu.', pending: null }); return true; }
    if (pending && event.key === 'Enter') { event.preventDefault(); if (pending.result) void commit(pending.entry, pending.result); return true; }
    if (!event.altKey || !movable(block)) return false;
    const action: KeyAction | undefined = event.shiftKey ? (event.key === 'ArrowUp' ? 'shorter' : event.key === 'ArrowDown' ? 'longer' : undefined) : KEYS[event.key];
    if (!action) return false;
    event.preventDefault();
    const entry = pending?.entry ?? entryOf(block);
    const from = pending?.current ?? entry;
    const stepped = keyFields(action, { id: entry.id, startMs: from.startMs, endMs: from.endMs }, zone);
    const result = checkProposal(stepped, entry, zone, now, others);
    const range = 'problem' in stepped ? null : { startMs: stepped.startMs, endMs: stepped.endMs };
    setFailure(null);
    setShown({ entryId: entry.id, key: block.key, range, result, via: 'keyboard', entry, current: range ?? from });
    return true;
  }

  /** A click right after a drag must not also open the form. */
  function consumeClick(): boolean {
    if (!swallowClick.current) return false;
    swallowClick.current = false;
    return true;
  }

  // Ghost pieces of the proposed (or saving) range on the week's days.
  const ghostRange = saving ? { range: saving.range, invalid: false } : shown?.range && (shown.result?.ok ? shown.result.changed : true) ? { range: shown.range, invalid: !shown.result?.ok } : null;
  function ghosts(date: string): ReactNode {
    if (!ghostRange || !view || date < view.from || date > view.through) return null;
    const id = saving?.entryId ?? shown?.entryId ?? 0;
    return entryPieces({ id, startedMs: ghostRange.range.startMs, endedMs: ghostRange.range.endMs }, zone).filter(piece => piece.date === date).map(piece =>
      <span key={`${piece.startMs}`} className="calendar-ghost" data-invalid={ghostRange.invalid || undefined} data-saving={saving ? true : undefined} aria-hidden="true"
        style={{ top: piece.startMinute * minutePx, height: Math.max(minBlockPx, Math.min(DAY_MINUTES - piece.startMinute, piece.endMinute - piece.startMinute) * minutePx) }}>
        <small>{pieceRange(piece)}</small>
      </span>);
  }

  const statusText = saving ? `Zapisywanie przesunięcia wpisu #${saving.entryId}…`
    : shown?.result ? (shown.result.ok
      ? (shown.result.changed ? `Wpis #${shown.entryId}: ${describe(shown.result.fields, shown.result.startMs, shown.result.endMs)}. ${shown.via === 'keyboard' ? 'Enter zapisuje, Esc anuluje.' : 'Puść, aby zapisać; Esc anuluje.'}` : `Wpis #${shown.entryId} bez zmian.`)
      : `Tu nie można przenieść wpisu #${shown.entryId}: ${shown.result.problem.message}`)
    : '';
  const status = <>
    <p className="calendar-move-status" role="status" aria-live="polite" data-problem={shown?.result && !shown.result.ok ? true : undefined}>{statusText}</p>
    {failure && <div role="alert" className="alert error calendar-move-error">
      <p>{failure.text}</p>
      <div className="actions">
        {failure.pending && <button type="button" className="primary" disabled={!editable || busy} onClick={() => { void run(failure.pending!, failure.range!); }}>Spróbuj ponownie</button>}
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          const pending = failure.pending;
          setFailure(null);
          if (pending) void discardMove(pending).catch(error => setFailure({ text: `Nie udało się odrzucić szkicu przesunięcia: ${sentence(error)} Odrzuć go w Historii (widok Timer).`, pending: null }));
        }}>{failure.pending ? 'Odrzuć zmianę' : 'Zamknij'}</button>
      </div>
    </div>}
  </>;

  return { movable, onPointerDown, onKeyDown, consumeClick, ghosts, status, movingKey: drag.current?.active || shown ? shown?.key ?? null : null, savingId: saving?.entryId ?? null };
}
