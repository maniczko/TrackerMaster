import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

export type AutostartStatus = {
  enabled: boolean;
  packaged_msix: boolean;
  registry_value: string;
  command: string | null;
  note: string;
};

export default function AutostartSettings() {
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setBusy(true);
    setError('');
    try {
      setStatus(await invoke<AutostartStatus>('get_autostart'));
    } catch (e) {
      setError(`Nie udało się odczytać ustawień autostartu: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    void invoke<AutostartStatus>('get_autostart')
      .then(next => {
        if (active) setStatus(next);
      })
      .catch(e => {
        if (active) setError(`Nie udało się odczytać ustawień autostartu: ${String(e)}`);
      });
    return () => { active = false; };
  }, []);

  async function apply(enabled: boolean) {
    setBusy(true);
    setPendingValue(enabled);
    setError('');
    setNotice('');
    try {
      const next = await invoke<AutostartStatus>('set_autostart', { enabled });
      setStatus(next);
      setPendingValue(null);
      setNotice(next.enabled
        ? 'Autostart po zalogowaniu do Windows został włączony. Otwarcie aplikacji nigdy nie uruchamia pomiaru automatycznie.'
        : 'Autostart przy logowaniu do Windows został wyłączony.');
    } catch (e) {
      setError(`Nie udało się zapisać ustawienia autostartu: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card autostart-settings" aria-label="Autostart Windows">
      <div className="section-top">
        <div>
          <p className="section-kicker">URUCHAMIANIE SYSTEMU</p>
          <h2>Autostart Windows</h2>
        </div>
      </div>
      <p className="muted">
        Opcjonalnie uruchamiaj TrackerMaster po zalogowaniu bieżącego użytkownika Windows. Sam autostart nigdy nie rozpoczyna pomiaru czasu.
      </p>
      {status && (
        <p>
          Stan: <strong>{status.enabled ? 'Włączony' : 'Wyłączony'}</strong>
          {status.packaged_msix ? ' · pakiet MSIX' : ' · klucz użytkownika HKCU'}
        </p>
      )}
      <div className="actions">
        <label>
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={busy || !status}
            onChange={e => void apply(e.target.checked)}
          />{' '}
          Uruchamiaj TrackerMaster przy logowaniu do Windows
        </label>
      </div>
      {status?.command && <p className="muted">Polecenie: <code>{status.command}</code></p>}
      {status?.note && <p className="muted">{status.note}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div className="alert error" role="alert">
          <span>{error}</span>{' '}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void (pendingValue === null ? load() : apply(pendingValue))}
          >
            Ponów
          </button>
        </div>
      )}
    </section>
  );
}
