/**
 * Segment a single time entry without assigning undecided sleep to work.
 * UTC milliseconds avoid local clock changes; intervals are half-open.
 * This is not yet wired to the report or the native sleep detector.
 */
export type SleepDecision = 'pending' | 'included' | 'excluded';
export type SleepPeriod = {
  id: number;
  entryId: number;
  startedMs: number;
  endedMs: number | null;
  decision: SleepDecision;
};
export type TimeSegment = { startedMs: number; endedMs: number; kind: 'work' | 'pending' | 'excluded'; sleepId?: number; open?: boolean };
export type SleepSplit = { segments: TimeSegment[]; workMs: number; pendingMs: number; excludedMs: number; hasOpenSleep: boolean };

export function splitSleepTime(entryId: number, startedMs: number, endedMs: number, periods: readonly SleepPeriod[]): SleepSplit {
  if (!Number.isSafeInteger(entryId) || entryId <= 0 || !Number.isSafeInteger(startedMs) || !Number.isSafeInteger(endedMs) || startedMs < 0 || endedMs < startedMs || !Number.isSafeInteger(endedMs - startedMs)) {
    throw new Error('Nieprawidłowy zakres wpisu.');
  }
  const ids = new Set<number>();
  const sorted = [...periods].sort((a, b) => a.startedMs - b.startedMs);
  const segments: TimeSegment[] = [];
  let cursor = startedMs;
  let hasOpenSleep = false;
  for (const p of sorted) {
    if (!Number.isSafeInteger(p.id) || p.id <= 0 || ids.has(p.id) || p.entryId !== entryId || !Number.isSafeInteger(p.startedMs) || p.startedMs < cursor || p.startedMs < startedMs || p.startedMs >= endedMs || !['pending', 'included', 'excluded'].includes(p.decision)) {
      throw new Error('Nieprawidłowy lub nakładający się okres uśpienia.');
    }
    ids.add(p.id);
    const open = p.endedMs === null;
    if (open && (p.decision !== 'pending' || hasOpenSleep)) throw new Error('Nieprawidłowe otwarte uśpienie.');
    const end = p.endedMs ?? endedMs;
    if (!Number.isSafeInteger(end) || end <= p.startedMs || end > endedMs) throw new Error('Nieprawidłowy koniec uśpienia.');
    if (cursor < p.startedMs) segments.push({ startedMs: cursor, endedMs: p.startedMs, kind: 'work' });
    segments.push({ startedMs: p.startedMs, endedMs: end, kind: p.decision === 'included' ? 'work' : p.decision, sleepId: p.id, ...(open ? { open: true } : {}) });
    cursor = end;
    hasOpenSleep ||= open;
  }
  if (cursor < endedMs) segments.push({ startedMs: cursor, endedMs, kind: 'work' });
  const totals = { workMs: 0, pendingMs: 0, excludedMs: 0 };
  for (const part of segments) {
    const duration = part.endedMs - part.startedMs;
    if (part.kind === 'work') totals.workMs += duration;
    else if (part.kind === 'pending') totals.pendingMs += duration;
    else totals.excludedMs += duration;
  }
  return { segments, ...totals, hasOpenSleep };
}
