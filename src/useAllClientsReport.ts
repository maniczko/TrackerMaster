import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { allReportClients } from './reportScope';
import type { ActiveReportEntry, CompletedReportEntry } from './reportView';

export type AllClientsReportData = { entries: CompletedReportEntry[]; active: ActiveReportEntry | null; time_zone: string };
export type AllClientsReport = { read: { data: AllClientsReportData; at: number } | null; failed: boolean };

/** Background refresh while nothing changes (e.g. a running timer); data changes refresh at once. */
export const ALL_CLIENTS_REPORT_INTERVAL_MS = 60_000;

/**
 * One read-only get_report_data for all clients, owned by the main window and shared by the
 * closed-report card, the totals next to the timer and the History day groups. It reads again on a
 * new revision (every confirmed change, #34), when the window gets focus, and every 60 s otherwise.
 */
export function useAllClientsReport(loaded: boolean, revision: number): AllClientsReport {
  const [read, setRead] = useState<AllClientsReport['read']>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!loaded) { setRead(null); return; }
    let cancelled = false;
    let timer: number | undefined;
    let request = 0;
    async function update() {
      const ticket = ++request;
      if (timer !== undefined) window.clearTimeout(timer);
      try {
        const data = await invoke<AllClientsReportData>('get_report_data', { scope: allReportClients });
        if (!cancelled && ticket === request) { setRead({ data, at: Date.now() }); setFailed(false); }
      } catch {
        if (!cancelled && ticket === request) { setRead(null); setFailed(true); }
      } finally {
        if (!cancelled && ticket === request) timer = window.setTimeout(update, ALL_CLIENTS_REPORT_INTERVAL_MS);
      }
    }
    const onFocus = () => { void update(); };
    void update();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); if (timer !== undefined) window.clearTimeout(timer); };
  }, [loaded, revision]);
  return { read, failed };
}
