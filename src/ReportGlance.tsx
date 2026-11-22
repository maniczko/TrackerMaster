import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';
import { formatDuration as duration } from './reportCsv';
import { reportGlance } from './reportGlanceModel';
import { allReportClients } from './reportScope';
import type { ReportCatalog } from './reportScope';
import type { ActiveReportEntry, CompletedReportEntry } from './reportView';

type Data = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };
type Props = { catalog: ReportCatalog; loaded: boolean; revision: number };

/**
 * Closed-report card: "Dziś / Ten tydzień / Rozliczalne w tym tygodniu" for all clients.
 * Read-only: the same get_report_data read the report uses, refreshed like the open report (every 5 s).
 */
export default function ReportGlance({ catalog, loaded, revision }: Props) {
  const [read, setRead] = useState<{ data: Data; at: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!loaded) { setRead(null); return; }
    let cancelled = false;
    let timer: number | undefined;
    async function update() {
      try {
        const data = await invoke<Data>('get_report_data', { scope: allReportClients });
        if (!cancelled) { setRead({ data, at: Date.now() }); setFailed(false); }
      } catch {
        if (!cancelled) { setRead(null); setFailed(true); }
      } finally {
        if (!cancelled) timer = window.setTimeout(update, 5000);
      }
    }
    void update();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [loaded, revision]);

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
