import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReportView } from '../src/reportView.ts';
import { calendarWeek } from '../src/calendarModel.ts';
import { calendarMonth } from '../src/calendarMonthModel.ts';
import type { CompletedReportEntry } from '../src/reportView.ts';

function build10kEntries(): CompletedReportEntry[] {
  const entries: CompletedReportEntry[] = [];
  const base = Date.parse('2025-01-01T08:00:00.000Z');
  for (let i = 0; i < 10_000; i++) {
    const startMs = base + i * 3_600_000;
    const endMs = startMs + 1_800_000;
    entries.push({
      id: i + 1,
      project_id: (i % 4) + 1,
      task_id: null,
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date(endMs).toISOString(),
      duration_seconds: 1800,
      billable: i % 2 === 0,
      description: `Syntetyczny wpis 10k #${i + 1}`,
    });
  }
  return entries;
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

test('DEV-36 AC3: 100 period switches across 10,000 entries render below 1000 ms P95', () => {
  const entries = build10kEntries();
  const catalog = {
    clients: [{ id: 1, name: 'Klient 1', archived: false }, { id: 2, name: 'Klient 2', archived: false }],
    projects: [
      { id: 1, client_id: 1, name: 'Projekt A', archived: false, billable: true },
      { id: 2, client_id: 1, name: 'Projekt B', archived: false, billable: false },
      { id: 3, client_id: 2, name: 'Projekt C', archived: false, billable: true },
      { id: 4, client_id: 2, name: 'Projekt D', archived: false, billable: false },
    ],
    tasks: [],
  };
  const data = { time_zone: 'Europe/Warsaw', active: null, entries };
  const allScope = { clientId: null, projectId: null, taskId: null };
  const filter = { scope: allScope, billable: 'all' as const };
  const reportMs: number[] = [];
  const weekMs: number[] = [];
  const monthMs: number[] = [];

  for (let i = 0; i < 100; i++) {
    const day = String((i % 20) + 1).padStart(2, '0');
    const from = `2025-03-${day}`;
    const through = `2025-03-${String(Math.min(28, (i % 20) + 7)).padStart(2, '0')}`;
    const month = `2025-${String((i % 12) + 1).padStart(2, '0')}`;

    const t0 = performance.now();
    const rep = makeReportView(data, catalog, allScope, from, through);
    reportMs.push(performance.now() - t0);
    assert.ok(rep.liveSeconds > 0);

    const t1 = performance.now();
    const wk = calendarWeek({ data, catalog, filter, weekStart: from, now: Date.now(), snapshotActive: null, snapshotFresh: true, minMinutes: 15 });
    weekMs.push(performance.now() - t1);
    assert.ok(wk && wk.weekSeconds > 0);

    const t2 = performance.now();
    const mo = calendarMonth({ data, catalog, filter, month, now: Date.now(), snapshotActive: null, snapshotFresh: true });
    monthMs.push(performance.now() - t2);
    assert.ok(mo && mo.monthSeconds > 0);
  }

  const r95 = percentile(reportMs, 0.95);
  const w95 = percentile(weekMs, 0.95);
  const m95 = percentile(monthMs, 0.95);
  console.log(`PERF_DEV36_10K reportP95=${r95.toFixed(1)}ms weekP95=${w95.toFixed(1)}ms monthP95=${m95.toFixed(1)}ms`);
  assert.ok(r95 < 1000, `report P95 ${r95} ms >= 1000 ms`);
  assert.ok(w95 < 1000, `week P95 ${w95} ms >= 1000 ms`);
  assert.ok(m95 < 1000, `month P95 ${m95} ms >= 1000 ms`);
});
