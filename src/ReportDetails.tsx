import { useMemo, useState } from 'react';
import { formatDuration, localTimestamp } from './reportCsv';
import { sortReportRows } from './reportView';
import type { ReportDetailRow, ReportSortField } from './reportView';

type Props = {
  rows: ReportDetailRow[];
  zone: string;
  finalizedSeconds: number;
  onEdit: (entryId: number) => void;
  onHistory: (entryId: number) => void;
};

const pageSize = 50;
const optionalColumns = [
  ['client', 'Klient'], ['project', 'Projekt'], ['task', 'Zadanie'],
  ['description', 'Opis'], ['billable', 'Rozliczalność'],
] as const;
type OptionalColumn = typeof optionalColumns[number][0];
const statusLabels = { finalized: 'Zakończony', running: 'Aktywny · orientacyjnie', pending: 'Przerwa do rozstrzygnięcia' };

function ReportTimestamp({ value, zone }: { value: string; zone: string }) {
  const [day, clock] = localTimestamp(value, zone).split('T');
  return <time dateTime={value}>{day}<small>{clock}</small></time>;
}

export default function ReportDetails({ rows, zone, finalizedSeconds, onEdit, onHistory }: Props) {
  const [sort, setSort] = useState<{ field: ReportSortField; descending: boolean }>({ field: 'start', descending: true });
  const [page, setPage] = useState(0);
  const [hidden, setHidden] = useState<OptionalColumn[]>([]);
  const sorted = useMemo(() => sortReportRows(rows, sort.field, sort.descending), [rows, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visibleColumns = optionalColumns.filter(([key]) => !hidden.includes(key));
  const currentRows = sorted.slice(current * pageSize, (current + 1) * pageSize);

  function sortHeader(label: string, field: ReportSortField) {
    const selected = sort.field === field;
    return <th scope="col" aria-sort={selected ? sort.descending ? 'descending' : 'ascending' : undefined}>
      <button className="report-sort" type="button" onClick={() => {
        setSort({ field, descending: selected ? !sort.descending : true });
        setPage(0);
      }}>{label}{selected && <span aria-hidden="true">{sort.descending ? ' ↓' : ' ↑'}</span>}</button>
    </th>;
  }

  return <section className="report-detail" aria-label="Szczegóły raportu">
    <div className="section-top">
      <h3>Szczegóły raportu</h3>
      {rows.length > 0 && <details className="report-columns">
        <summary>Kolumny</summary>
        {optionalColumns.map(([key, label]) => <label key={key}>
          <input type="checkbox" checked={!hidden.includes(key)} onChange={event => {
            const show = event.target.checked;
            setHidden(current => show ? current.filter(column => column !== key) : [...current, key]);
          }} />
          {label}
        </label>)}
      </details>}
    </div>
    {rows.length === 0 ? <p className="muted">Brak wpisów w wybranym zakresie.</p> : <>
      <p className="muted">Zatwierdzony czas w okresie <strong>{formatDuration(finalizedSeconds)}</strong></p>
      <div className="table-wrap"><table>
        <thead><tr>
          <th scope="col">Wpis</th>
          {visibleColumns.map(([key, label]) => <th scope="col" key={key}>{label}</th>)}
          {sortHeader('Rozpoczęcie', 'start')}
          {sortHeader('Zakończenie', 'end')}
          {sortHeader('Cały wpis', 'duration')}
          {sortHeader('W okresie', 'contribution')}
          <th scope="col">Operacje</th>
        </tr></thead>
        <tbody>{currentRows.map(({ source, status, contribution, pendingSeconds }) => <tr key={source.id}>
          <th scope="row">#{source.id}<span className="report-row-status" data-state={status}>{statusLabels[status]}</span></th>
          {visibleColumns.map(([key]) => <td className={`report-column-${key}`} key={key}>{key === 'billable' ? source.billable ? 'Tak' : 'Nie' : source[key] || '—'}</td>)}
          <td className="report-timestamp"><ReportTimestamp value={source.started_at} zone={zone} /></td>
          <td className="report-timestamp">{status === 'running' ? 'W trakcie' : <ReportTimestamp value={source.ended_at} zone={zone} />}</td>
          <td className="duration">{formatDuration(source.duration_seconds)}</td>
          <td className="duration">{formatDuration(contribution)}
            {pendingSeconds > 0 && <span className="report-row-status">Przerwa {formatDuration(pendingSeconds)}</span>}
          </td>
          <td>{status !== 'running' && <div className="report-row-actions">
            <button className="secondary report-button" type="button" aria-label={`Popraw wpis #${source.id}`} onClick={() => onEdit(source.id)}>Popraw</button>
            <button className="secondary report-button" type="button" aria-label={`Historia zmian wpisu #${source.id}`} onClick={() => onHistory(source.id)}>Historia</button>
          </div>}</td>
        </tr>)}</tbody>
      </table></div>
      {pages > 1 && <nav className="report-pagination" aria-label="Strony szczegółów raportu">
        <button className="secondary report-button" type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>Poprzednia</button>
        <span role="status">Strona {current + 1} z {pages} · {rows.length} wpisów</span>
        <button className="secondary report-button" type="button" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>Następna</button>
      </nav>}
    </>}
  </section>;
}
