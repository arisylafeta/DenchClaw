"use client";

import { useState } from "react";
import { type Proposal } from "@/lib/bulk-trade-details";
import { ErrorText, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, request } from "./trade-ui";

const ACCEPT_LABEL: Record<Proposal["kind"], string> = {
  field: "Use this",
  buyer_update: "Update buyer",
  next_step: "Set next step",
  new_buyer: "Add buyer",
  file: "Add file",
  needs_triage: "Got it",
  link_contact: "Add contact",
  trade_kind: "Set kind",
  bid: "Add bid",
  link_auction: "Link auction",
  possible_demand: "Add demand",
  possible_supply: "Add to supply",
  possible_trade: "Create trade",
};

type Props = {
  proposal: Proposal;
  /** Called after Alex accepts or ignores; lot_id is the trade it applied to. */
  onDecided: (proposal: Proposal, action: "accept" | "ignore", lotId: string | null) => void;
  compact?: boolean;
  /** Overrides the accept button's wording. */
  acceptLabel?: string;
};

/** One inbox-check finding waiting for Alex, with its quote and source. Nothing changes until Accept. */
export function ProposalRow({ proposal, onDecided, compact, acceptLabel }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: "accept" | "ignore") {
    setSaving(true);
    setError(null);
    try {
      const { lot_id } = await request<{ lot_id: string | null }>(`/api/bulk-trades/proposals/${proposal.id}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      onDecided(proposal, action, lot_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  const source = `${proposal.source_label}${proposal.source_at ? ` · ${new Date(proposal.source_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}`;
  return (
    <div
      role="group"
      aria-label={`New: ${proposal.summary}`}
      className={`flex flex-wrap items-start gap-2.5 ${compact ? "py-2" : "px-5 py-3"}`}
      style={compact ? undefined : { background: "var(--bt-table-head)" }}
    >
      <div className="min-w-0 flex-1">
        <details className="text-xs" style={{ color: "var(--bt-muted)" }}>
          <summary className="flex cursor-pointer items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm" style={{ color: "var(--bt-text)" }} title={proposal.summary}>{proposal.summary}</span>
            <span className="max-w-[160px] truncate" title={source}>{source}</span><span>Quote</span>
          </summary>
          <p className="py-2">“{proposal.quote}” {proposal.source_url && <a href={proposal.source_url} target="_blank" rel="noreferrer" className="underline">Source</a>}</p>
        </details>
        <ErrorText error={error} />
      </div>
      <button type="button" disabled={saving} onClick={() => decide("accept")} className={`${darkButtonClass} h-8`} style={darkButtonStyle}>
        {acceptLabel ?? ACCEPT_LABEL[proposal.kind]}
      </button>
      {proposal.kind !== "needs_triage" && (
        <button type="button" disabled={saving} onClick={() => decide("ignore")} className={`${buttonClass} h-8`} style={buttonStyle}>
          Ignore
        </button>
      )}
    </div>
  );
}

