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
/**
 * Short signature of what the main window snapshot shows (entries and the active timer). The App adds it to
 * the read's revision, so a change made outside this window's own actions (mini timer, global shortcut,
 * another process) is read again on the next snapshot refresh (2.5 s) instead of after up to 60 s. PR #63:
 * the calendar showed a week without entries created that way for longer than the E2E's 30 s wait.
 */
export function snapshotSignature(entries: readonly SignatureEntry[], active: SignatureEntry | null): string {
  let hash = 2166136261;
  const text = JSON.stringify([active && signatureFields(active), entries.map(signatureFields)]);
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  return `${entries.length}:${hash.toString(36)}`;
}
type SignatureEntry = { id: number | string; project_id: number | string; task_id: number | string | null; started_at: string; ended_at: string | null;
  duration_seconds?: number | null; billable: boolean; description: string; recovered?: boolean; uncertain?: boolean; has_sleep?: boolean };
const signatureFields = (entry: SignatureEntry) => [entry.id, entry.project_id, entry.task_id, entry.started_at, entry.ended_at, entry.duration_seconds ?? null,
  entry.billable, entry.description, !!entry.recovered, !!entry.uncertain, !!entry.has_sleep];

export function useAllClientsReport(loaded: boolean, revision: number | string): AllClientsReport {
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
