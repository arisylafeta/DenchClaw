"use client";

// The Home chart: an overview of buyer intent against deals, and one view per funnel step, picked by
// five buttons. Drawn as SVG at the box's real width so text stays 11px at any pane size.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { HomeData, Segment } from "@/lib/home";
import { dayLabel, mondayOf, percent, type FunnelStepKey } from "@/lib/home-metrics";
import styles from "./home.module.css";

type Overview = NonNullable<HomeData["overview"]>;
type Step = NonNullable<HomeData["funnel"]>["steps"][number];
type View = "overview" | FunnelStepKey;

export function Reading({ segments }: { segments: Segment[] }) {
  return <>{segments.map((s, i) => (typeof s === "string" ? <span key={i}>{s}</span> : <b key={i}>{s.strong}</b>))}</>;
}

/** A round axis maximum: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceMax(value: number): number {
  if (value <= 1) {return 1;}
  const power = 10 ** Math.floor(Math.log10(value));
  const f = value / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(1040);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") {return;}
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(300, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

type Tip = { x: number; y: number; body: ReactNode } | null;

export function HomeChart({ overview, funnel }: { overview: HomeData["overview"]; funnel: HomeData["funnel"] }) {
  const [view, setView] = useState<View>("overview");
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const hatch = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const step = funnel?.steps.find((s) => s.key === view) ?? null;

  const VW = width;
  const VH = VW < 600 ? 240 : 280;
  const frame = { L: 34, R: 6, T: 14, B: 28, VW, VH, W: VW - 40, H: VH - 42, hatch };

  let title = "Intent in, deals out";
  let description = "Per week. Enquiries are distinct buyers who sent an offer, message or buy.";
  let heads: [string, string][] = [];
  let legend: ReactNode = null;
  let chart: ReactNode = <div className={styles.empty}>No data yet</div>;
  let reading: Segment[] | null = null;

  if (view === "overview" && overview) {
    heads = [[String(overview.enquiries_30d), "Enquiries, last 30 days"], [String(overview.opened_30d), "Deals opened, last 30 days"]];
    legend = (
      <>
        <span><i style={{ background: "var(--h-accent-soft)" }} />Buyer enquiries</span>
        <span><i style={{ background: "var(--color-text)", height: 3, width: 14 }} />Deals opened</span>
        <span><i style={{ background: "var(--h-accent)", borderRadius: "50%" }} />Deals paid</span>
        <span className={styles.muted}>Hatched: this week so far</span>
      </>
    );
    chart = <OverviewSvg data={overview} frame={frame} onTip={setTip} />;
    reading = overview.reading;
  } else if (step && funnel) {
    title = step.label;
    description = `Per week, ${dayLabel(funnel.weeks[0])} to ${dayLabel(funnel.weeks.at(-1)!)}. Compare the last 4 weeks with the 4 before.`;
    heads = [
      [percent(step.current.rate), `Last 4 weeks (${step.current.num} of ${step.current.den})`],
      [percent(step.previous.rate), `Previous 4 weeks (${step.previous.num} of ${step.previous.den})`],
    ];
    legend = (
      <>
        <span><i style={{ background: "var(--h-accent-soft)" }} />{step.den_label}</span>
        <span><i style={{ background: "var(--h-accent)" }} />{step.num_label}</span>
      </>
    );
    chart = <StepSvg step={step} frame={frame} onTip={setTip} />;
    reading = step.reading;
  }

  return (
    <article className={styles.card} aria-label="Main chart">
      <div className={styles.chHd}>
        <div><h2>{title}</h2><div className={styles.d}>{description}</div></div>
        {heads.length > 0 && (
          <div className={styles.heads}>
            {heads.map(([value, label]) => <div key={label}><b>{value}</b><span>{label}</span></div>)}
          </div>
        )}
      </div>
      <div className={styles.picker} role="group" aria-label="Chart view">
        <button type="button" className={styles.pk} aria-pressed={view === "overview"} onClick={() => { setView("overview"); setTip(null); }}>
          <span className={styles.pn}>Overview</span>
          <span className={styles.pr}>Intent in, deals out</span>
          <span className={styles.pc}>Weekly, last 13 weeks</span>
        </button>
        {funnel?.steps.map((s) => <StepButton key={s.key} step={s} pressed={view === s.key} flagged={funnel.biggest_drop === s.key} onPick={() => { setView(s.key); setTip(null); }} />)}
      </div>
      {legend && <div className={styles.legend}>{legend}</div>}
      <div className={styles.box} ref={boxRef} onPointerLeave={() => setTip(null)}>
        {chart}
        {tip && <div className={styles.tip} style={{ left: Math.min(Math.max(tip.x, 80), width - 80), top: tip.y }}>{tip.body}</div>}
      </div>
      {reading && <p className={styles.read}><Reading segments={reading} /></p>}
    </article>
  );
}

function StepButton({ step, pressed, flagged, onPick }: { step: Step; pressed: boolean; flagged: boolean; onPick: () => void }) {
  const delta = step.delta_pts === null ? null : Math.round(step.delta_pts);
  return (
    <button type="button" className={styles.pk} aria-pressed={pressed} onClick={onPick}>
      <span className={styles.pn}>{step.label}</span>
      <span className={styles.pr}>{percent(step.current.rate)}</span>
      <span className={styles.pc}>
        {step.current.num} of {step.current.den}
        {step.previous.rate !== null && <> · was {percent(step.previous.rate)}</>}
        {delta !== null && <> <b className={delta >= 0 ? styles.up : styles.down}>{delta >= 0 ? "+" : ""}{delta} pts</b></>}
      </span>
      {flagged && <span className={styles.flag}>Biggest drop</span>}
    </button>
  );
}

type Frame = { L: number; R: number; T: number; B: number; VW: number; VH: number; W: number; H: number; hatch: string };

function Grid({ frame, max, lines }: { frame: Frame; max: number; lines: number }) {
  const { L, T, W, H } = frame;
  return (
    <>
      {Array.from({ length: lines + 1 }, (_, g) => {
        const y = T + H - (g / lines) * H;
        const v = (max * g) / lines;
        return (
          <g key={g}>
            <line x1={L} x2={L + W} y1={y} y2={y} stroke="var(--color-border)" />
            <text x={L - 6} y={y + 4} textAnchor="end">{v % 1 ? v.toFixed(1) : v}</text>
          </g>
        );
      })}
    </>
  );
}

function OverviewSvg({ data, frame, onTip }: { data: Overview; frame: Frame; onTip: (tip: Tip) => void }) {
  const { L, T, W, H, VW, VH, hatch } = frame;
  const weeks = data.weeks;
  const n = weeks.length;
  const stepW = W / n;
  const max = Math.max(5, niceMax(Math.max(...weeks.map((w) => Math.max(w.enquiries, w.opened, w.paid)))));
  const y = (v: number) => T + H - (v / max) * H;
  const cx = (i: number) => L + stepW * i + stepW / 2;
  const bw = Math.min(28, stepW * 0.55);
  const showLabel = (i: number) => VW >= 600 || i % 2 === (n - 1) % 2;
  // The quiet spell runs from the week after the last deal to now.
  const quietFrom = data.no_deal_since ? weeks.findIndex((w) => w.week_start > mondayOf(new Date(data.no_deal_since!))) : -1;

  return (
    <svg className={styles.svg} viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="Weekly buyer enquiries, deals opened and deals paid">
      <defs>
        <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="var(--h-accent-soft)" opacity=".4" />
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--h-accent-soft)" strokeWidth="3" />
        </pattern>
      </defs>
      <Grid frame={frame} max={max} lines={5} />
      {weeks.map((w, i) => {
        const h = (w.enquiries / max) * H;
        return (
          <g key={w.week_start}>
            {w.enquiries > 0 && (
              <>
                <rect x={cx(i) - bw / 2} y={T + H - h} width={bw} height={h} rx="2" fill={w.partial ? `url(#${hatch})` : "var(--h-accent-soft)"} />
                <text x={cx(i)} y={T + H - h - 5} textAnchor="middle" style={{ fill: "var(--color-text-secondary)" }}>{w.enquiries}</text>
              </>
            )}
            {showLabel(i) && <text x={cx(i)} y={VH - 8} textAnchor="middle">{dayLabel(w.week_start)}</text>}
          </g>
        );
      })}
      <path
        d={weeks.map((w, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)} ${y(w.opened).toFixed(1)}`).join(" ")}
        fill="none" stroke="var(--color-text)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
      />
      {weeks.map((w, i) => <circle key={`o${w.week_start}`} cx={cx(i)} cy={y(w.opened)} r="2.5" fill="var(--color-text)" />)}
      {weeks.map((w, i) => w.paid > 0 && (
        <circle key={`p${w.week_start}`} cx={cx(i)} cy={y(w.paid)} r="6.5" fill="var(--h-accent)" stroke="var(--color-surface)" strokeWidth="2" />
      ))}
      {quietFrom >= 0 && data.no_deal_since && (
        <>
          <line x1={L + stepW * quietFrom} x2={L + W} y1={T + H - 3} y2={T + H - 3} stroke="var(--h-accent)" strokeWidth="2" />
          <text x={L + W} y={T + 12} textAnchor="end" style={{ fill: "var(--h-accent)", fontWeight: 600 }}>
            No deals opened since {dayLabel(data.no_deal_since)}
          </text>
        </>
      )}
      {weeks.map((w, i) => (
        <rect
          key={`h${w.week_start}`} x={L + stepW * i} y={T} width={stepW} height={H} fill="transparent"
          onPointerEnter={() => onTip({
            x: cx(i),
            y: y(Math.max(w.enquiries, w.opened, w.paid)),
            body: <><b>w/c {dayLabel(w.week_start)}</b> · {plural(w.enquiries, "enquiry", "enquiries")} · {w.opened} opened · {w.paid} paid</>,
          })}
        />
      ))}
    </svg>
  );
}

function StepSvg({ step, frame, onTip }: { step: Step; frame: Frame; onTip: (tip: Tip) => void }) {
  const { L, T, W, H, VW, VH } = frame;
  const weeks = step.weekly;
  const n = weeks.length;
  const stepW = W / n;
  const max = niceMax(Math.max(1, ...weeks.map((w) => w.den ?? 0)));
  const bw = Math.min(26, stepW * 0.32);
  const top = (v: number) => T + H - (v / max) * H;
  const showLabel = (i: number) => VW >= 600 || i % 2 === (n - 1) % 2;

  return (
    <svg className={styles.svg} viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label={`${step.label} per week`}>
      <Grid frame={frame} max={max} lines={4} />
      {weeks.map((w, i) => {
        const cx = L + stepW * i + stepW / 2;
        const hd = ((w.den ?? 0) / max) * H;
        const hn = ((w.num ?? 0) / max) * H;
        return (
          <g key={w.week_start}>
            {!!w.den && <rect x={cx - bw - 1} y={T + H - hd} width={bw} height={Math.max(hd, 1.5)} rx="2" fill="var(--h-accent-soft)" />}
            {w.num ? (
              <rect x={cx + 1} y={T + H - hn} width={bw} height={Math.max(hn, 1.5)} rx="2" fill="var(--h-accent)" />
            ) : w.num === 0 ? (
              <line x1={cx + 1} x2={cx + 1 + bw} y1={T + H - 1} y2={T + H - 1} stroke="var(--h-accent)" strokeWidth="2" />
            ) : null}
            {showLabel(i) && <text x={cx} y={VH - 8} textAnchor="middle">{dayLabel(w.week_start)}</text>}
            <rect
              x={L + stepW * i} y={T} width={stepW} height={H} fill="transparent"
              onPointerEnter={() => onTip({
                x: cx,
                y: top(w.den ?? 0),
                body: w.den === null
                  ? <><b>w/c {dayLabel(w.week_start)}</b> · No data yet</>
                  : <><b>w/c {dayLabel(w.week_start)}</b> · {w.num ?? 0} of {w.den} · {percent(w.den ? (w.num ?? 0) / w.den : null)}</>,
              })}
            />
          </g>
        );
      })}
    </svg>
  );
}
