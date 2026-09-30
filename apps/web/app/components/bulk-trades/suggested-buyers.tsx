"use client";

import { useState } from "react";
import type { SuggestedBuyer } from "@/lib/bulk-demand";
import { shortDate } from "@/lib/bulk-trade-details";
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

/** Open buyer demand the daily matching picked for this trade, each one click from the buyer list. */
export function SuggestedBuyers({ tradeId, suggested, onChanged, onOpenDemand }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>from open demand</span>
        <span className="flex-1" />
        {onOpenDemand && (
          <button type="button" onClick={onOpenDemand} className="text-[13px] font-medium hover:underline" style={{ color: "var(--bt-link)" }}>
            All demand
          </button>
        )}
      </header>
      {error && <div className="px-5 pt-2"><ErrorText error={error} /></div>}
      <ul>
        {suggested.map((item) => (
          <li key={item.demand_id} className="grid grid-cols-1 items-center gap-3 border-b px-5 py-3 last:border-b-0 md:grid-cols-[minmax(160px,1fr)_minmax(200px,1.3fr)_minmax(220px,1.8fr)_auto_auto]"
            style={{ borderColor: "var(--bt-divider)" }}>
            <div className="flex flex-col items-start gap-1">
              <span className="text-sm font-semibold">{item.buyer}</span>
              <span className="rounded-none border px-1.5 py-px text-xs font-medium" style={STRENGTH[item.strength].style}>{STRENGTH[item.strength].label}</span>
            </div>
            <span className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>
              “{item.wants}”
              {item.confirmed_on && <span style={{ color: "var(--bt-muted)" }}> · confirmed {shortDate(item.confirmed_on)}</span>}
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
      </ul>
    </Card>
  );
}
