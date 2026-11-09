"use client";

// OKR viewer: the quarter's objectives, their key results against target and pace, and the KPIs behind
// them as weekly bars against a baseline. Data from /api/okr (lib/okr.ts).
import { useCallback, useEffect, useId, useState } from "react";
import { baselineAverage, type Group, type Kpi, type Kr, type KrStatus, type OkrData } from "@/lib/okr";
import { dayLabel, shortPounds } from "@/lib/home-metrics";
import { request } from "../bulk-trades/trade-ui";
import styles from "./okr.module.css";

const STATUS: Record<KrStatus, string> = {
  not_started: "Not started", on_track: "On track", behind: "Behind", met: "Met", no_data: "No data yet",
};
const OBJECTIVES: Record<Group["key"], string> = {
  marketplace: "Grow the marketplace",
  bulk: "Make bulk trades repeatable",
};

export function formatValue(value: number, unit: Kpi["unit"] | Kr["unit"]): string {
  if (unit === "gbp") { return shortPounds(value); }
  if (unit === "percent") { return `${Math.round(value)}%`; }
  return Math.round(value).toLocaleString("en-GB");
}

export function OkrView() {
  const [data, setData] = useState<OkrData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await request<OkrData>("/api/okr"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load OKRs.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!data) {
    return (
      <div className={styles.root}>
        <div className={styles.title}><h1>OKRs</h1></div>
        <div className={styles.note} style={{ marginTop: 8 }}>
          {error ? <span className={styles.error}>{error}<button type="button" className={styles.retry} onClick={() => void load()}>Try again</button></span> : "Loading"}
        </div>
      </div>
    );
  }
  return <OkrBody data={data} />;
}

export function OkrBody({ data }: { data: OkrData }) {
  const { period } = data;
  const startsIn = Math.max(0, Math.ceil((Date.parse(`${period.start}T00:00:00Z`) - Date.parse(data.now)) / 86_400_000));
  return (
    <div className={styles.root} style={{ display: "grid", gap: 22 }}>
      <header className={styles.head}>
        <div className={styles.title}>
          <h1>OKRs</h1>
          <span>{period.label}</span>
        </div>
        <div className={styles.quarter}>
          <div className={styles.qbar} role="img" aria-label={period.started ? `Day ${period.day} of ${period.days}` : `Starts in ${startsIn} days`}>
            {Array.from({ length: 13 }, (_, i) => {
              const weekIndex = data.period_index + i;
              const state = data.current_index === null ? (period.ended ? "done" : "") : weekIndex < data.current_index ? "done" : weekIndex === data.current_index ? "now" : "";
              return <i key={i} data-s={state} />;
            })}
          </div>
          <div className={styles.qmeta}>
            <span>{period.ended ? "Finished" : period.started ? `Day ${period.day} of ${period.days}` : `Starts in ${startsIn} ${startsIn === 1 ? "day" : "days"}`}</span>
            <span>{dayLabel(period.start)} to {dayLabel(period.end)}</span>
          </div>
        </div>
      </header>

      {data.groups.map((group) => (
        <section key={group.key} className={styles.obj} aria-label={group.title}>
          <div className={styles.objhd}><b>{OBJECTIVES[group.key]}</b><span>{group.title}</span></div>
          <div className={styles.krs}>
            {data.krs.filter((kr) => kr.objective === group.key).map((kr) => <KrCard key={kr.key} kr={kr} data={data} />)}
          </div>
          <div className={styles.kpis}>
            {group.kpis.map((kpi) => <KpiTile key={kpi.key} kpi={kpi} data={data} />)}
          </div>
        </section>
      ))}

      <div className={styles.legend} aria-hidden="true">
        <span><i style={{ background: "var(--o-accent)" }} />Week</span>
        <span><i style={{ background: "var(--o-accent-soft)" }} />Week in progress</span>
        <span><i style={{ background: "transparent", border: "1px dashed var(--color-text-muted)" }} />Baseline, mean of the last 4 weeks before the quarter</span>
      </div>
      <footer className={styles.health} aria-label="Data health">
        {data.health.map((item, i) => (
          <span key={i}>{item.warn && <span className={styles.dot} />}{item.text}</span>
        ))}
      </footer>
    </div>
  );
}

function KrCard({ kr, data }: { kr: Kr; data: OkrData }) {
  const share = data.period.share;
  const pct = kr.actual === null ? 0 : Math.min(100, (kr.actual / kr.target) * 100);
  return (
    <article className={`${styles.card} ${styles.kr}`}>
      <div className={styles.krhd}>
        <b>{kr.title}</b>
        <span className={styles.chip} data-s={kr.status}>{STATUS[kr.status]}</span>
      </div>
      {kr.actual === null ? <div className={styles.none}>No data yet</div> : (
        <div className={styles.fig}>
          <span className={styles.n}>{formatValue(kr.actual, kr.unit)}</span>
          <span className={styles.of}>of {formatValue(kr.target, kr.unit)}</span>
        </div>
      )}
      <div className={styles.meter} role="img" aria-label={`${Math.round(pct)}% of target, pace ${Math.round(share * 100)}%`}>
        <i style={{ width: `${pct}%` }} />
        {data.period.started && <b style={{ left: `${(share * 100).toFixed(1)}%` }} />}
      </div>
      <div className={styles.mk}>
        <span>{data.period.started ? `Pace for today: ${formatValue(kr.target * share, kr.unit)}` : "Target for the quarter"}</span>
        {kr.actual !== null && kr.actual < kr.target && <span>{formatValue(kr.target - kr.actual, kr.unit)} to go</span>}
      </div>
      {kr.kind === "total" && <KrTrend kr={kr} data={data} />}
      {kr.note && <div className={styles.note}>{kr.note}</div>}
      <div className={styles.src}>{kr.source}</div>
    </article>
  );
}

/** Running total against the straight line to target, one point per quarter week. */
function KrTrend({ kr, data }: { kr: Kr; data: OkrData }) {
  const W = 300, H = 84, L = 2, T = 6, B = 16;
  const n = kr.cumulative.length;
  const max = Math.max(kr.target, ...kr.cumulative.map((v) => v ?? 0));
  const x = (i: number) => L + (i / (n - 1)) * (W - L * 2);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const points = kr.cumulative.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
  const last = kr.cumulative.reduce<number>((a, v, i) => (v === null ? a : i), -1);
  const first = data.weeks[data.period_index];
  return (
    <svg className={styles.trend} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${kr.title}: running total against the line to target`}>
      <line x1={x(0)} y1={y(0)} x2={x(n - 1)} y2={y(kr.target)} stroke="var(--color-text-muted)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <line x1={L} x2={W - L} y1={H - B} y2={H - B} stroke="var(--color-border)" vectorEffect="non-scaling-stroke" />
      {points.length > 1 && <polyline points={points.join(" ")} fill="none" stroke="var(--o-accent)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      {last >= 0 && <circle cx={x(last)} cy={y(kr.cumulative[last]!)} r="3" fill="var(--o-accent)" />}
      <text x={L} y={H - 3} fontSize="10" fill="var(--color-text-muted)">{dayLabel(first)}</text>
      <text x={W - L} y={H - 3} fontSize="10" fill="var(--color-text-muted)" textAnchor="end">{dayLabel(data.weeks.at(-1)!)}</text>
    </svg>
  );
}

function KpiTile({ kpi, data }: { kpi: Kpi; data: OkrData }) {
  const [hover, setHover] = useState<number | null>(null);
  const hatch = `h${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { weeks, current_index: current, baseline, period_index } = data;
  // The figure is the last finished week; hovering a bar shows that week instead.
  const lastDone = current === null ? weeks.length - 1 : current - 1;
  const shown = hover ?? lastDone;
  const value = kpi.values[shown] ?? null;
  const base = baselineAverage(kpi, baseline);
  const delta = value !== null && base !== null && base > 0 ? (value - base) / base : null;
  const direction = delta === null ? "flat" : delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat";
  const quarterTotal = data.period.started
    ? kpi.values.slice(period_index, period_index + 13).reduce<number>((a, v) => a + (v ?? 0), 0)
    : null;
  const known = kpi.values.filter((v): v is number => v !== null);
  const max = Math.max(1, ...known);

  const W = 300, H = 52, slot = W / weeks.length, bw = slot * 0.62;
  const bar = (v: number) => Math.max(1.5, (v / max) * (H - 4));
  const baseY = base === null ? null : H - 2 - (base / max) * (H - 4);

  return (
    <article className={`${styles.card} ${styles.kpi}`}>
      <div className={styles.kpilabel}>{kpi.label}</div>
      <div className={styles.kpival}>
        {value === null ? <span className={styles.none} style={{ fontSize: 15 }}>No data</span> : <span className={styles.n}>{formatValue(value, kpi.unit)}</span>}
        <span className={styles.when}>{shown >= 0 ? `week of ${dayLabel(weeks[shown])}${shown === current ? ", so far" : ""}` : ""}</span>
        {delta !== null && <span className={styles.delta} data-d={direction}>{delta > 0 ? "+" : ""}{Math.round(delta * 100)}%</span>}
      </div>
      <svg
        className={styles.spark} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${kpi.label} per week`} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover(Math.min(weeks.length - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * weeks.length))));
        }}
      >
        <defs>
          <pattern id={hatch} width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" fill="var(--o-accent-soft)" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--o-accent-mid)" strokeWidth="1.5" />
          </pattern>
        </defs>
        <rect x={period_index * slot} y="0" width={W - period_index * slot} height={H} fill="var(--color-bg)" opacity="0.7" />
        <line x1={period_index * slot} x2={period_index * slot} y1="0" y2={H} stroke="var(--color-border)" vectorEffect="non-scaling-stroke" />
        {weeks.map((w, i) => {
          const v = kpi.values[i];
          const x = i * slot + (slot - bw) / 2;
          if (v === null) {
            return <rect key={w} x={x} y={H - 2} width={bw} height="1.5" fill="var(--o-track)" opacity={current !== null && i > current ? 0.5 : 1} />;
          }
          const h = bar(v);
          return (
            <rect
              key={w} x={x} y={H - 1 - h} width={bw} height={h} rx="1"
              fill={i === current ? `url(#${hatch})` : "var(--o-accent)"}
              opacity={hover !== null && hover !== i ? 0.55 : 1}
            />
          );
        })}
        {baseY !== null && <line x1="0" x2={W} y1={baseY} y2={baseY} stroke="var(--color-text-muted)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className={styles.kpifoot}>
        <span>{base === null ? "Baseline: no data" : `Baseline ${formatValue(base, kpi.unit)} a week`}</span>
        {quarterTotal !== null && <span>Quarter {formatValue(quarterTotal, kpi.unit)}</span>}
      </div>
      {kpi.hint && <div className={styles.hint}>{kpi.hint}</div>}
    </article>
  );
}
