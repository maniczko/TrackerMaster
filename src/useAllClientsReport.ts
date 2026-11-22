import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { allReportClients } from './reportScope';
import type { ActiveReportEntry, CompletedReportEntry } from './reportView';

export type AllClientsReportData = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };
export type AllClientsReport = { read: { data: AllClientsReportData; at: number } | null; failed: boolean };

/**
 * Read-only get_report_data for all clients, refreshed like the open report (every 5 s and on a new
 * revision). Shared by the closed-report card, the totals next to the timer and the History day groups.
 */
export function useAllClientsReport(loaded: boolean, revision: number): AllClientsReport {
  const [read, setRead] = useState<AllClientsReport['read']>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!loaded) { setRead(null); return; }
    let cancelled = false;
    let timer: number | undefined;
    async function update() {
      try {
        const data = await invoke<AllClientsReportData>('get_report_data', { scope: allReportClients });
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
  return { read, failed };
}
