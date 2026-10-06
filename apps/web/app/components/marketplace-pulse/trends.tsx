"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { METRICS, SCORECARD, formatMetric, weekLabel, type MetricKey, type PulseWeek } from "@/lib/marketplace-pulse";

type Props = {
  /** Full weeks, oldest first. */
  weeks: PulseWeek[];
  targets: Partial<Record<MetricKey, number>>;
};

const axis = { fontSize: 10, fill: "var(--viz-axis)" };

const RATES = [
  { key: "view", label: "Viewed a listing, of visitors", from: "visitors", to: "viewed_listing", color: "var(--viz-1)" },
  { key: "start", label: "Started, of listing viewers", from: "viewed_listing", to: "started_contact", color: "var(--viz-2)" },
  { key: "send", label: "Sent, of those who started", from: "started_contact", to: "sent_contact", color: "var(--viz-3)" },
] as const;

function Tip({ active, payload, label, format }: {
  active?: boolean; payload?: { value?: unknown; name?: unknown; color?: string }[]; label?: unknown; format: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="border px-2.5 py-1.5 text-xs shadow-sm" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
      <div className="font-semibold">Week of {String(label)}</div>
      {payload.map((p) => (
        <div key={String(p.name)} className="flex items-center gap-2">
          {payload.length > 1 && <span aria-hidden="true" className="inline-block h-0.5 w-3" style={{ background: p.color }} />}
          {payload.length > 1 && <span className="flex-1">{String(p.name)}</span>}
          <span className="bt-mono">{p.value === null || p.value === undefined ? "–" : format(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

/** One small line chart per headline number, each with its weekly target. */
function SmallMultiple({ metric, weeks, target }: { metric: MetricKey; weeks: PulseWeek[]; target: number | undefined }) {
  const data = weeks.map((w) => ({ week: weekLabel(w.week_start), value: w.values[metric] ?? null }));
  const last = [...data].reverse().find((d) => d.value !== null);
  return (
    <figure className="border p-3" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium" style={{ color: "var(--bt-text)" }}>{METRICS[metric].label}</span>
        <span className="bt-mono text-[15px] font-semibold" style={{ color: "var(--bt-text)" }}>{last ? formatMetric(metric, last.value!) : "–"}</span>
      </figcaption>
      <div style={{ height: 120 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis dataKey="week" tick={axis} tickLine={false} axisLine={{ stroke: "var(--viz-grid)" }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={axis} tickLine={false} axisLine={false} width={36} allowDecimals={false}
              domain={[0, (max: number) => Math.max(max, target ?? 0)]} tickFormatter={(v: number) => (METRICS[metric].money ? `£${Math.round(v / 1000)}k` : String(v))} />
            {target !== undefined && (
              <ReferenceLine y={target} stroke="var(--viz-axis)" strokeWidth={1}
                label={{ value: "Target", position: "insideTopRight", fontSize: 10, fill: "var(--viz-axis)" }} />
            )}
            <Tooltip content={<Tip format={(v) => formatMetric(metric, v)} />} />
            <Line type="monotone" dataKey="value" stroke="var(--viz-1)" strokeWidth={2} connectNulls={false} isAnimationActive={false}
              dot={false} activeDot={{ r: 4, stroke: "var(--bt-surface)", strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function Trends({ weeks, targets }: Props) {
  if (weeks.length < 2) return <p className="text-sm">Trends need at least two full weeks of numbers.</p>;
  const rates = weeks.map((w) => {
    const row: Record<string, string | number | null> = { week: weekLabel(w.week_start) };
    for (const r of RATES) {
      const from = w.values[r.from];
      const to = w.values[r.to];
      row[r.key] = from && to !== undefined ? Math.round((to / from) * 1000) / 10 : null;
    }
    return row;
  });
  const lastRates = rates.at(-1)!;
  return (
    <div className="pulse-viz flex flex-col gap-6">
      <section aria-label="Conversion rates" className="border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <h2 className="text-[15px] font-semibold">Conversion rates</h2>
        <p className="mb-2 text-xs" style={{ color: "var(--bt-muted)" }}>Each step as a share of the step before, by week. People counted once a week.</p>
        <ul aria-label="Rates" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--bt-text-2)" }}>
          {RATES.map((r) => (
            <li key={r.key} className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-0.5 w-4" style={{ background: r.color }} />
              {r.label} <span className="bt-mono" style={{ color: "var(--bt-text)" }}>{lastRates[r.key] === null ? "–" : `${lastRates[r.key]}%`}</span>
            </li>
          ))}
        </ul>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rates} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
              <XAxis dataKey="week" tick={axis} tickLine={false} axisLine={{ stroke: "var(--viz-grid)" }} />
              <YAxis tick={axis} tickLine={false} axisLine={false} width={40} unit="%" domain={[0, 100]} />
              <Tooltip content={<Tip format={(v) => `${v}%`} />} />
              {RATES.map((r) => (
                <Line key={r.key} name={r.label} type="monotone" dataKey={r.key} stroke={r.color} strokeWidth={2} isAnimationActive={false}
                  dot={false} activeDot={{ r: 4, stroke: "var(--bt-surface)", strokeWidth: 2 }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section aria-label="Headline numbers by week" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SCORECARD.filter((m) => m !== "listings_live").map((metric) => (
          <SmallMultiple key={metric} metric={metric} weeks={weeks} target={targets[metric]} />
        ))}
      </section>
    </div>
  );
}
