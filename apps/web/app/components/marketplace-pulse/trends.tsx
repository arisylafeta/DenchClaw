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
  { label: "Viewed a listing, of visitors", from: "visitors", to: "viewed_listing" },
  { label: "Started, of listing viewers", from: "viewed_listing", to: "started_contact" },
  { label: "Sent, of those who started", from: "started_contact", to: "sent_contact" },
] as const;

type Point = { week: string; value: number | null };

function Tip({ active, payload, label, format }: { active?: boolean; payload?: { value?: unknown }[]; label?: unknown; format: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  const value = payload[0].value;
  return (
    <div className="border px-2.5 py-1.5 text-xs shadow-sm" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
      <div className="font-semibold">Week of {String(label)}</div>
      <div className="bt-mono">{value === null || value === undefined ? "–" : format(Number(value))}</div>
    </div>
  );
}

/** One small single-series line chart; the title names the series, so there is no legend. */
function MiniLine({ title, data, format, tick, target, max }: {
  title: string; data: Point[]; format: (v: number) => string; tick: (v: number) => string; target?: number; max?: number;
}) {
  const last = [...data].reverse().find((d) => d.value !== null);
  return (
    <figure className="border p-3" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium" style={{ color: "var(--bt-text)" }}>{title}</span>
        <span className="bt-mono text-[15px] font-semibold" style={{ color: "var(--bt-text)" }}>{last ? format(last.value!) : "–"}</span>
      </figcaption>
      <div style={{ height: 130 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis dataKey="week" tick={axis} tickLine={false} axisLine={{ stroke: "var(--viz-grid)" }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={axis} tickLine={false} axisLine={false} width={40} tickFormatter={tick}
              domain={[0, (top: number) => Math.max(top, target ?? 0, max ?? 0)]} />
            {target !== undefined && (
              <ReferenceLine y={target} stroke="var(--viz-axis)" strokeWidth={1}
                label={{ value: "Target", position: "insideTopRight", fontSize: 10, fill: "var(--viz-axis)" }} />
            )}
            <Tooltip content={<Tip format={format} />} />
            <Line type="monotone" dataKey="value" stroke="var(--viz-neutral)" strokeWidth={2} connectNulls={false} isAnimationActive={false}
              dot={false} activeDot={{ r: 4, stroke: "var(--bt-surface)", strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

const pounds = (v: number) => (v >= 1000 ? `£${Math.round(v / 100) / 10}k` : `£${Math.round(v)}`);

export function Trends({ weeks, targets }: Props) {
  if (weeks.length < 2) return <p className="text-sm">Trends need at least two full weeks of numbers.</p>;
  return (
    <div className="pulse-viz flex flex-col gap-6">
      <section aria-label="Conversion rates" className="flex flex-col gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">Conversion rates</h2>
          <p className="text-xs" style={{ color: "var(--bt-muted)" }}>Each step as a share of the step before, by week. People counted once a week.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {RATES.map((r) => (
            <MiniLine key={r.label} title={r.label} format={(v) => `${v}%`} tick={(v) => `${v}%`}
              data={weeks.map((w) => {
                const from = w.values[r.from];
                const to = w.values[r.to];
                return { week: weekLabel(w.week_start), value: from && to !== undefined ? Math.round((to / from) * 1000) / 10 : null };
              })} />
          ))}
        </div>
      </section>
      <section aria-label="Headline numbers by week" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SCORECARD.filter((m) => m !== "listings_live").map((metric) => (
          <MiniLine key={metric} title={METRICS[metric].label} target={targets[metric]}
            format={(v) => formatMetric(metric, v)} tick={METRICS[metric].money ? pounds : (v) => String(Math.round(v))}
            data={weeks.map((w) => ({ week: weekLabel(w.week_start), value: w.values[metric] ?? null }))} />
        ))}
      </section>
    </div>
  );
}
