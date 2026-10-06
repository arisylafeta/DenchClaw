"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { channelColor, mondayOf, weekLabel, type Breakdown, type PulseWeek } from "@/lib/marketplace-pulse";
import {
  STEPS, actualSeries, baseline, channelSends, measure, paidPerMonth, planPath, sendsPerMonth, sensitivity, standing, waterfall,
  type Plan, type PlanVersion, type Rates, type StepKey,
} from "@/lib/marketplace-pulse-plan";
import { ErrorText, buttonClass, buttonStyle, inputClass, inputStyle, request } from "../bulk-trades/trade-ui";
import { PlanEditor } from "./plan-editor";

type Props = {
  plan: PlanVersion | null;
  versions: Omit<PlanVersion, "plan">[];
  /** Full weeks, oldest first. */
  weeks: PulseWeek[];
  breakdowns: Breakdown[];
  onSaved: (saved: PlanVersion) => void;
};

const axis = { fontSize: 11, fill: "var(--viz-axis)" };
const deals = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const stepValue = (key: StepKey, v: number | undefined) =>
  v === undefined ? "–" : key === "visitors" ? Math.round(v).toLocaleString("en-GB") : `${Math.round(v * 1000) / 10}%`;
const dateLabel = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const STANDING_MARK = { "On track": "●", "Slightly behind": "▲", "Off track": "■" } as const;
const STANDING_COLOR = { "On track": "var(--bt-green)", "Slightly behind": "var(--bt-amber)", "Off track": "var(--bt-red)" } as const;

export function PlanTab({ plan: latest, versions, weeks, breakdowns, onSaved }: Props) {
  const [viewing, setViewing] = useState<PlanVersion | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = viewing ?? latest;

  async function view(id: string) {
    setError(null);
    if (!latest || id === latest.id) return setViewing(null);
    try {
      setViewing((await request<{ plan: PlanVersion }>(`/api/marketplace-pulse/plan/${encodeURIComponent(id)}`)).plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that version.");
    }
  }

  async function save(plan: Plan) {
    const { plan: saved } = await request<{ plan: PlanVersion }>("/api/marketplace-pulse/plan", { method: "POST", body: JSON.stringify({ plan }) });
    setViewing(null);
    setEditing(false);
    onSaved(saved);
  }

  if (!shown) {
    return <p className="text-sm">No plan yet. It arrives with the plan migration.</p>;
  }
  const plan = shown.plan;
  const measured = measure(weeks, breakdowns);
  const start = baseline(measured.rates, plan.levers);
  const { steps, final } = waterfall(start, plan.levers);
  const today = paidPerMonth(start);
  const planned = paidPerMonth(final);
  const bump = sensitivity(final);
  const series = actualSeries(weeks);
  const actualNow = series.at(-1)?.paid ?? today;
  const todayIso = new Date().toISOString().slice(0, 10);
  const expected = planPath(plan, todayIso);
  const where = standing(actualNow, expected);

  return (
    <div className="pulse-viz flex flex-col gap-6">
      <section aria-label="Plan" className="flex flex-wrap items-center gap-x-4 gap-y-2 border px-4 py-3" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="flex flex-col">
          <span className="text-[15px] font-semibold">Target: {deals(plan.target_paid)} paid deals a month by {dateLabel(plan.target_date)}</span>
          <span className="text-xs" style={{ color: "var(--bt-muted)" }}>
            {viewing ? "Viewing an older version, read only. " : ""}
            Plan saved {dateLabel(shown.created_at)}{shown.created_by_name ? ` by ${shown.created_by_name}` : ""}
          </span>
        </div>
        <span className="flex items-center gap-1.5 border px-2.5 py-1 text-[13px]" style={{ borderColor: "var(--bt-border)" }}>
          <span aria-hidden="true" style={{ color: STANDING_COLOR[where] }}>{STANDING_MARK[where]}</span>
          <strong>{where}</strong>
          <span style={{ color: "var(--bt-muted)" }}>· {deals(actualNow)} a month now, plan says {deals(expected)} by today</span>
        </span>
        <span className="flex-1" />
        {versions.length > 1 && (
          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--bt-muted)" }}>
            Version
            <select value={shown.id} onChange={(e) => void view(e.target.value)} className={`${inputClass} h-8 w-auto`} style={inputStyle}>
              {versions.map((v, i) => (
                <option key={v.id} value={v.id}>{i === 0 ? "Latest" : dateLabel(v.created_at)}{v.created_by_name ? ` · ${v.created_by_name}` : ""}</option>
              ))}
            </select>
          </label>
        )}
        {viewing ? (
          <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void save(viewing.plan).catch((e) => setError(e.message))}>Restore this version</button>
        ) : (
          <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setEditing(true)}>Edit plan</button>
        )}
      </section>
      <ErrorText error={error} />

      <GrowthModel plan={plan} measured={measured} start={start} final={final} bump={bump} today={today} planned={planned} />
      <Waterfall steps={steps} today={today} planned={planned} target={plan.target_paid} />
      <ChannelPlan plan={plan} actual={channelSends(weeks, breakdowns)} needed={sendsPerMonth(final)} />
      <PlanVsActual plan={plan} series={series} />

      {editing && <PlanEditor plan={plan} start={start} onClose={() => setEditing(false)} onSave={save} />}
    </div>
  );
}

function GrowthModel({ plan, measured, start, final, bump, today, planned }: {
  plan: Plan; measured: ReturnType<typeof measure>; start: Rates; final: Rates; bump: Record<StepKey, number>; today: number; planned: number;
}) {
  const reply = measured.reply;
  return (
    <section aria-label="Growth model" className="border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <h2 className="text-[15px] font-semibold">Growth model</h2>
      <p className="mb-3 text-xs" style={{ color: "var(--bt-muted)" }}>
        Today is the last {measured.weeks || "–"} full weeks, as a month. The plan is what the fixes below should reach. Paid deals a month = every step multiplied together.
      </p>
      <ol className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        {STEPS.map(({ key, label, unit }) => {
          const fixes = plan.levers.filter((l) => l.steps[key] !== undefined);
          const hasData = measured.rates[key] !== undefined;
          return (
            <li key={key} aria-label={label} className="flex flex-col gap-1 border p-2.5 text-xs" style={{ borderColor: "var(--bt-divider)" }}>
              <span className="bt-label">{label}</span>
              <span className="text-[11px]" style={{ color: "var(--bt-muted)" }}>{unit}</span>
              <span className="mt-1 flex items-baseline justify-between gap-1">
                <span>Today</span>
                <span className="bt-mono text-[15px] font-semibold" style={{ color: "var(--bt-text)" }}>{hasData ? stepValue(key, start[key]) : "–"}</span>
              </span>
              <span className="flex items-baseline justify-between gap-1">
                <span>Plan</span>
                <span className="bt-mono font-semibold">{stepValue(key, final[key])}</span>
              </span>
              <span style={{ color: "var(--bt-muted)" }}>{hasData ? "Today measured" : "No data yet; using the plan"}</span>
              {fixes.map((f) => <span key={f.id} className="leading-snug">Fix: {f.name}{f.owner ? ` (${f.owner})` : ""}</span>)}
              <span className="mt-auto pt-1" style={{ color: "var(--bt-text-2)" }}>
                {key === "visitors" ? "+10% visitors" : "+1 point"} = <span className="bt-mono">+{deals(bump[key])}</span> deals
              </span>
              {key === "deal" && (
                <span className="border-t pt-1" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-text-2)" }}>
                  Answered within 24h: <span className="bt-mono">{reply.within24h === null ? "–" : `${Math.round(reply.within24h * 100)}%`}</span>
                  {" "}· never: <span className="bt-mono">{reply.unanswered}</span> of {reply.asked}
                  {reply.medianHours !== null && <> · median <span className="bt-mono">{Math.round(reply.medianHours)}h</span></>}
                </span>
              )}
            </li>
          );
        })}
        <li aria-label="Paid deals a month" className="flex flex-col gap-1 border p-2.5 text-xs" style={{ borderColor: "var(--bt-text)" }}>
          <span className="bt-label">Paid deals</span>
          <span className="text-[11px]" style={{ color: "var(--bt-muted)" }}>per month</span>
          <span className="mt-1 flex items-baseline justify-between"><span>Today</span><span className="bt-mono text-[15px] font-semibold">{deals(today)}</span></span>
          <span className="flex items-baseline justify-between"><span>Plan</span><span className="bt-mono text-[15px] font-semibold">{deals(planned)}</span></span>
          <span style={{ color: "var(--bt-muted)" }}>Fill rate today: {measured.fill === null ? "–" : `${Math.round(measured.fill * 100)}%`} of sends paid</span>
        </li>
      </ol>
    </section>
  );
}

type WaterBar = { name: string; status: string; base: number; value: number; label: string; total: boolean; done: boolean };

function Waterfall({ steps, today, planned, target }: { steps: ReturnType<typeof waterfall>["steps"]; today: number; planned: number; target: number }) {
  const bars: WaterBar[] = [
    { name: "Today", status: "", base: 0, value: today, label: deals(today), total: true, done: true },
    ...steps.map((s) => ({
      name: s.lever.name, status: s.lever.status, base: Math.min(s.before, s.after), value: Math.abs(s.delta),
      label: `${s.delta >= 0 ? "+" : "−"}${deals(Math.abs(s.delta))}`, total: false, done: s.lever.status === "Done",
    })),
    { name: "Plan", status: "", base: 0, value: planned, label: deals(planned), total: true, done: true },
  ];
  const Tick = ({ x, y, payload, index }: { x?: number; y?: number; payload?: { value: string }; index?: number }) => {
    const bar = bars[index ?? 0];
    const words = (payload?.value ?? "").split(" ");
    const short = words.length > 3 ? `${words.slice(0, 3).join(" ")}…` : payload?.value;
    return (
      <g transform={`translate(${x},${y})`}>
        <text textAnchor="middle" fontSize={11} fill="var(--bt-text-2)" dy={12}>{short}</text>
        {bar?.status && <text textAnchor="middle" fontSize={10} fill="var(--viz-axis)" dy={26}>{bar.status}</text>}
      </g>
    );
  };
  return (
    <section aria-label="What each fix is worth" className="border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <h2 className="text-[15px] font-semibold">What each fix is worth</h2>
      <p className="mb-2 text-xs" style={{ color: "var(--bt-muted)" }}>
        Paid deals a month: today, then each fix in order, then the plan. Solid bars are Done; lighter bars are Planned or Doing.
      </p>
      <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bars} margin={{ top: 20, right: 8, bottom: 20, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis dataKey="name" tick={<Tick />} tickLine={false} axisLine={{ stroke: "var(--viz-grid)" }} interval={0} height={36} />
            <YAxis tick={axis} tickLine={false} axisLine={false} width={32} />
            <ReferenceLine y={target} stroke="var(--viz-axis)" strokeWidth={1} label={{ value: `Target ${deals(target)}`, position: "insideTopLeft", fontSize: 10, fill: "var(--viz-axis)" }} />
            <Tooltip cursor={{ fill: "var(--bt-row-hover)" }} content={({ active, payload }) => {
              const bar = active ? (payload?.[0]?.payload as WaterBar | undefined) : undefined;
              if (!bar) return null;
              return (
                <div className="border px-2.5 py-1.5 text-xs shadow-sm" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
                  <div className="font-semibold">{bar.name}</div>
                  <div>{bar.total ? `${bar.label} paid deals a month` : `${bar.label} paid deals a month${bar.status ? ` · ${bar.status}` : ""}`}</div>
                </div>
              );
            }} />
            <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="value" stackId="w" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {bars.map((bar) => <Cell key={bar.name} fill="var(--viz-neutral)" fillOpacity={bar.done ? 1 : 0.35} />)}
              <LabelList dataKey="label" position="top" fontSize={11} fill="var(--bt-text)" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function ChannelPlan({ plan, actual, needed }: { plan: Plan; actual: Map<string, number>; needed: number }) {
  const total = plan.channels.reduce((sum, c) => sum + c.goal, 0);
  const off = needed > 0 && Math.abs(total - needed) / needed > 0.2;
  const max = Math.max(1, ...plan.channels.map((c) => Math.max(c.goal, actual.get(c.channel) ?? 0)));
  return (
    <section aria-label="Channel plan" className="border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <h2 className="text-[15px] font-semibold">Channel plan</h2>
      <p className="mb-3 text-xs" style={{ color: "var(--bt-muted)" }}>Messages and offers sent a month, by channel: the last 4 full weeks against each goal (the tick).</p>
      <ul className="flex flex-col gap-2 text-[13px]">
        {plan.channels.map((c) => {
          const now = actual.get(c.channel) ?? 0;
          return (
            <li key={c.channel} className="grid grid-cols-[150px_minmax(120px,1fr)_70px_minmax(0,2fr)] items-center gap-3">
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: channelColor(c.channel) }} />{c.channel}
              </span>
              <span className="relative h-3 rounded-[2px]" style={{ background: "var(--viz-grid)" }}>
                <span className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: `${(now / max) * 100}%`, background: channelColor(c.channel) }} />
                {c.goal > 0 && <span aria-hidden="true" className="absolute -inset-y-1 w-0.5" style={{ left: `calc(${(c.goal / max) * 100}% - 1px)`, background: "var(--bt-text)" }} />}
              </span>
              <span className="bt-mono text-right">{Math.round(now)} / {Math.round(c.goal)}</span>
              <span className="truncate" title={c.action} style={{ color: "var(--bt-text-2)" }}>{c.owner ? `${c.owner}: ` : ""}{c.action}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs" style={{ color: off ? "var(--bt-amber)" : "var(--bt-muted)" }}>
        {off ? "▲ " : ""}Channel goals add up to {Math.round(total)} sends a month; the model needs {Math.round(needed)}.
        {off ? " They are more than 20% apart, so the plan only adds up on paper." : ""}
      </p>
    </section>
  );
}

function PlanVsActual({ plan, series }: { plan: Plan; series: { week_start: string; paid: number }[] }) {
  // Weekly from the first actual point (or the plan start) to the target date.
  const first = series[0]?.week_start ?? mondayOf(new Date(`${plan.start.date}T00:00:00Z`));
  const points: { week: string; actual: number | null; plan: number | null }[] = [];
  const actual = new Map(series.map((s) => [s.week_start, s.paid]));
  for (let d = new Date(`${first}T00:00:00Z`); d.toISOString().slice(0, 10) <= plan.target_date; d.setUTCDate(d.getUTCDate() + 7)) {
    const iso = d.toISOString().slice(0, 10);
    points.push({ week: weekLabel(iso), actual: actual.get(iso) ?? null, plan: iso >= mondayOf(new Date(`${plan.start.date}T00:00:00Z`)) ? planPath(plan, iso) : null });
  }
  return (
    <section aria-label="Plan against actual" className="border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <h2 className="text-[15px] font-semibold">Plan against actual</h2>
      <ul aria-label="Lines" className="mb-2 mt-1 flex gap-4 text-xs" style={{ color: "var(--bt-text-2)" }}>
        <li className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-0.5 w-4" style={{ background: "var(--viz-neutral)" }} />Paid deals, rolling 4 weeks, as a month</li>
        <li className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block w-4 border-t-2 border-dotted" style={{ borderColor: "var(--viz-axis)" }} />Plan path to the target</li>
      </ul>
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis dataKey="week" tick={axis} tickLine={false} axisLine={{ stroke: "var(--viz-grid)" }} minTickGap={24} />
            <YAxis tick={axis} tickLine={false} axisLine={false} width={32} domain={[0, (top: number) => Math.max(top, plan.target_paid)]} />
            <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
              <div className="border px-2.5 py-1.5 text-xs shadow-sm" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
                <div className="font-semibold">Week of {String(label)}</div>
                {payload.map((p) => p.value === null || p.value === undefined ? null : (
                  <div key={String(p.dataKey)}>{p.dataKey === "actual" ? "Actual" : "Plan"}: <span className="bt-mono">{deals(Number(p.value))}</span></div>
                ))}
              </div>
            ) : null} />
            <Line dataKey="plan" stroke="var(--viz-axis)" strokeWidth={2} strokeDasharray="2 4" dot={false} isAnimationActive={false} connectNulls />
            <Line dataKey="actual" stroke="var(--viz-neutral)" strokeWidth={2} isAnimationActive={false} connectNulls={false}
              dot={{ r: 4, fill: "var(--viz-neutral)", stroke: "var(--bt-surface)", strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
