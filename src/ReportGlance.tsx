import { useMemo } from 'react';
import { formatDuration as duration } from './reportCsv';
import { reportGlance } from './reportGlanceModel';
import type { ReportCatalog } from './reportScope';
import { useAllClientsReport } from './useAllClientsReport';

type Props = { catalog: ReportCatalog; loaded: boolean; revision: number };

/**
 * Closed-report card: "Dziś / Ten tydzień / Rozliczalne w tym tygodniu" for all clients.
 * Read-only: the shared all-clients get_report_data read (useAllClientsReport).
 */
export default function ReportGlance({ catalog, loaded, revision }: Props) {
  const { read, failed } = useAllClientsReport(loaded, revision);

  const glance = useMemo(() => {
    if (!read) return null;
    try { return reportGlance(read.data, catalog, read.at); } catch { return null; }
  }, [read, catalog]);

  const value = (seconds: number | undefined) => glance && seconds !== undefined ? duration(seconds) : '—';
  return <div className="report-glance" aria-label="Podsumowanie czasu" aria-busy={loaded && !read && !failed}>
    <dl>
      <div><dt>Dziś</dt><dd>{value(glance?.todaySeconds)}</dd></div>
      <div><dt>Ten tydzień</dt><dd>{value(glance?.weekSeconds)}</dd></div>
      <div><dt>Rozliczalne w tym tygodniu</dt><dd>{value(glance?.billableWeekSeconds)}</dd></div>
    </dl>
    <p className="helper">{!loaded ? 'Podsumowanie pojawi się po odczycie danych.'
      : failed || (read && !glance) ? 'Nie udało się przygotować podsumowania. Otwórz raport, aby sprawdzić szczegóły.'
      : !glance ? 'Wczytywanie podsumowania…'
      : glance.needsReview ? 'Wszyscy klienci, z aktywnym pomiarem. Raport zawiera uwagi do sprawdzenia.'
      : 'Wszyscy klienci, z aktywnym pomiarem — tak jak w raporcie.'}</p>
  </div>;
}
