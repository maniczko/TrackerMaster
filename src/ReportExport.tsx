import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';
import { exportCsv, formatDuration, localTimestamp, makeClientExportRows, spreadsheetText } from './reportCsv';
import type { ExportEntry, ExportRow } from './reportCsv';

type ExportData = { client_id: number; client: string; time_zone: string; entries: ExportEntry[] };
type Preview = { key: string; client: string; from: string; through: string; zone: string; rows: ExportRow[]; csv: string; total: number };

export default function ReportExport({ client, from, through, zone }: { client: string; from: string; through: string; zone: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = JSON.stringify([client, from, through, zone]);
  const current = preview?.key === key ? preview : null;

  async function prepare() {
    setBusy(true); setError(''); setPreview(null);
    try {
      const data = await invoke<ExportData>('get_client_export_data', { clientId: Number(client) });
      if (String(data.client_id) !== client || data.time_zone !== zone) throw new Error('Klient lub strefa raportu uległy zmianie. Odśwież raport i przygotuj podgląd ponownie.');
      const rows = makeClientExportRows(data.entries, data.client, from, through, zone);
      setPreview({ key, client: data.client, from, through, zone, rows, csv: exportCsv(rows, zone), total: rows.reduce((sum, row) => sum + row.contribution, 0) });
    } catch (e) { setError(`Nie udało się przygotować eksportu: ${String(e)}`); }
    finally { setBusy(false); }
  }

  function download() {
    if (!current) return;
    try {
      const url = URL.createObjectURL(new Blob([current.csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `TrackerMaster-${current.from}-${current.through}.csv`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setError('');
    } catch (e) { setError(`Nie udało się pobrać pliku: ${String(e)}`); }
  }

  return <section className="report-export" aria-label="Eksport CSV">
    <h3>Eksport CSV klienta</h3>
    <p className="muted">Wybierz jednego klienta i zakres raportu, a następnie sprawdź podgląd. Plik obejmuje zakończone wpisy z rozstrzygniętymi przerwami.</p>
    <button type="button" className="secondary report-button" disabled={!client || !zone || busy} onClick={() => void prepare()}>{busy ? 'Przygotowywanie…' : 'Przygotuj podgląd CSV'}</button>
    {error && <div role="alert" className="alert error">{error}</div>}
    {current && <div className="export-preview">
      <p>Klient: <strong>{spreadsheetText(current.client)}</strong> · {current.from} — {current.through} · {current.zone}</p>
      <p>Liczba wpisów: <strong>{current.rows.length}</strong> · Czas w okresie: <strong>{formatDuration(current.total)}</strong></p>
      <p className="muted">Podgląd i plik zawierają te same zakończone wpisy. Tekst podobny do formuły otrzyma apostrof ochronny.</p>
      {current.rows.length > 0 && <div className="table-wrap"><table><thead><tr><th>ID</th><th>Projekt</th><th>Zadanie</th><th>Opis</th><th>Początek</th><th>Koniec</th><th>Rozliczalny</th><th>Cały wpis</th><th>W okresie</th></tr></thead><tbody>{current.rows.map(({ source, contribution }) => <tr key={source.id}><td>{source.id}</td><td>{spreadsheetText(source.project)}</td><td>{spreadsheetText(source.task)}</td><td>{spreadsheetText(source.description)}</td><td>{localTimestamp(source.started_at, current.zone)}</td><td>{localTimestamp(source.ended_at, current.zone)}</td><td>{source.billable ? 'Tak' : 'Nie'}</td><td>{formatDuration(source.duration_seconds)} ({source.duration_seconds} s)</td><td>{formatDuration(contribution)} ({contribution} s)</td></tr>)}</tbody></table></div>}
      <button type="button" className="secondary report-button" onClick={download}>Potwierdź i pobierz CSV</button>
    </div>}
  </section>;
}
