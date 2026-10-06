"use client";

import { useState } from "react";
import { CHANNELS, channelColor, dropValue, sumBy, weekLabel, weeksWith, type Breakdown, type MetricKey, type PulseWeek } from "@/lib/marketplace-pulse";

type Props = {
  breakdowns: Breakdown[];
  /** Full weeks, oldest first. */
  weeks: PulseWeek[];
};

type Step = { label: string; value: number; platform?: boolean };
type Reason = { key: Parameters<typeof dropValue>[0]; label: string };

const STEPS = [
  { metric: "funnel_reached", label: "Reached the marketplace" },
  { metric: "funnel_viewed", label: "Viewed a listing" },
  { metric: "funnel_started", label: "Started a message, offer or buy" },
  { metric: "funnel_sent", label: "Sent it" },
] as const;

/** Why people stop between a step and the next one; drop-off numbers are not split by channel. */
const GAP_REASONS: Reason[][] = [
  [{ key: "drop_search_no_exact", label: "searched with no exact match" }],
  [{ key: "drop_no_price", label: "saw a listing with no price" }],
  [{ key: "drop_signin_wall", label: "hit the sign-in box" }, { key: "drop_contact_error", label: "hit an error sending" }],
  [{ key: "drop_offers_expired", label: "offers expired unanswered" }],
  [{ key: "deals_cancelled", label: "deals cancelled" }, { key: "drop_payment_failed", label: "payments failed" }],
];

const n = (value: number) => Math.round(value).toLocaleString("en-GB");

/**
 * The marketplace funnel as people moved through it in order within each week, by the channel of
 * their first visit that week. Deals and payments come from ReBattery and are not the same people.
 */
export function OrderedFunnel({ breakdowns, weeks }: Props) {
  const [picked, setChannel] = useState<string>("All");
  const [range, setRange] = useState<"week" | "four">("four");
  // Only weeks with funnel rows, so the steps and the deals cover the same weeks.
  const withData = weeksWith(breakdowns, "funnel_reached", weeks.map((w) => w.week_start));
  const ids = range === "four" ? withData.slice(-4) : withData.slice(-1);
  const chosen = weeks.filter((w) => ids.includes(w.week_start));
  const channels = ["All", ...CHANNELS.filter((c) => breakdowns.some((b) => b.metric === "funnel_reached" && b.dimension === c && withData.includes(b.week_start)))];
  const channel = channels.includes(picked) ? picked : "All";
  const steps: Step[] = STEPS.map((s) => ({ label: s.label, value: sumBy(breakdowns, s.metric, ids).get(channel) ?? 0 }));
  if (channel === "All") {
    const total = (key: MetricKey) => chosen.reduce((sum, w) => sum + (w.values[key] ?? 0), 0);
    steps.push({ label: "Deals created", value: total("deals_created"), platform: true }, { label: "Paid", value: total("deals_paid"), platform: true });
  }
  const max = Math.max(1, ...steps.map((s) => s.value));
  const rates = steps.map((s, i) => (i && steps[i - 1].value > 0 && !s.platform ? s.value / steps[i - 1].value : null));
  // Deals and payments are different people from the steps above, so they never count as the biggest drop.
  const weakest = rates.reduce<number | null>((w, r, i) => (r !== null && (w === null || r < rates[w]!) ? i : w), null);
  const reasonTotal = (key: Reason["key"]) => chosen.reduce((sum, w) => sum + (dropValue(key, w.values) ?? 0), 0);
  const period = ids.length > 1 ? `the ${ids.length} weeks to ${weekLabel(ids.at(-1)!)}` : `the week of ${weekLabel(ids[0] ?? "")}`;

  if (!ids.length) {
    return (
      <section aria-label="Funnel" className="border p-4 text-sm" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        No funnel numbers for a full week yet. They arrive with the collector&apos;s next run.
      </section>
    );
  }

  const toggle = (active: boolean) => ({
    background: active ? "var(--bt-badge)" : "var(--bt-surface)",
    color: active ? "var(--bt-on-badge)" : "var(--bt-text)",
    borderColor: active ? "var(--bt-badge)" : "var(--bt-border)",
  });

  return (
    <section aria-label="Funnel" className="pulse-viz border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold">Funnel</h2>
        <span className="flex-1" />
        {(["four", "week"] as const).map((r) => (
          <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} className="h-7 border px-2.5 text-xs" style={toggle(range === r)}>
            {r === "four" ? "Last 4 full weeks" : "Last full week"}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Channel" className="mb-4 flex flex-wrap gap-1.5">
        {channels.map((c) => (
          <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}
            className="flex h-7 items-center gap-1.5 border px-2.5 text-xs" style={toggle(channel === c)}>
            {c !== "All" && <span aria-hidden="true" className="inline-block h-2 w-2 rounded-[2px]" style={{ background: channelColor(c) }} />}
            {c}
          </button>
        ))}
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--bt-muted)" }}>
        People who went through these steps in order, in {period}{channel === "All" ? "" : `, arriving by ${channel}`}.
      </p>
      <ol className="flex flex-col">
        {steps.map((step, i) => (
          <li key={step.label}>
            {i > 0 && (
              <div className="grid grid-cols-[220px_1fr] gap-3 py-1.5 text-xs">
                <span />
                <span style={{ color: i === weakest ? "var(--bt-amber)" : "var(--bt-muted)" }}>
                  ↓ {step.platform ? "then, on ReBattery" : rates[i] === null ? "–" : `${Math.round(rates[i]! * 100)}% continue`}
                  {steps[i - 1].value > step.value && !step.platform && ` · ${n(steps[i - 1].value - step.value)} stopped`}
                  {i === weakest && <strong> · biggest drop</strong>}
                  {channel === "All" && GAP_REASONS[i - 1]?.map((r) => {
                    const v = reasonTotal(r.key);
                    return v > 0 ? <span key={r.key}> · {n(v)} {r.label}</span> : null;
                  })}
                </span>
              </div>
            )}
            <div className="grid grid-cols-[220px_1fr] items-center gap-3 text-[13px]">
              <span>
                {step.label}
                {step.platform && <span className="ml-1.5 text-xs" style={{ color: "var(--bt-muted)" }}>ReBattery</span>}
              </span>
              <span className="flex items-center gap-2">
                <span className="h-5 rounded-r-[4px]" style={{
                  width: `${Math.min(100, Math.max(step.value ? 0.5 : 0, (step.value / max) * 100))}%`,
                  background: step.platform ? "var(--viz-muted-bar)" : channel === "All" ? "var(--viz-neutral)" : channelColor(channel),
                }} />
                <span className="bt-mono font-semibold">{n(step.value)}</span>
              </span>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs" style={{ color: "var(--bt-muted)" }}>
        Each person is counted once a week, under the channel of their first marketplace visit that week. Deals and payments come
        from ReBattery, so they are not the same people as the steps above. Reasons are for all channels and can overlap.
        PostHog has no bot filter yet.
      </p>
    </section>
  );
}
