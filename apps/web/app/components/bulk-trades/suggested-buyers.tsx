"use client";

import { useState } from "react";
import type { SuggestedBuyer } from "@/lib/bulk-demand";
import { shortDate } from "@/lib/bulk-trade-details";
import { DemandBadge, TierBadge } from "./demand-badge";
import { Card, ErrorText, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, request, tradeUrl } from "./trade-ui";

type Props = {
  tradeId: string;
  suggested: SuggestedBuyer[];
  onChanged: () => void;
  onOpenDemand?: () => void;
};

const STRENGTH = {
  strong: { label: "Strong fit", style: { background: "var(--bt-green-bg)", color: "var(--bt-green)", borderColor: "var(--bt-green-border)" } },
  partial: { label: "Partial fit", style: { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" } },
} as const;

const INTRODUCE_SHOWN = 10;

const GROUPS = [
  { key: "offer", label: "Offer now", hint: "Buyers we deal with, or who told us what they want" },
  { key: "introduce", label: "Introduce", hint: "New buyers matched on our estimate: a reason to introduce ReBattery" },
] as const;

/** Open buyer demand the matching picked for this trade, ranked by how firm it is, each one click from the buyer list.
 * Split into buyers to offer the trade to now and new buyers to introduce ourselves to. */
export function SuggestedBuyers({ tradeId, suggested, onChanged, onOpenDemand }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // "Introduce" can run to dozens of research matches: folded until asked for, then the first INTRODUCE_SHOWN.
  const [introduceOpen, setIntroduceOpen] = useState(false);
  const [introduceAll, setIntroduceAll] = useState(false);
  if (!suggested.length) return null;

  async function act(demandId: string, method: "POST" | "DELETE") {
    setBusy(demandId);
    setError(null);
    try {
      await request(tradeUrl(tradeId, `/suggested/${encodeURIComponent(demandId)}`), { method });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card label="Suggested buyers">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-3.5" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="text-base font-semibold">Suggested buyers</h2>
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
          One line per buyer · {GROUPS.map((g) => `${suggested.filter((item) => item.group === g.key).length} ${g.label.toLowerCase()}`).join(", ")}
        </span>
        <span className="flex-1" />
        {onOpenDemand && (
          <button type="button" onClick={onOpenDemand} className="text-[13px] font-medium hover:underline" style={{ color: "var(--bt-link)" }}>
            All demand
          </button>
        )}
      </header>
      {error && <div className="px-5 pt-2"><ErrorText error={error} /></div>}
      {GROUPS.map((group) => {
        const all = suggested.filter((item) => item.group === group.key);
        if (!all.length) return null;
        const folded = group.key === "introduce" && !introduceOpen;
        const items = group.key === "introduce" && !introduceAll ? all.slice(0, INTRODUCE_SHOWN) : all;
        return (
          <section key={group.key} aria-label={group.label}>
            <h3 className="flex flex-wrap items-baseline gap-2 border-b px-5 py-2 text-[13px] font-semibold"
              style={{ borderColor: "var(--bt-divider)", background: "var(--bt-divider)" }}>
              {group.label} ({all.length})
              <span className="font-normal" style={{ color: "var(--bt-muted)" }}>{group.hint}</span>
              {group.key === "introduce" && (
                <button type="button" aria-expanded={!folded} onClick={() => setIntroduceOpen(!introduceOpen)}
                  className="ml-auto font-medium hover:underline" style={{ color: "var(--bt-link)" }}>
                  {folded ? "Show" : "Hide"}
                </button>
              )}
            </h3>
            {!folded && <ul>
              {items.map((item) => (
                <li key={item.demand_id} className="grid grid-cols-1 items-center gap-3 border-b px-5 py-3 last:border-b-0 md:grid-cols-[minmax(160px,1fr)_minmax(200px,1.3fr)_minmax(220px,1.8fr)_auto_auto]"
                  style={{ borderColor: "var(--bt-divider)" }}>
                  <div className="flex flex-col items-start gap-1">
                    <span className="text-sm font-semibold">{item.buyer}</span>
                    <span className="flex flex-wrap gap-1">
                      <TierBadge tier={item.tier} />
                      <DemandBadge kind={item.kind} basis={item.basis} />
                      <span className="rounded-none border px-1.5 py-px text-xs font-medium" style={STRENGTH[item.strength].style}>{STRENGTH[item.strength].label}</span>
                    </span>
                  </div>
                  <span className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>
                    “{item.wants}”
                    {item.kind === "request" && item.needed_by && <span style={{ color: "var(--bt-muted)" }}> · needed by {shortDate(item.needed_by)}</span>}
                    {item.kind === "standing" && item.confirmed_on && <span style={{ color: "var(--bt-muted)" }}> · confirmed {shortDate(item.confirmed_on)}</span>}
                    {item.more.length > 0 && (
                      <button type="button" aria-expanded={expanded === item.demand_id}
                        onClick={() => setExpanded(expanded === item.demand_id ? null : item.demand_id)}
                        className="ml-1 font-medium hover:underline" style={{ color: "var(--bt-link)" }}>
                        {expanded === item.demand_id ? "hide" : `+${item.more.length} more ${item.more.length === 1 ? "want" : "wants"}`}
                      </button>
                    )}
                    {expanded === item.demand_id && (
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {item.more.map((other) => (
                          <li key={other.demand_id}>“{other.wants}” <span style={{ color: "var(--bt-muted)" }}>· {other.strength}, {other.reason}</span></li>
                        ))}
                      </ul>
                    )}
                  </span>
                  <span className="text-[13px]">{item.reason}</span>
                  <button type="button" disabled={busy === item.demand_id} onClick={() => act(item.demand_id, "POST")} className={`${darkButtonClass} h-8`} style={darkButtonStyle}>
                    Add to buyers
                  </button>
                  <button type="button" disabled={busy === item.demand_id} onClick={() => act(item.demand_id, "DELETE")} className={`${buttonClass} h-8`} style={buttonStyle}
                    aria-label={`Not a fit: ${item.buyer}`}>
                    Not a fit
                  </button>
                </li>
              ))}
            </ul>}
            {!folded && group.key === "introduce" && all.length > INTRODUCE_SHOWN && (
              <button type="button" onClick={() => setIntroduceAll(!introduceAll)}
                className="w-full border-t px-5 py-2 text-left text-[13px] font-medium hover:underline"
                style={{ borderColor: "var(--bt-divider)", color: "var(--bt-link)" }}>
                {introduceAll ? `Show the first ${INTRODUCE_SHOWN}` : `Show all ${all.length}`}
              </button>
            )}
          </section>
        );
      })}
    </Card>
  );
}
