"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { DemandActivity } from "@/lib/crm-postgres/bulk-demand-activity";
import { shortDate } from "@/lib/bulk-trade-details";

/** What kind of event this is, in the words people use: email, call, research. */
export function storyLabel(entry: Pick<DemandActivity, "kind" | "ref_kind" | "ref_id" | "data">): string {
  const source = String(entry.data?.source ?? "").toLowerCase();
  if (entry.kind === "call") return source === "granola" || /granola/i.test(entry.ref_id ?? "") ? "Granola call" : "Call";
  if (entry.kind === "outreach") return entry.ref_kind === "email" ? "Email" : "Outreach";
  return { research: "Research", quote: "Quote", note: "Note", supply: "Supply", status: "Status" }[entry.kind] ?? "Activity";
}

/** The word on the evidence link, so it says what it opens. */
function evidenceLabel(entry: DemandActivity): string {
  if (entry.ref_kind === "lot") return "View trade";
  if (entry.ref_kind === "supply") return "View offer";
  if (entry.kind === "call") return "Open call";
  if (entry.ref_kind === "email") return "Open email";
  return "Open source";
}

const LONG = 220;

export function StoryEntry({ entry, busy, onDelete, onOpenTrade, onOpenSupply }: {
  entry: DemandActivity;
  busy: boolean;
  onDelete: () => void;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const quiet = entry.kind === "status";
  const body = entry.body?.trim() ?? "";
  const long = body.length > LONG;
  const state = typeof entry.data?.state === "string" ? entry.data.state : null; // "draft" / "sent", only when recorded
  const refId = entry.ref_id;
  const openable = refId && (entry.ref_kind === "lot" || entry.ref_kind === "supply" || /^https?:\/\//i.test(refId));
  return (
    <li className="group relative flex min-w-0 flex-col gap-1 py-3" style={{ opacity: quiet ? 0.7 : 1 }}>
      <div className="flex items-center gap-2 pr-9">
        <span className="block text-[12px] font-semibold" style={{ color: "var(--bt-text-2)" }}>{storyLabel(entry)}</span>
        <time className="block text-[12px]" style={{ color: "var(--bt-muted)" }} dateTime={entry.occurred_at}>
          {shortDate(entry.occurred_at.slice(0, 10))}
        </time>
      </div>
      <div className="min-w-0 flex-1">
        <p className="pr-9 text-[13px] leading-snug" style={{ fontWeight: quiet ? 400 : 500 }}>
          {entry.title}
          {state && <span className="ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: "var(--bt-segment)", color: "var(--bt-text-2)" }}>{state}</span>}
        </p>
        {body && (
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-snug" style={{ color: "var(--bt-text-2)" }}>
            {long && !expanded ? `${body.slice(0, LONG).trimEnd()}…` : body}
            {long && (
              <button type="button" className="ml-1 underline" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </p>
        )}
        {openable && (entry.ref_kind === "lot" || entry.ref_kind === "supply" ? (
          <button type="button" className="mt-1.5 text-[13px] underline" style={{ color: "var(--bt-link)" }}
            onClick={() => (entry.ref_kind === "lot" ? onOpenTrade(refId) : onOpenSupply?.(refId))}>{evidenceLabel(entry)}</button>
        ) : (
          <a className="mt-1.5 inline-block text-[13px] underline" style={{ color: "var(--bt-link)" }} href={refId} target="_blank" rel="noreferrer">{evidenceLabel(entry)}</a>
        ))}
        {!openable && refId && entry.ref_kind === "email" && (
          <p className="mt-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }}>Email recorded; no link to open it.</p>
        )}
      </div>
      <button type="button" disabled={busy} aria-label={`Delete ${entry.title}`} onClick={onDelete}
        className="absolute right-0 top-2 h-11 w-9 rounded-md opacity-0 hover:bg-[var(--bt-row-hover)] focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-60"
        style={{ color: "var(--bt-muted)" }}>
        <Trash2 size={13} className="mx-auto" />
      </button>
    </li>
  );
}
