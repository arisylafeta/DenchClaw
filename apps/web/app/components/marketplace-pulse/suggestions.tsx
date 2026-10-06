"use client";

import { useState } from "react";
import { METRICS, formatMetric, isMetricKey, weekLabel, type PulseWeek, type Suggestion, type SuggestionStatus } from "@/lib/marketplace-pulse";
import { ErrorText, buttonClass, buttonStyle, request } from "../bulk-trades/trade-ui";

const NEXT: Record<SuggestionStatus, SuggestionStatus[]> = {
  New: ["Doing", "Done", "Dismissed"],
  Doing: ["Done", "Dismissed"],
  Done: [],
  Dismissed: [],
};
const BUTTON: Record<SuggestionStatus, string> = { New: "New", Doing: "Doing", Done: "Done", Dismissed: "Dismiss" };

const metricLabel = (metric: string) => (isMetricKey(metric) ? METRICS[metric].label : metric);
const metricValue = (metric: string, value: number | null | undefined) =>
  value === null || value === undefined ? "–" : isMetricKey(metric) ? formatMetric(metric, value) : String(value);

type Props = {
  suggestions: Suggestion[];
  /** The last full week, for "now" in the learning log. */
  latest: PulseWeek | undefined;
  onChange: (next: Suggestion) => void;
};

export function Suggestions({ suggestions, latest, onChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const active = suggestions.filter((s) => s.status === "New" || s.status === "Doing");
  const done = suggestions.filter((s) => s.status === "Done");
  const lastBatch = suggestions.map((s) => s.batch).sort().at(-1);

  async function move(s: Suggestion, status: SuggestionStatus) {
    setError(null);
    try {
      const { suggestion } = await request<{ suggestion: Suggestion }>(`/api/marketplace-pulse/suggestions/${encodeURIComponent(s.id)}`, {
        method: "PATCH", body: JSON.stringify({ status }),
      });
      onChange(suggestion);
    } catch (err) {
      setError(`Could not update "${s.title}": ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return (
    <section aria-label="Suggestions" className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="flex items-baseline gap-3 border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="text-[15px] font-semibold">Suggestions</h2>
        <span className="text-xs" style={{ color: "var(--bt-muted)" }}>
          Written every 3 days from these numbers{lastBatch ? ` · latest ${new Date(`${lastBatch}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}` : ""}
        </span>
      </div>
      {error && <div className="px-4 pt-3"><ErrorText error={error} /></div>}
      {!active.length && <p className="px-4 py-3 text-[13px]">No open suggestions. The next batch arrives with the next run.</p>}
      <ul>
        {active.map((s) => (
          <li key={s.id} className="flex flex-col gap-1 border-t px-4 py-3 text-[13px] first:border-t-0" style={{ borderColor: "var(--bt-divider)" }}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold">{s.title}</span>
              <span className="border px-1.5 text-[11px]" style={{ borderColor: "var(--bt-border)", color: "var(--bt-text-2)" }}>{s.owner}</span>
              {s.status === "Doing" && <span className="border px-1.5 text-[11px]" style={{ borderColor: "var(--bt-blue-border)", background: "var(--bt-blue-bg)", color: "var(--bt-blue)" }}>Doing</span>}
              <span className="flex-1" />
              {NEXT[s.status].map((status) => (
                <button key={status} type="button" onClick={() => void move(s, status)} className={`${buttonClass} h-7`} style={buttonStyle}
                  aria-label={`${BUTTON[status]}: ${s.title}`}>
                  {BUTTON[status]}
                </button>
              ))}
            </div>
            <p style={{ color: "var(--bt-text-2)" }}>{s.evidence}</p>
            <p><strong>Do:</strong> {s.action}</p>
            {s.metric && (
              <p className="text-xs" style={{ color: "var(--bt-muted)" }}>
                Should move {metricLabel(s.metric)}, {metricValue(s.metric, s.before_value)} in the week of {s.before_week ? weekLabel(s.before_week) : "–"}
              </p>
            )}
          </li>
        ))}
      </ul>
      {!!done.length && (
        <div aria-label="Learning log" role="region" className="border-t" style={{ borderColor: "var(--bt-divider)" }}>
          <h3 className="bt-label px-4 pb-1 pt-3">Learning log</h3>
          <table className="w-full text-[13px]">
            <tbody>
              {done.map((s) => (
                <tr key={s.id} className="border-t" style={{ borderColor: "var(--bt-divider)" }}>
                  <td className="px-4 py-1.5">{s.title}</td>
                  <td className="px-3 py-1.5 text-xs" style={{ color: "var(--bt-muted)" }}>
                    done {s.status_changed_at ? new Date(s.status_changed_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}
                  </td>
                  <td className="bt-mono whitespace-nowrap px-4 py-1.5 text-right">
                    {s.metric
                      ? `${metricLabel(s.metric)}: ${metricValue(s.metric, s.before_value)} → ${metricValue(s.metric, isMetricKey(s.metric) ? latest?.values[s.metric] : undefined)}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
