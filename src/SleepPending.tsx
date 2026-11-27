import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from './App';
import { localInputRange, localRangeProblem, parseLocalDate } from './localDateTime';
import type { LocalRangeProblem } from './localDateTime';
import { sleepPeriodCount } from './plural';

type PendingSleep = { id: number; entryId: number; startedMs: number; endedMs: number | null; client: string; project: string; task: string | null; manualResume: boolean; source?: 'sleep' | 'idle' };

// UI hints only; the backend checks the wake-up time against the sleep period and the clock.
const resumeHints: Record<LocalRangeProblem, string> = {
  invalid: 'Podaj jednoznaczną datę i godzinę wybudzenia.',
  before: 'Ta godzina jest wcześniejsza niż początek uśpienia. Wybierz późniejszą.',
  after: 'Ta godzina jest w przyszłości. Wybierz czas nie późniejszy niż teraz.',
};

function dateTime(ms: number) {
  return new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(ms));
}

/**
 * Sleep periods awaiting a decision. The state lives in the main window so that one short note
 * (in the timer review banner or on its own) points to the list, which sits below the timer.
 */
export function usePendingSleep(loaded: boolean, onResolved: () => Promise<void>) {
  const [items, setItems] = useState<PendingSleep[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resumeInput, setResumeInput] = useState<Record<number, string>>({});
  const [now, setNow] = useState(Date.now());
  const started = useRef(false);
  const previousIds = useRef(new Set<number>());
  const requestId = useRef(0);
  const busyRef = useRef(false);
  const listRef = useRef<HTMLElement>(null);
  const resolved = useRef(onResolved);
  resolved.current = onResolved;

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const next = await invoke<PendingSleep[]>('get_pending_sleep');
      if (request !== requestId.current) return;
      if (!Array.isArray(next)) throw new Error('Nieprawidłowe dane.');
      // New periods after the first read open the list; at start-up the note above the timer is enough.
      if (!started.current) started.current = true;
      else if (next.some(item => !previousIds.current.has(item.id))) setOpen(true);
      previousIds.current = new Set(next.map(item => item.id));
      setItems(next); setError('');
    } catch {
      if (request === requestId.current) setError('Nie można odczytać okresów uśpienia. Spróbuj ponownie.');
    }
  }, []);
  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    let timer: number | undefined;
    async function poll() {
      await refresh();
      if (!stopped) timer = window.setTimeout(poll, 5000);
    }
    void poll();
    return () => { stopped = true; requestId.current++; if (timer !== undefined) window.clearTimeout(timer); };
  }, [loaded, refresh]);

  async function decide(item: PendingSleep, include: boolean) {
    if (busyRef.current || item.endedMs === null) return;
    busyRef.current = true; setBusy(true); setError('');
    let saved = false;
    try {
      await invoke('resolve_sleep_period', { entryId: item.entryId, periodId: item.id, include });
      saved = true;
      await resolved.current();
      await refresh();
    } catch {
      await refresh();
      setError(saved ? 'Decyzja została zapisana, ale nie udało się odświeżyć danych.' : 'Nie udało się zapisać decyzji. Sprawdź listę i spróbuj ponownie.');
    } finally { busyRef.current = false; setBusy(false); }
  }
  async function supplyResume(item: PendingSleep) {
    if (busyRef.current || item.endedMs !== null) return;
    const end = parseLocalDate(resumeInput[item.id] ?? '');
    if (!end) { setError('Podaj jednoznaczną datę i godzinę wybudzenia.'); return; }
    const problem = localRangeProblem(resumeInput[item.id] ?? '', item.startedMs, Date.now());
    if (problem) { setError(resumeHints[problem]); return; }
    busyRef.current = true; setBusy(true); setError('');
    let saved = false;
    try {
      await invoke('set_sleep_resume', { entryId: item.entryId, periodId: item.id, endedAt: end.toISOString() });
      saved = true;
      setResumeInput(current => { const next = { ...current }; delete next[item.id]; return next; });
      await resolved.current();
      await refresh();
    } catch {
      await refresh();
      setError(saved ? 'Czas wybudzenia zapisano, ale nie udało się odświeżyć danych.' : 'Nie udało się zapisać czasu wybudzenia. Sprawdź datę i zakres pomiaru.');
    } finally { busyRef.current = false; setBusy(false); }
  }
  // The list renders below the timer only once open, so the scroll waits for that render.
  const [scrollRequest, setScrollRequest] = useState(0);
  useEffect(() => {
    if (scrollRequest) listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [scrollRequest]);
  function showList() {
    setOpen(true);
    setScrollRequest(value => value + 1);
  }
  const waitingForResume = items.some(item => item.endedMs === null);
  useEffect(() => {
    if (!waitingForResume) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [waitingForResume]);
  const closedMs = items.reduce((sum, item) => sum + (item.endedMs === null ? 0 : Math.max(0, item.endedMs - item.startedMs)), 0);
  const summary = `${sleepPeriodCount(items.length)} · ${formatDuration(closedMs / 1000)}${waitingForResume ? ' + nieznany czas' : ''}`;
  return { loaded, items, summary, open, setOpen, showList, listRef, busy, error, refresh, decide, supplyResume, resumeInput, setResumeInput, now, setNow };
}
export type PendingSleepState = ReturnType<typeof usePendingSleep>;

/** A failed read of the sleep periods, shown above the timer. */
export function SleepReadError({ sleep }: { sleep: PendingSleepState }) {
  if (!sleep.loaded || !sleep.error) return null;
  return <div role="alert" className="alert error">{sleep.error} <button type="button" disabled={sleep.busy} onClick={() => void sleep.refresh()}>Ponów</button></div>;
}

/** One line about the periods with the only button that leads to the list. */
export function SleepNote({ sleep }: { sleep: PendingSleepState }) {
  if (!sleep.loaded || !sleep.items.length) return null;
  const hasSleep = sleep.items.some(item => item.source !== 'idle');
  const hasIdle = sleep.items.some(item => item.source === 'idle');
  const heading = hasSleep && hasIdle
    ? 'Okresy do rozstrzygnięcia'
    : hasIdle
      ? 'Bezczynność do rozstrzygnięcia'
      : 'Uśpienie do rozstrzygnięcia';
  return <p className="sleep-note"><strong>{heading}: {sleep.summary}.</strong>{' '}
    <button type="button" aria-controls="pending-sleep-list" aria-expanded={sleep.open} onClick={sleep.showList}>Przejdź do listy</button></p>;
}

/** The list with decisions, below the timer; it opens from the note or when a new period appears. */
export function SleepPendingList({ sleep }: { sleep: PendingSleepState }) {
  const { items, open, busy, now, resumeInput } = sleep;
  if (!sleep.loaded || !items.length || !open) return null;
  return <section ref={sleep.listRef} id="pending-sleep-list" className="card pending-card" aria-label="Okresy do rozstrzygnięcia">
    <div className="section-top"><div><h2>Okresy do rozstrzygnięcia</h2><p className="muted">{sleep.summary}. Te okresy nie są zaliczane do pracy przed decyzją.</p></div></div>
    <div className="table-wrap"><table><thead><tr><th>Rodzaj i okres</th><th>Klient / projekt / zadanie</th><th>Czas</th><th>Decyzja</th></tr></thead><tbody>{items.map(item => { const resumeValue = resumeInput[item.id] ?? ''; const isIdle = item.source === 'idle'; const limits = localInputRange(item.startedMs, now); const problem = item.endedMs === null && !isIdle ? localRangeProblem(resumeValue, item.startedMs, now) : null; return <tr key={item.id}>
      <td><span className="pending-kind" data-source={isIdle ? 'idle' : 'sleep'}>{isIdle ? 'Bezczynność' : 'Uśpienie'}</span> {dateTime(item.startedMs)} – {item.endedMs === null ? (isIdle ? 'trwa' : 'brak czasu wybudzenia') : dateTime(item.endedMs)}</td>
      <td>{item.client} / {item.project} / {item.task || 'Bez zadania'} <small>· wpis #{item.entryId}</small></td>
      <td>{item.endedMs === null ? 'Nieznany' : <>{formatDuration((item.endedMs - item.startedMs) / 1000)}{item.manualResume && <small>{isIdle ? ' · koniec wpisu przy odzyskaniu' : ' · wybudzenie wskazane ręcznie'}</small>}</>}</td>
      <td>{item.endedMs === null
        ? (isIdle
          ? <span className="muted">Bezczynność trwa — zamknie się po powrocie.</span>
          : <form onSubmit={event => { event.preventDefault(); void sleep.supplyResume(item); }}><label>Faktyczna lub szacowana godzina wybudzenia <input type="datetime-local" step="1" required disabled={busy} min={limits.min} max={limits.max} aria-invalid={problem !== null} aria-describedby={problem ? `resume-problem-${item.id}` : undefined} value={resumeValue} onFocus={() => sleep.setNow(Date.now())} onChange={event => { sleep.setNow(Date.now()); sleep.setResumeInput(current => ({ ...current, [item.id]: event.target.value })); }} /></label> <button type="submit" className="primary" disabled={busy || !resumeValue || problem !== null}>Zapisz godzinę</button>{problem && <p id={`resume-problem-${item.id}`} className="field-problem" role="status">{resumeHints[problem]}</p>}</form>)
        : <><button type="button" className="secondary" disabled={busy} onClick={() => void sleep.decide(item, true)}>Dolicz</button>{' '}<button type="button" className="secondary" disabled={busy} onClick={() => void sleep.decide(item, false)}>Odrzuć</button></>}</td>
    </tr>; })}</tbody></table><button type="button" className="secondary" onClick={() => sleep.setOpen(false)}>Później</button></div>
  </section>;
}
