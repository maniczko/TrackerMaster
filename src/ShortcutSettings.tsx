import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { defaultShortcut, shortcutKeys, shortcutLabel } from './shortcut';

type ShortcutStatus = { registered: boolean; message: string; shortcut: string };

export default function ShortcutSettings({ onChange }: { onChange?: (status: ShortcutStatus) => void } = {}) {
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  const [modifier, setModifier] = useState('Shift');
  const [key, setKey] = useState('Space');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void invoke<ShortcutStatus>('shortcut_status').then(next => {
      if (!active) return;
      setStatus(next); const parts = (next.shortcut || defaultShortcut).split('+'); setModifier(parts[1]); setKey(parts[2]);
    }).catch(() => { if (active) setError('Nie udało się odczytać ustawienia skrótu.'); });
    return () => { active = false; };
  }, []);
  async function save() {
    if (!status) return;
    if (key === 'F12' && status.shortcut !== `Ctrl+${modifier}+F12`) {
      setError('Klawisz F12 jest zarezerwowany przez system Windows. Wybierz inny klawisz.');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await invoke<ShortcutStatus>('set_global_shortcut', { shortcut: `Ctrl+${modifier}+${key}`, expected: status.shortcut });
      setStatus(next); onChange?.(next); setNotice(`Zapisano skrót ${shortcutLabel(next.shortcut)}.`);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <section className="card shortcut-settings" aria-label="Skrót klawiaturowy">
    <div className="section-top"><div><p className="section-kicker">SZYBKIE STEROWANIE</p><h2>Skrót klawiaturowy</h2></div></div>
    <p className="muted">Uruchamiaj lub zatrzymuj pomiar także wtedy, gdy pracujesz w innym programie. Wybierz projekt w mini timerze przed rozpoczęciem pomiaru.</p>
    {status && <p>Aktualny skrót: <strong>{shortcutLabel(status.shortcut || defaultShortcut)}</strong> {status.registered ? '· aktywny globalnie' : '· niedostępny globalnie'}</p>}
    {key === 'F12' && <p role="status">Windows rezerwuje F12 dla debuggera. Wybierz inny klawisz, aby skrót działał niezawodnie.</p>}
    <div className="actions"><label>Kombinacja<select value={modifier} disabled={busy || !status} onChange={e => setModifier(e.target.value)}><option value="Shift">Ctrl + Shift</option><option value="Alt">Ctrl + Alt</option></select></label><label>Klawisz<select value={key} disabled={busy || !status} onChange={e => setKey(e.target.value)}>{shortcutKeys.map(k => <option key={k} value={k}>{k === 'Space' ? 'Spacja' : k}</option>)}</select></label><button className="secondary" type="button" disabled={busy || !status} onClick={() => void save()}>Zapisz skrót</button></div>
    {notice && <p role="status">{notice}</p>}{(error || status?.message) && <div className="alert error" role="alert">{error || status?.message}</div>}
  </section>;
}
