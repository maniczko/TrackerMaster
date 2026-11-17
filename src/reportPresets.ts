import { Temporal } from '@js-temporal/polyfill';

export type ReportPreset = 'today' | 'week';

export function reportPresetRange(preset: ReportPreset, instant: number, zone: string) {
  const today = Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(zone).toPlainDate();
  if (preset === 'today') return { from: today.toString(), through: today.toString() };
  const monday = today.subtract({ days: today.dayOfWeek - 1 });
  return { from: monday.toString(), through: monday.add({ days: 6 }).toString() };
}
