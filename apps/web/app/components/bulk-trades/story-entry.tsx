"use client";

import { useEffect, useState } from "react";
import { Trash2, Mail, Send, PhoneCall, Phone, Search, MessageSquare, FileText, Package, Clock } from "lucide-react";
import type { DemandActivity } from "@/lib/crm-postgres/bulk-demand-activity";
import { shortDate } from "@/lib/bulk-trade-details";

/** What kind of event this is, in the words people use: email, call, research. */
export function storyLabel(entry: Pick<DemandActivity, "kind" | "ref_kind" | "ref_id" | "data">): string {
  const source = String(entry.data?.source ?? "").toLowerCase();
  if (entry.kind === "call") return source === "granola" || /granola/i.test(entry.ref_id ?? "") ? "Granola call" : "Call";
  if (entry.kind === "outreach") return entry.ref_kind === "email" ? "Email" : "Outreach";
  return { research: "Research", quote: "Quote", note: "Note", supply: "Supply", status: "Status" }[entry.kind] ?? "Activity";
}

/** The icon and accent colour for the kind, so the timeline reads at a glance. */
function iconFor(label: string): { Icon: typeof Mail; color: string } {
  switch (label) {
    case "Email": return { Icon: Mail, color: "var(--bt-accent)" };
    case "Granola call": return { Icon: PhoneCall, color: "var(--bt-accent)" };
    case "Call": return { Icon: Phone, color: "var(--bt-accent)" };
    case "Research": return { Icon: Search, color: "var(--bt-amber)" };
    case "Quote": return { Icon: FileText, color: "var(--bt-green)" };
    case "Supply": return { Icon: Package, color: "var(--bt-green)" };
    case "Outreach": return { Icon: Send, color: "var(--bt-accent)" };
    case "Status": return { Icon: Clock, color: "var(--bt-muted)" };
    default: return { Icon: MessageSquare, color: "var(--bt-muted)" };
  }
}

/** One short line of what this kind of entry actually means, only from what's recorded. */
function shortDescription(entry: DemandActivity, label: string, state: string | null): string {
  if (label === "Email") return state === "draft" ? "Drafted, not sent yet" : state === "sent" ? "Sent to the buyer" : "Email on this request";
  if (label === "Granola call") return "Notes from a recorded call";
  if (label === "Call") return "Phone call logged";
  if (label === "Research") return "Findings from research";
  if (label === "Quote") return "Price or terms quoted";
  if (label === "Supply") return "Linked to a supplier offer";
  if (label === "Outreach") return "Outreach logged";
  if (label === "Status") return "Automatic status change";
  return "Note on this request";
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

export function StoryEntry({ entry, busy, last, animate, delay, onDelete, onOpenTrade, onOpenSupply }: {
  entry: DemandActivity;
  busy: boolean;
  last?: boolean;
  animate?: boolean;
  delay?: number;
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
  const label = storyLabel(entry);
  const { Icon, color } = iconFor(label);
  return (
    <li className="group relative flex min-w-0 gap-3 py-3" style={{ opacity: quiet ? 0.7 : 1 }}>
      <div className="flex shrink-0 flex-col items-center" aria-hidden>
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-[transform,opacity] duration-300 ease-out"
          style={{
            background: quiet ? "var(--bt-segment)" : color,
            color: quiet ? "var(--bt-muted)" : "var(--bt-on-accent)",
            transitionDelay: `${delay ?? 0}ms`,
            transform: animate ? "scale(1)" : "scale(0.4)",
            opacity: animate ? 1 : 0,
          }}
        >
          <Icon size={13} />
        </span>
        {!last && (
          <span
            className="mt-1 w-px flex-1 origin-top transition-transform duration-500 ease-out"
            style={{ background: "var(--bt-border)", minHeight: "20px", transitionDelay: `${delay ?? 0}ms`, transform: animate ? "scaleY(1)" : "scaleY(0)" }}
          />
        )}
      </div>
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex items-baseline gap-2 pr-9">
          <span className="text-[12px] font-semibold" style={{ color: "var(--bt-text)" }}>{label}</span>
          <span className="text-[11.5px]" style={{ color: "var(--bt-muted)" }}>{shortDescription(entry, label, state)}</span>
          <time className="ml-auto shrink-0 text-[11px]" style={{ color: "var(--bt-muted)" }} dateTime={entry.occurred_at}>
            {shortDate(entry.occurred_at.slice(0, 10))}
          </time>
        </div>
        <p className="mt-1 pr-9 text-[14px] leading-snug" style={{ fontWeight: quiet ? 400 : 600 }}>
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

/** The whole story, as a connected, animated timeline that draws itself in every time it opens. */
export function Story({ activity, busy, onDelete, onOpenTrade, onOpenSupply }: {
  activity: DemandActivity[];
  busy: boolean;
  onDelete: (id: string) => void;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
}) {
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <ol className="flex flex-col">
      {activity.map((entry, index) => (
        <StoryEntry key={entry.id} entry={entry} busy={busy} last={index === activity.length - 1}
          animate={animate} delay={Math.min(index * 50, 400)}
          onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} onDelete={() => onDelete(entry.id)} />
      ))}
    </ol>
  );
}
