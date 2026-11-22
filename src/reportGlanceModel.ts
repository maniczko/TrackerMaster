import { reportPresetRange } from './reportPresets.ts';
import { validTimeZone } from './reportTime.ts';
import { makeReportView } from './reportView.ts';
import type { ActiveReportEntry, CompletedReportEntry } from './reportView.ts';
import { allReportClients } from './reportScope.ts';
import type { ReportCatalog } from './reportScope.ts';

type ReportData = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };
export type ReportGlance = {
  todaySeconds: number;
  weekSeconds: number;
  billableWeekSeconds: number;
  /** Something the report shows as a warning (incomplete sum, overlap, sleep to decide, unresolved timer). */
  needsReview: boolean;
};

/**
 * Report card summary for all clients. It calls the report's own view for "Dzisiaj" and "Ten tydzień"
 * (same presets, zone, sleep and pending rules), so the card always equals the open report for that filter.
 */
export function reportGlance(data: ReportData, catalog: ReportCatalog, now: number): ReportGlance | null {
  if (!validTimeZone(data.time_zone)) return null;
  const today = reportPresetRange('today', now, data.time_zone);
  const week = reportPresetRange('week', now, data.time_zone);
  const day = makeReportView(data, catalog, allReportClients, today.from, today.through);
  const span = makeReportView(data, catalog, allReportClients, week.from, week.through);
  const needsReview = [day, span].some(view => view.excludedEntryIds.length > 0 || view.missingRelations ||
    view.overlaps.entryIds.length > 0 || view.pendingPeriodCount > 0 || view.awaitingSeconds > 0 || !!view.active?.unresolved);
  return { todaySeconds: day.liveSeconds, weekSeconds: span.liveSeconds, billableWeekSeconds: span.billableSeconds, needsReview };
}
