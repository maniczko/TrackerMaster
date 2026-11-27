import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { formatDuration as duration } from './reportCsv';
import { chartScale, formatPercent, summaryChart, summaryGroups, summaryGroupsByProject, summaryKpis } from './reportSummaryModel';
import type { ChartBucket, EntryRelations, SummaryGroup, SummaryGrouping } from './reportSummaryModel';
import type { makeReportView } from './reportView';
import type { ReportCatalog } from './reportScope';

type View = ReturnType<typeof makeReportView>;
type Props = {
  view: View;
  relations: EntryRelations;
  catalog: ReportCatalog;
  clientLabelById: ReadonlyMap<string, string>;
  from: string;
  through: string;
  incomplete: boolean;
};

const PLOT_HEIGHT = 168;
const unitCaption = { day: 'Czas według dni', week: 'Czas według tygodni', month: 'Czas według miesięcy' } as const;
const unitHint = { day: 'dzień', week: 'tydzień (od poniedziałku)', month: 'miesiąc' } as const;
const tickLabel = (seconds: number, step: number) => step >= 3600 ? `${seconds / 3600} h` : `${seconds / 60} min`;

export default function ReportSummary({ view, relations, catalog, clientLabelById, from, through, incomplete }: Props) {
  const [grouping, setGrouping] = useState<SummaryGrouping>('client-project-task');
  const kpi = useMemo(() => summaryKpis(view), [view]);
  const chart = useMemo(() => summaryChart(view, relations, catalog, clientLabelById, from, through), [view, relations, catalog, clientLabelById, from, through]);
  const groups = useMemo(() => grouping === 'project-task'
    ? summaryGroupsByProject(view, relations, catalog, clientLabelById)
    : summaryGroups(view, relations, catalog, clientLabelById), [grouping, view, relations, catalog, clientLabelById]);
  const live = kpi.liveSeconds !== kpi.totalSeconds;
  return <>
    <div className="report-summary report-kpis" aria-label="Wskaźniki zatwierdzonego czasu">
      <div><small>Łączny czas{incomplete ? ' · suma niepełna' : ''}</small><strong>{duration(kpi.totalSeconds)}</strong></div>
      <div><small>Rozliczalny czas</small><strong>{duration(kpi.billableSeconds)}</strong></div>
      <div><small>% rozliczalny</small><strong>{formatPercent(kpi.billablePercent)}</strong></div>
      <div><small>Średnio na dzień z pracą</small><strong>{kpi.averageSeconds === null ? 'Brak danych' : duration(kpi.averageSeconds)}</strong>
        <small>{kpi.workDays ? `${kpi.workDays} ${kpi.workDays === 1 ? 'dzień' : 'dni'} z pracą` : 'Brak dni z pracą'}</small></div>
    </div>
    <p className="muted report-kpi-note">Wskaźniki liczą tylko zatwierdzony czas. Kwoty pojawią się po zatwierdzeniu stawek.</p>
    {live && <p role="note" className="report-live">
      Z aktywnym pomiarem i wpisami czekającymi na decyzję o uśpieniu (orientacyjnie): <strong>{duration(kpi.liveSeconds)}</strong>
      {kpi.activeSeconds > 0 && <> · aktywny pomiar <strong>{duration(kpi.activeSeconds)}</strong></>}
      {kpi.awaitingSeconds > 0 && <> · czeka na decyzję <strong>{duration(kpi.awaitingSeconds)}</strong></>}
    </p>}
    {kpi.totalSeconds === 0 ? <p className="muted report-summary-empty">Brak zatwierdzonego czasu w wybranym zakresie.</p> : <>
      <ReportChart buckets={chart.buckets} unit={chart.unit} maxSeconds={chart.maxSeconds} legend={chart.legend} />
      <ReportGroups groups={groups} totalSeconds={kpi.totalSeconds} grouping={grouping} onGroupingChange={setGrouping} />
    </>}
  </>;
}

type ChartProps = Pick<ReturnType<typeof summaryChart>, 'buckets' | 'unit' | 'maxSeconds' | 'legend'>;

function ReportChart({ buckets, unit, maxSeconds, legend }: ChartProps) {
  const [active, setActive] = useState(() => Math.max(0, buckets.findIndex(bucket => bucket.seconds > 0)));
  const [shown, setShown] = useState<number | null>(null);
  const bars = useRef<(SVGGElement | null)[]>([]);
  const tooltipId = useId();
  const names = useMemo(() => new Map(legend.map(item => [item.projectId, `${item.name} (${item.client})`])), [legend]);
  const { max, step } = chartScale(maxSeconds);
  const ticks = Array.from({ length: Math.round(max / step) }, (_, index) => (index + 1) * step);
  const slot = 100 / buckets.length;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 10));
  const focused = Math.min(active, buckets.length - 1);
  const describe = (bucket: ChartBucket) => {
    const parts = bucket.segments.map(segment => `${names.get(segment.projectId) ?? 'Bez przypisania'}: ${duration(segment.seconds)}`);
    return `${bucket.longLabel}: ${duration(bucket.seconds)}${parts.length ? `. ${parts.join('; ')}` : ''}`;
  };
  const move = (index: number) => {
    const next = Math.max(0, Math.min(buckets.length - 1, index));
    setActive(next);
    setShown(next);
    bars.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const keys: Record<string, number> = { ArrowRight: focused + 1, ArrowLeft: focused - 1, Home: 0, End: buckets.length - 1 };
    if (event.key in keys) { event.preventDefault(); move(keys[event.key]); }
    else if (event.key === 'Escape') setShown(null);
  };
  const tip = shown === null ? null : buckets[shown];
  return <figure className="report-chart">
    <figcaption><h3>{unitCaption[unit]}</h3>
      <p className="muted">Zatwierdzony czas na każdy {unitHint[unit]}, w podziale na projekty. Strzałki w lewo i w prawo przechodzą między słupkami.</p></figcaption>
    <div className="report-chart-frame">
      <div className="report-chart-axis" aria-hidden="true">
        {ticks.map(value => <span key={value} style={{ top: `${(1 - value / max) * PLOT_HEIGHT}px` }}>{tickLabel(value, step)}</span>)}
      </div>
      <div className="report-chart-plot">
        <svg width="100%" height={PLOT_HEIGHT + 24} role="group" aria-label={`${unitCaption[unit]}: ${buckets.length} słupków`} onKeyDown={onKeyDown}>
          {ticks.map(value => <line key={value} className="report-chart-grid" x1="0" x2="100%" y1={PLOT_HEIGHT - value / max * PLOT_HEIGHT} y2={PLOT_HEIGHT - value / max * PLOT_HEIGHT} />)}
          <line className="report-chart-baseline" x1="0" x2="100%" y1={PLOT_HEIGHT} y2={PLOT_HEIGHT} />
          {buckets.map((bucket, index) => {
            let top = PLOT_HEIGHT;
            return <g key={bucket.key} className="report-chart-bar" role="img" tabIndex={index === focused ? 0 : -1} aria-label={describe(bucket)}
              aria-describedby={shown === index ? tooltipId : undefined} data-seconds={bucket.seconds} data-from={bucket.from}
              ref={element => { bars.current[index] = element; }}
              onFocus={() => { setActive(index); setShown(index); }} onBlur={() => setShown(current => current === index ? null : current)}
              onMouseEnter={() => setShown(index)} onMouseLeave={() => setShown(current => current === index ? null : current)}>
              <rect className="report-chart-hit" x={`${index * slot + slot * 0.08}%`} width={`${slot * 0.84}%`} y="0" height={PLOT_HEIGHT} />
              {bucket.segments.map(segment => {
                const height = segment.seconds / max * PLOT_HEIGHT;
                top -= height;
                return <rect key={segment.projectId} className="report-chart-segment" data-project-colour={segment.colour}
                  x={`${index * slot + slot * 0.18}%`} width={`${slot * 0.64}%`} y={top} height={height} />;
              })}
              {index % labelEvery === 0 && <text className="report-chart-label" x={`${(index + 0.5) * slot}%`} y={PLOT_HEIGHT + 17} textAnchor="middle">{bucket.label}</text>}
            </g>;
          })}
        </svg>
        {tip && <div role="tooltip" id={tooltipId} className="report-chart-tooltip"
          style={{ left: `${Math.min(82, Math.max(18, (shown! + 0.5) * slot))}%` }}>
          <strong>{tip.longLabel}</strong>
          <span>Łącznie {duration(tip.seconds)}</span>
          {tip.segments.length ? <ul>{tip.segments.map(segment => <li key={segment.projectId}>
            <span className="report-chart-swatch" data-project-colour={segment.colour} aria-hidden="true" />
            {names.get(segment.projectId) ?? 'Bez przypisania'}: {duration(segment.seconds)} · {formatPercent(100 * segment.seconds / tip.seconds)}
          </li>)}</ul> : <span className="muted">Brak zatwierdzonego czasu.</span>}
        </div>}
      </div>
    </div>
    <ul className="report-chart-legend" aria-label="Legenda: projekty">
      {legend.map(item => <li key={item.projectId}>
        <span className="report-chart-swatch" data-project-colour={item.colour} aria-hidden="true" />
        <span>{item.name}<small>{item.client}</small></span><span className="duration">{duration(item.seconds)}</span>
      </li>)}
    </ul>
  </figure>;
}

function ReportGroups({ groups, totalSeconds, grouping, onGroupingChange }: { groups: SummaryGroup[]; totalSeconds: number; grouping: SummaryGrouping; onGroupingChange: (next: SummaryGrouping) => void }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(groups.map(group => group.key)));
  const all = useMemo(() => groups.flatMap(group => [group.key, ...group.children.map(child => child.key)]), [groups]);
  const toggle = (key: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const rows: { group: SummaryGroup; depth: number }[] = [];
  const visit = (items: SummaryGroup[], depth: number) => {
    for (const group of items) {
      rows.push({ group, depth });
      if (group.children.length && expanded.has(group.key)) visit(group.children, depth + 1);
    }
  };
  visit(groups, 0);
  const heading = grouping === 'project-task' ? 'Projekt → zadanie' : 'Klient → projekt → zadanie';
  return <section className="report-groups" aria-label="Podział czasu: klient, projekt, zadanie">
    <div className="section-top"><h3>{heading}</h3>
      <div className="actions">
        <div className="report-group-switch" role="group" aria-label="Poziom grupowania">
          <button type="button" className="secondary report-button" aria-pressed={grouping === 'client-project-task'} onClick={() => onGroupingChange('client-project-task')}>Klient → projekt</button>
          <button type="button" className="secondary report-button" aria-pressed={grouping === 'project-task'} onClick={() => onGroupingChange('project-task')}>Projekt → zadanie</button>
        </div>
        <button type="button" className="secondary report-button" onClick={() => setExpanded(new Set(all))}>Rozwiń wszystko</button>
        <button type="button" className="secondary report-button" onClick={() => setExpanded(new Set())}>Zwiń wszystko</button>
      </div></div>
    <div className="table-wrap"><table>
      <thead><tr><th scope="col">{grouping === 'project-task' ? 'Projekt / zadanie' : 'Klient / projekt / zadanie'}</th><th scope="col">Czas</th><th scope="col">Udział</th></tr></thead>
      <tbody>{rows.map(({ group, depth }) => <tr key={group.key} data-level={group.level} data-key={group.key}>
        <th scope="row" className={`report-group-name report-group-depth-${depth}`}>
          {group.children.length ? <button type="button" className="report-group-toggle" aria-expanded={expanded.has(group.key)} onClick={() => toggle(group.key)}>
            <span aria-hidden="true">{expanded.has(group.key) ? '▾' : '▸'}</span>{group.name}
          </button> : <span>{group.name}</span>}
        </th>
        <td className="duration">{duration(group.seconds)}</td>
        <td className="duration">{formatPercent(100 * group.seconds / totalSeconds)}</td>
      </tr>)}</tbody>
      <tfoot><tr><th scope="row">Razem</th><td className="duration">{duration(totalSeconds)}</td><td className="duration">100%</td></tr></tfoot>
    </table></div>
  </section>;
}
