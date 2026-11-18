import { useRef, useState } from 'react';
import { validTimeZone } from './reportTime';

type Props = {
  currentZone: string;
  canChange: () => boolean;
  onApply: (expectedTimeZone: string, timeZone: string) => Promise<void>;
};

export default function ReportTimezone({ currentZone, canChange, onApply }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ previous: string; next: string } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const value = draft ?? currentZone;

  function closeConfirmation() {
    dialog.current?.close();
    setConfirmation(null);
    setDraft(null);
    setError('');
  }

  function review() {
    if (!canChange()) return;
    if (!validTimeZone(value)) {
      setError('Podaj poprawną nazwę strefy IANA, np. Europe/Warsaw.');
      return;
    }
    setError('');
    setConfirmation({ previous: currentZone, next: value });
    dialog.current?.showModal();
  }

  async function apply() {
    if (!confirmation || saving) return;
    setSaving(true);
    setError('');
    try {
      await onApply(confirmation.previous, confirmation.next);
      closeConfirmation();
    } catch (problem) {
      setError(`Nie udało się zapisać strefy: ${String(problem)}`);
    } finally {
      setSaving(false);
    }
  }

  return <details className="report-zone">
    <summary>Zmień strefę raportowania</summary>
    <label>Strefa raportowania<input value={value} list="report-time-zones" onChange={event => {
      setDraft(event.target.value);
      setError('');
    }} /></label>
    <datalist id="report-time-zones">
      <option value="Europe/Warsaw" /><option value="Europe/London" /><option value="Europe/Berlin" />
      <option value="America/New_York" /><option value="UTC" />
    </datalist>
    <button className="secondary report-button" type="button" disabled={value === currentZone} onClick={review}>Sprawdź zmianę strefy</button>
    {!confirmation && error && <p role="alert" className="alert error">{error}</p>}
    <dialog ref={dialog} className="report-zone-confirmation" aria-labelledby="report-zone-title" aria-describedby="report-zone-impact"
      onCancel={event => { event.preventDefault(); if (!saving) closeConfirmation(); }}>
      <h3 id="report-zone-title">Zmiana strefy raportowania</h3>
      <p id="report-zone-impact">Zmiana strefy może zmienić daty i sumy raportów historycznych. Rzeczywisty czas wpisów pozostanie taki sam.</p>
      <dl>
        <dt>Bieżąca strefa</dt><dd>{confirmation?.previous}</dd>
        <dt>Nowa strefa</dt><dd>{confirmation?.next}</dd>
      </dl>
      {error && <p role="alert" className="alert error">{error}</p>}
      <div className="actions">
        <button type="button" className="secondary" autoFocus disabled={saving} onClick={closeConfirmation}>Anuluj</button>
        <button type="button" className="primary" disabled={saving} onClick={() => void apply()}>{saving ? 'Zapisywanie…' : 'Zastosuj'}</button>
      </div>
    </dialog>
  </details>;
}
