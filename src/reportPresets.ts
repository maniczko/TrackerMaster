import { Temporal } from '@js-temporal/polyfill';

export const reportPresets = [
  ['today', 'Dzisiaj'],
  ['yesterday', 'Wczoraj'],
  ['week', 'Ten tydzień'],
  ['previousWeek', 'Poprzedni tydzień'],
  ['month', 'Ten miesiąc'],
  ['previousMonth', 'Poprzedni miesiąc'],
] as const;

export type ReportPreset = typeof reportPresets[number][0];

export function reportPresetRange(preset: ReportPreset, instant: number, zone: string) {
  const today = Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(zone).toPlainDate();
  if (preset === 'today' || preset === 'yesterday') {
    const date = today.subtract({ days: preset === 'yesterday' ? 1 : 0 }).toString();
    return { from: date, through: date };
  }
  if (preset === 'week' || preset === 'previousWeek') {
    const monday = today.subtract({ days: today.dayOfWeek - 1 + (preset === 'previousWeek' ? 7 : 0) });
    return { from: monday.toString(), through: monday.add({ days: 6 }).toString() };
  }
  const first = today.with({ day: 1 }).subtract({ months: preset === 'previousMonth' ? 1 : 0 });
  return { from: first.toString(), through: first.add({ months: 1 }).subtract({ days: 1 }).toString() };
}
