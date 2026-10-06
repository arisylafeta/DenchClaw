"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHANNELS, LANDING_PAGES, channelColor, sumBy, weekLabel, type Breakdown, type PulseWeek } from "@/lib/marketplace-pulse";

type Props = {
  breakdowns: Breakdown[];
  /** Full weeks, oldest first. */
  weeks: PulseWeek[];
};

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : "–");
const n = (value: number) => Math.round(value).toLocaleString("en-GB");
const axis = { fontSize: 11, fill: "var(--viz-axis)" };

function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />;
}

/** A thin single-hue bar inside a table cell; the number beside it carries the value. */
function InlineBar({ share }: { share: number }) {
  return (
    <span aria-hidden="true" className="inline-block h-1.5 w-16 rounded-[2px] align-middle" style={{ background: "var(--viz-grid)" }}>
      <span className="block h-full rounded-[2px]" style={{ width: `${Math.min(100, share * 100)}%`, background: "var(--viz-1)" }} />
    </span>
  );
}

function SplitTable({ label, names, rows, notes, colorOf }: {
  label: string;
  names: readonly string[];
  rows: Record<"visitors" | "viewed" | "started" | "sent", Map<string, number>>;
  notes?: Record<string, string>;
  colorOf?: (name: string) => string;
}) {
  const present = names.filter((name) => (rows.visitors.get(name) ?? 0) > 0);
  const best = Math.max(0.0001, ...present.map((name) => (rows.sent.get(name) ?? 0) / (rows.visitors.get(name) || 1)));
  const bestView = Math.max(0.0001, ...present.map((name) => (rows.viewed.get(name) ?? 0) / (rows.visitors.get(name) || 1)));
  return (
    <table className="w-full text-[13px]" aria-label={label}>
      <thead>
        <tr className="text-xs" style={{ color: "var(--bt-muted)", background: "var(--bt-table-head)" }}>
          <th className="px-4 py-2 text-left font-medium">{label}</th>
          <th className="px-3 py-2 text-right font-medium">Visitors</th>
          <th className="px-3 py-2 text-right font-medium">Viewed a listing</th>
          <th className="px-3 py-2 text-right font-medium">Started</th>
          <th className="px-3 py-2 text-right font-medium">Sent</th>
          <th className="px-4 py-2 text-right font-medium">Visitors per send</th>
        </tr>
      </thead>
      <tbody>
        {present.map((name) => {
          const visitors = rows.visitors.get(name) ?? 0;
          const viewed = rows.viewed.get(name) ?? 0;
          const sent = rows.sent.get(name) ?? 0;
          return (
            <tr key={name} className="border-t align-top" style={{ borderColor: "var(--bt-divider)" }}>
              <td className="px-4 py-2">
                <span className="flex items-center gap-2">{colorOf && <Swatch color={colorOf(name)} />}{name}</span>
                {notes?.[name] && <div className="mt-0.5 text-xs" style={{ color: "var(--bt-amber)" }}>{notes[name]}</div>}
              </td>
              <td className="bt-mono px-3 py-2 text-right">{n(visitors)}</td>
              <td className="bt-mono whitespace-nowrap px-3 py-2 text-right">
                {pct(viewed, visitors)} <InlineBar share={visitors ? viewed / visitors / bestView : 0} />
              </td>
              <td className="bt-mono px-3 py-2 text-right">{n(rows.started.get(name) ?? 0)}</td>
              <td className="bt-mono whitespace-nowrap px-3 py-2 text-right">
                {n(sent)} <span style={{ color: "var(--bt-muted)" }}>({pct(sent, visitors)})</span> <InlineBar share={visitors ? sent / visitors / best : 0} />
              </td>
              <td className="bt-mono px-4 py-2 text-right">{sent ? n(visitors / sent) : "–"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ChannelTooltip({ active, payload, label }: { active?: boolean; payload?: { dataKey?: unknown; value?: unknown }[]; label?: unknown }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => Number(p.value) > 0).reverse();
  return (
    <div className="border px-3 py-2 text-xs shadow-sm" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
      <div className="mb-1 font-semibold">Week of {String(label)}</div>
      {rows.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <Swatch color={channelColor(String(p.dataKey))} />
          <span className="flex-1">{String(p.dataKey)}</span>
          <span className="bt-mono">{n(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

/** Where visitors come from, which routes turn into contacts, and where tracking hides them. */
export function Acquisition({ breakdowns, weeks }: Props) {
  const all = weeks.map((w) => w.week_start);
  const lastFour = all.slice(-4);
  const series = CHANNELS.filter((c) => breakdowns.some((b) => b.metric === "channel_visitors" && b.dimension === c && b.value > 0));
  const chart = all.map((week) => {
    const row: Record<string, string | number> = { week: weekLabel(week) };
    for (const c of series) row[c] = breakdowns.find((b) => b.week_start === week && b.metric === "channel_visitors" && b.dimension === c)?.value ?? 0;
    return row;
  });
  const split = (prefix: string) => ({
    visitors: sumBy(breakdowns, `${prefix}_visitors`, lastFour),
    viewed: sumBy(breakdowns, `${prefix}_viewed`, lastFour),
    started: sumBy(breakdowns, `${prefix}_started`, lastFour),
    sent: sumBy(breakdowns, `${prefix}_sent`, lastFour),
  });
  const channels = split("channel");
  const emailClicks = weeks.slice(-4).reduce((sum, w) => sum + (w.values.email_clicks ?? 0), 0);
  const notes: Record<string, string> = {
    Email: `Campaign links redirect without a referrer or UTM tags, so email visits count as Direct. Link clicks in these weeks: ${n(emailClicks)}, scanners included.`,
  };
  if ((channels.visitors.get("Paid") ?? 0) > 0 && !(channels.viewed.get("Paid") ?? 0)) notes.Paid = "No paid visitor viewed a listing.";
  const referrers = [...sumBy(breakdowns, "referrer_visitors", lastFour).entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxReferrer = Math.max(1, ...referrers.map(([, v]) => v));

  if (!breakdowns.length) {
    return <p className="text-sm">No acquisition numbers yet. They arrive with the collector&apos;s next run.</p>;
  }
  return (
    <div className="pulse-viz flex flex-col gap-6">
      <section aria-label="Where visitors come from" className="border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <h2 className="text-[15px] font-semibold">Where visitors come from</h2>
        <p className="mb-3 text-xs" style={{ color: "var(--bt-muted)" }}>
          People on rebattery.io each week by channel. Someone who came by two channels in a week counts in both.
        </p>
        <ul aria-label="Channels" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--bt-text-2)" }}>
          {series.map((c) => <li key={c} className="flex items-center gap-1.5"><Swatch color={channelColor(c)} />{c}</li>)}
        </ul>
        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
              <XAxis dataKey="week" tick={axis} tickLine={false} axisLine={{ stroke: "var(--viz-grid)" }} />
              <YAxis tick={axis} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
              <Tooltip content={<ChannelTooltip />} cursor={{ fill: "var(--bt-row-hover)" }} />
              {series.map((c, i) => (
                <Bar key={c} dataKey={c} stackId="channels" fill={channelColor(c)} maxBarSize={24}
                  stroke="var(--bt-surface)" strokeWidth={1} radius={i === series.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section aria-label="Which channels convert" className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
          <h2 className="text-[15px] font-semibold">Which channels convert</h2>
          <p className="text-xs" style={{ color: "var(--bt-muted)" }}>Last 4 full weeks. Bars compare each rate with the best channel.</p>
        </div>
        <SplitTable label="Channel" names={CHANNELS} rows={channels} notes={notes} colorOf={channelColor} />
      </section>

      <section aria-label="Which landing pages convert" className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
          <h2 className="text-[15px] font-semibold">Which landing pages convert</h2>
          <p className="text-xs" style={{ color: "var(--bt-muted)" }}>The first page of each visit, last 4 full weeks.</p>
        </div>
        <SplitTable label="Landed on" names={LANDING_PAGES} rows={split("landing")} />
      </section>

      {!!referrers.length && (
        <section aria-label="Referring sites" className="border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
          <h2 className="text-[15px] font-semibold">Referring sites and AI chats</h2>
          <p className="mb-3 text-xs" style={{ color: "var(--bt-muted)" }}>Visitors by the site that sent them, last 4 full weeks.</p>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {referrers.map(([domain, visitors]) => (
              <li key={domain} className="grid grid-cols-[minmax(0,240px)_1fr_40px] items-center gap-3">
                <span className="truncate" title={domain}>{domain}</span>
                <span className="h-3 rounded-r-[4px]" style={{ width: `${(visitors / maxReferrer) * 100}%`, background: "var(--viz-1)" }} />
                <span className="bt-mono text-right">{n(visitors)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
