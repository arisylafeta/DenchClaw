"use client";

import { useState } from "react";
import { ukTime, type Proposal } from "@/lib/bulk-trade-details";
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
  possible_trade: "Create trade",
};

type Props = {
  proposal: Proposal;
  /** Called after Alex accepts or ignores; lot_id is the trade it applied to. */
  onDecided: (proposal: Proposal, action: "accept" | "ignore", lotId: string | null) => void;
  compact?: boolean;
};

/** One inbox-check finding with its quote and source. Nothing changes until Accept. */
export function ProposalRow({ proposal, onDecided, compact }: Props) {
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
      <span className="mt-0.5 rounded-none px-[7px] py-0.5 text-[11px] font-semibold uppercase" style={{ background: "var(--bt-badge)", color: "var(--bt-on-badge)" }}>
        New
      </span>
      <div className="min-w-[220px] flex-1">
        <div className="text-sm">
          {proposal.summary} <span style={{ color: "var(--bt-muted)" }}>· {ukTime(proposal.created_at)} check</span>
        </div>
        <div className="mt-0.5 text-[13px]" style={{ color: "var(--bt-muted)" }}>
          “{proposal.quote}” ·{" "}
          {proposal.source_url
            ? <a href={proposal.source_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--bt-link)" }}>{source}</a>
            : source}
        </div>
        <ErrorText error={error} />
      </div>
      <button type="button" disabled={saving} onClick={() => decide("accept")} className={`${darkButtonClass} h-8`} style={darkButtonStyle}>
        {ACCEPT_LABEL[proposal.kind]}
      </button>
      {proposal.kind !== "needs_triage" && (
        <button type="button" disabled={saving} onClick={() => decide("ignore")} className={`${buttonClass} h-8`} style={buttonStyle}>
          Ignore
        </button>
      )}
    </div>
  );
}

