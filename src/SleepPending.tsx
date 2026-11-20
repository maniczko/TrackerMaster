import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from './App';
import { parseLocalDate } from './localDateTime';

type PendingSleep = { id: number; entryId: number; startedMs: number; endedMs: number | null; client: string; project: string; task: string | null; manualResume: boolean };

function dateTime(ms: number) {
  return new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(ms));
}

export default function SleepPending({ loaded, onResolved }: { loaded: boolean; onResolved: () => Promise<void> }) {
  const [items, setItems] = useState<PendingSleep[]>([]);
  const [showBanner, setShowBanner] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resumeInput, setResumeInput] = useState<Record<number, string>>({});
  const started = useRef(false);
  const previousIds = useRef(new Set<number>());
  const requestId = useRef(0);
  const busyRef = useRef(false);
  const bannerTimer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const next = await invoke<PendingSleep[]>('get_pending_sleep');
      if (request !== requestId.current) return;
      if (!Array.isArray(next)) throw new Error('Nieprawidłowe dane.');
      if (!started.current) {
        started.current = true;
        if (next.length) {
          setShowBanner(true);
          bannerTimer.current = window.setTimeout(() => setShowBanner(false), 10000);
        }
      } else if (next.some(item => !previousIds.current.has(item.id))) {
        setOpen(true);
      }
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
  useEffect(() => () => { if (bannerTimer.current !== undefined) window.clearTimeout(bannerTimer.current); }, []);

  async function decide(item: PendingSleep, include: boolean) {
    if (busyRef.current || item.endedMs === null) return;
    busyRef.current = true; setBusy(true); setError('');
    let saved = false;
    try {
      await invoke('resolve_sleep_period', { entryId: item.entryId, periodId: item.id, include });
      saved = true;
      await onResolved();
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
    busyRef.current = true; setBusy(true); setError('');
    let saved = false;
    try {
      await invoke('set_sleep_resume', { entryId: item.entryId, periodId: item.id, endedAt: end.toISOString() });
      saved = true;
      setResumeInput(current => { const next = { ...current }; delete next[item.id]; return next; });
      await onResolved();
      await refresh();
    } catch {
      await refresh();
      setError(saved ? 'Czas wybudzenia zapisano, ale nie udało się odświeżyć danych.' : 'Nie udało się zapisać czasu wybudzenia. Sprawdź datę i zakres pomiaru.');
    } finally { busyRef.current = false; setBusy(false); }
  }
  function showList() {
    setOpen(true); setShowBanner(false);
    window.setTimeout(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  }
  if (!loaded) return null;
  const closedMs = items.reduce((sum, item) => sum + (item.endedMs === null ? 0 : Math.max(0, item.endedMs - item.startedMs)), 0);
  const hasOpen = items.some(item => item.endedMs === null);
  const summary = `${items.length} ${items.length === 1 ? 'okres' : 'okresów'} · ${formatDuration(closedMs / 1000)}${hasOpen ? ' + nieznany czas' : ''}`;
  return <>
    {error && <div role="alert" className="alert error">{error} <button type="button" disabled={busy} onClick={() => void refresh()}>Ponów</button></div>}
    {showBanner && items.length > 0 && <div role="status" className="alert"><strong>Uśpienie do rozstrzygnięcia: {summary}.</strong> <button type="button" onClick={showList}>Przejdź do listy</button></div>}
    {items.length > 0 && <section ref={listRef} className="card pending-card" aria-label="Okresy uśpienia do rozstrzygnięcia">
      <div className="section-top"><div><h2>Uśpienie do rozstrzygnięcia</h2><p className="muted">{summary}. Te okresy nie są zaliczane do pracy przed decyzją.</p></div><button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Ukryj listę' : 'Pokaż listę'}</button></div>
      {open && <div className="table-wrap"><table><thead><tr><th>Okres</th><th>Klient / projekt / zadanie</th><th>Czas</th><th>Decyzja</th></tr></thead><tbody>{items.map(item => <tr key={item.id}>
        <td>{dateTime(item.startedMs)} – {item.endedMs === null ? 'brak czasu wybudzenia' : dateTime(item.endedMs)}</td>
        <td>{item.client} / {item.project} / {item.task || 'Bez zadania'} <small>· wpis #{item.entryId}</small></td>
        <td>{item.endedMs === null ? 'Nieznany' : <>{formatDuration((item.endedMs - item.startedMs) / 1000)}{item.manualResume && <small> · wybudzenie wskazane ręcznie</small>}</>}</td>
        <td>{item.endedMs === null ? <form onSubmit={event => { event.preventDefault(); void supplyResume(item); }}><label>Faktyczna lub szacowana godzina wybudzenia <input type="datetime-local" step="1" required disabled={busy} value={resumeInput[item.id] ?? ''} onChange={event => setResumeInput(current => ({ ...current, [item.id]: event.target.value }))} /></label> <button type="submit" className="secondary" disabled={busy || !resumeInput[item.id]}>Zapisz godzinę</button></form> : <><button type="button" className="secondary" disabled={busy} onClick={() => void decide(item, true)}>Dolicz</button>{' '}<button type="button" className="secondary" disabled={busy} onClick={() => void decide(item, false)}>Odrzuć</button></>}</td>
      </tr>)}</tbody></table><button type="button" className="secondary" onClick={() => setOpen(false)}>Później</button></div>}
    </section>}
  </>;
}
