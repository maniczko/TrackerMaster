// The initial implementation deliberately covers Warsaw only. Other IANA zones
// need their own transition coverage before the setting can be exposed.
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
});

export type ReportEntry = {
  id: number; started_at: string; ended_at: string; duration_seconds: number;
};
export type ReportDay = { date: string; seconds: number };
export type ReportResult = {
  days: ReportDay[]; totalSeconds: number; averageSeconds: number | null;
  excludedEntryIds: number[];
};

function localDate(ms: number): string {
  const parts = formatter.formatToParts(ms);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * Allocate a verified elapsed duration to local days. Half-open intervals and
 * cumulative flooring ensure that fractional seconds are counted exactly once.
 * A discrepancy with stored seconds is excluded, not silently redistributed.
 */
export function reportByWarsawDay(entries: ReportEntry[], from: string, through: string): ReportResult {
  if (!validDate(from) || !validDate(through) || from > through || from < '1970-01-01') {
    throw new Error('Nieprawidłowy zakres dat raportu.');
  }
  const totals = new Map<string, number>();
  const excludedEntryIds: number[] = [];
  const ids = new Set<number>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error('Powtórzony wpis w danych raportu.');
    ids.add(entry.id);
    const start = Date.parse(entry.started_at);
    const end = Date.parse(entry.ended_at);
    const hasOffsets = /(?:Z|[+-]\d\d:\d\d)$/i.test(entry.started_at) && /(?:Z|[+-]\d\d:\d\d)$/i.test(entry.ended_at);
    // Bounds avoid ambiguous historical calendar transitions and excessive work.
    if (!hasOffsets || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start ||
        end - start > 3660 * 86400_000 || !Number.isSafeInteger(entry.duration_seconds) ||
        entry.duration_seconds < 0 || Math.floor((end - start) / 1000) !== entry.duration_seconds) {
      excludedEntryIds.push(entry.id);
      continue;
    }
    let cursor = start;
    while (cursor < end) {
      const day = localDate(cursor);
      // Warsaw's civil date cannot change twice within six hours from 1970.
      let probe = Math.min(cursor + 6 * 3600_000, end);
      while (probe < end && localDate(probe) === day) probe = Math.min(probe + 6 * 3600_000, end);
      let boundary = end;
      if (localDate(probe) !== day) {
        let low = cursor, high = probe;
        while (high - low > 1) {
          const mid = Math.floor((low + high) / 2);
          if (localDate(mid) === day) low = mid; else high = mid;
        }
        boundary = high;
      }
      const seconds = Math.floor((boundary - start) / 1000) - Math.floor((cursor - start) / 1000);
      if (day >= from && day <= through && seconds > 0) totals.set(day, (totals.get(day) ?? 0) + seconds);
      cursor = boundary;
    }
  }
  const days = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds }));
  const totalSeconds = days.reduce((sum, day) => sum + day.seconds, 0);
  return { days, totalSeconds, averageSeconds: days.length ? totalSeconds / days.length : null, excludedEntryIds };
}
