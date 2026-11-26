// DEV-41b: History search & date-range toolbar. Kept strictly in React state (never stored or logged).
import type { RefObject } from 'react';
import { MAX_SEARCH_LENGTH } from './historySearch';
import type { SearchSummary } from './historySearch';
import { pluralForm } from './plural';
import { formatDuration } from './reportCsv';
import { reportPresets } from './reportPresets';
import type { ReportPreset } from './reportPresets';

export type HistoryRangeMode = 'all' | ReportPreset | 'custom';

type Props = {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  onQueryChange: (next: string) => void;
  onClearAll: () => void;
  rangeMode: HistoryRangeMode;
  onRangeModeChange: (next: HistoryRangeMode) => void;
  customRange: { from: string; through: string };
  onCustomRangeChange: (next: { from: string; through: string }) => void;
  customInvalid: boolean;
  isSearchMode: boolean;
  loaded: boolean;
  reportFailed: boolean;
  reportReady: boolean;
  totalsPending: boolean;
  summary: SearchSummary | null;
};

export default function HistorySearchBar({
  inputRef,
  query,
  onQueryChange,
  onClearAll,
  rangeMode,
  onRangeModeChange,
  customRange,
  onCustomRangeChange,
  customInvalid,
  isSearchMode,
  loaded,
  reportFailed,
  reportReady,
  totalsPending,
  summary,
}: Props) {
  const entryWord = summary ? pluralForm(summary.entries.length, 'wpis', 'wpisy', 'wpisów') : '';
  const cleanPhrase = query.trim();

  return (
    <div className="history-search" role="search" aria-label="Wyszukiwanie w historii">
      <div className="history-search-controls">
        <div className="history-search-field">
          <label htmlFor="history-search-input">Szukaj w historii</label>
          <div className="history-search-input-row">
            <input
              id="history-search-input"
              ref={inputRef}
              type="text"
              value={query}
              maxLength={MAX_SEARCH_LENGTH}
              placeholder="Opis, klient, projekt lub zadanie… (Ctrl+F)"
              onChange={event => onQueryChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  if (query.length > 0) onQueryChange('');
                  else event.currentTarget.blur();
                }
              }}
            />
            {query.length > 0 && (
              <button
                type="button"
                className="secondary history-search-clear"
                aria-label="Wyczyść wyszukiwanie"
                title="Wyczyść frazę (Esc)"
                onClick={() => {
                  onQueryChange('');
                  inputRef.current?.focus();
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
        <label className="history-search-range">
          Okres
          <select
            id="history-search-range"
            value={rangeMode}
            onChange={event => onRangeModeChange(event.target.value as HistoryRangeMode)}
          >
            <option value="all">Cała historia</option>
            {reportPresets.map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
            <option value="custom">Własny zakres</option>
          </select>
        </label>
        {rangeMode === 'custom' && (
          <div className="history-search-custom">
            <label>
              Od
              <input
                type="date"
                aria-label="Data od"
                value={customRange.from}
                onChange={event => onCustomRangeChange({ ...customRange, from: event.target.value })}
              />
            </label>
            <label>
              Do
              <input
                type="date"
                aria-label="Data do"
                value={customRange.through}
                onChange={event => onCustomRangeChange({ ...customRange, through: event.target.value })}
              />
            </label>
          </div>
        )}
      </div>
      {isSearchMode && (
        <div className="history-search-meta">
          {!loaded || reportFailed ? (
            <p role="status" className="muted">Wyszukiwanie będzie dostępne po odczytaniu danych.</p>
          ) : !reportReady ? (
            <p role="status" className="muted">Wczytywanie danych wyszukiwania…</p>
          ) : customInvalid ? (
            <p role="alert" className="alert error">Sprawdź zakres dat wyszukiwania (data „od” nie może być późniejsza niż „do”).</p>
          ) : totalsPending ? (
            <p role="status" aria-live="polite" className="history-search-summary">Liczenie sumy…</p>
          ) : summary ? (
            <>
              <p role="status" aria-live="polite" className="history-search-summary">
                <strong>{summary.entries.length} {entryWord}</strong>
                {' · '}
                <span>{formatDuration(summary.seconds)}</span>
                {summary.pendingSeconds > 0 && ` · ${formatDuration(summary.pendingSeconds)} oczekuje na decyzję`}
                {summary.includesRunning && ' · z trwającym pomiarem'}
              </p>
              {summary.excludedEntries > 0 && (
                <p role="alert" className="alert error">
                  Pominięto niespójne wpisy ({summary.excludedEntries}) poza sumą raportu.
                </p>
              )}
              {summary.entries.length === 0 && (
                <div className="history-search-empty">
                  <p className="muted">
                    {cleanPhrase
                      ? `Brak wpisów pasujących do „${cleanPhrase}”`
                      : 'Brak wpisów w wybranym zakresie dat'}
                    {rangeMode !== 'all' ? ' w wybranym okresie.' : '.'}
                  </p>
                  <button type="button" className="secondary" onClick={onClearAll}>Wyczyść wyszukiwanie</button>
                </div>
              )}
            </>
          ) : null}
          <p className="helper">
            Wyszukiwanie obejmuje wszystkie zapisane wpisy (również zarchiwizowane) oraz rozstrzygnięty aktywny pomiar; fraza nie jest nigdzie zapisywana.
          </p>
        </div>
      )}
    </div>
  );
}
