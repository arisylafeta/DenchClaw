"use client";

import { useEffect, useState } from "react";
import { Mail, PhoneCall, Phone, Search, MessageSquare, FileText, MessageCircle, Clock, ChevronDown, ArrowUpRight } from "lucide-react";
import type { DemandActivity } from "@/lib/crm-postgres/bulk-demand-activity";
import { shortDate } from "@/lib/bulk-trade-details";

/** What kind of event this is, in the words people use: email, call, research. */
export function storyLabel(entry: Pick<DemandActivity, "kind" | "ref_kind" | "ref_id" | "data">): string {
  const source = String(entry.data?.source ?? "").toLowerCase();
  if (entry.kind === "call") return source === "granola" || /granola/i.test(entry.ref_id ?? "") ? "Granola call" : "Call";
  if (entry.kind === "outreach") return entry.ref_kind === "email" ? "Email" : "Outreach";
  return {
    research: "Research", quote: "Quote", note: "Note", supply: "Supply", status: "Status",
    document: "Document", mail: "Mail", whatsapp: "WhatsApp",
  }[entry.kind] ?? "Activity";
}

/** The icon for the kind. Every badge is the same neutral grey — no colour-coding by type. */
function iconFor(label: string): typeof Mail {
  switch (label) {
    case "Email": case "Mail": return Mail;
    case "Granola call": return PhoneCall;
    case "Call": return Phone;
    case "Research": return Search;
    case "Quote": case "Document": return FileText;
    case "WhatsApp": return MessageCircle;
    case "Status": return Clock;
    default: return MessageSquare;
  }
}

const SUMMARY_LENGTH = 50;

/** The summary line: the first bit of what was actually recorded, not a generic label. Falls back when there's no body. */
function summaryLine(entry: DemandActivity, label: string, state: string | null): string {
  const body = entry.body?.trim().replace(/\s+/g, " ") ?? "";
  if (body) return body.length > SUMMARY_LENGTH ? `${body.slice(0, SUMMARY_LENGTH).trimEnd()}…` : body;
  if (label === "Email") return state === "draft" ? "Drafted, not sent yet" : state === "sent" ? "Sent to the buyer" : "Email on this request";
  if (label === "Mail") return "Mail on this request";
  if (label === "WhatsApp") return "WhatsApp message";
  if (label === "Granola call") return "Notes from a recorded call";
  if (label === "Call") return "Phone call logged";
  if (label === "Quote") return "Price or terms quoted";
  if (label === "Document") return "A prepared document";
  if (label === "Supply") return "Linked to a supplier offer";
  if (label === "Outreach") return "Outreach logged";
  if (label === "Status") return "Automatic status change";
  return "Note on this request";
}

/** The word on the evidence link, so it says what it opens. */
function evidenceLabel(entry: DemandActivity): string {
  if (entry.ref_kind === "lot") return "Trade";
  if (entry.ref_kind === "supply") return "Offer";
  if (entry.kind === "call") return "Call";
  if (entry.ref_kind === "email") return "Email";
  return "Source";
}

export function StoryEntry({ entry, last, animate, delay, onOpenTrade, onOpenSupply }: {
  entry: DemandActivity;
  last?: boolean;
  animate?: boolean;
  delay?: number;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const quiet = entry.kind === "status";
  const body = entry.body?.trim() ?? "";
  const state = typeof entry.data?.state === "string" ? entry.data.state : null; // "draft" / "sent", only when recorded
  const refId = entry.ref_id;
  const openable = refId && (entry.ref_kind === "lot" || entry.ref_kind === "supply" || /^https?:\/\//i.test(refId));
  const expandable = !!body || !!openable;
  const label = storyLabel(entry);
  const Icon = iconFor(label);
  const openEvidence = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (entry.ref_kind === "lot") onOpenTrade(refId!);
    else if (entry.ref_kind === "supply") onOpenSupply?.(refId!);
  };
  return (
    <li className="group relative flex min-w-0 gap-3 py-3" style={{ opacity: quiet ? 0.7 : 1 }}>
      <div className="flex shrink-0 flex-col items-center" aria-hidden>
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-[transform,opacity] duration-300 ease-out"
          style={{
            background: "var(--bt-segment)", color: "var(--bt-muted)",
            transitionDelay: `${delay ?? 0}ms`,
            transform: animate ? "scale(1)" : "scale(0.4)",
            opacity: animate ? 1 : 0,
          }}
        >
          <Icon size={13} />
        </span>
        <time className="mt-1 whitespace-nowrap text-[10px]" style={{ color: "var(--bt-muted)" }} dateTime={entry.occurred_at}>
          {shortDate(entry.occurred_at.slice(0, 10))}
        </time>
        {!last && (
          <span
            className="mt-1 w-px flex-1 origin-top transition-transform duration-500 ease-out"
            style={{ background: "var(--bt-border)", minHeight: "14px", transitionDelay: `${delay ?? 0}ms`, transform: animate ? "scaleY(1)" : "scaleY(0)" }}
          />
        )}
      </div>
      <button type="button" disabled={!expandable} aria-expanded={open} onClick={() => expandable && setOpen((v) => !v)}
        className="min-w-0 flex-1 pb-1 text-left disabled:cursor-default">
        <p className="pr-6 text-[14px] font-semibold leading-snug">
          {entry.title}
          {state && <span className="ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: "var(--bt-segment)", color: "var(--bt-text-2)" }}>{state}</span>}
        </p>
        <div className="mt-0.5 flex items-baseline gap-2 pr-6">
          <span className="text-[11.5px] font-medium" style={{ color: "var(--bt-muted)" }}>{label}</span>
          <span className="truncate text-[11.5px]" style={{ color: "var(--bt-muted)" }}>{summaryLine(entry, label, state)}</span>
        </div>
        {open && body && (
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-snug" style={{ color: "var(--bt-text-2)" }}>{body}</p>
        )}
        {open && openable && (entry.ref_kind === "lot" || entry.ref_kind === "supply" ? (
          <span role="button" tabIndex={0} className="mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium"
            style={{ background: "var(--bt-segment)", color: "var(--bt-text)" }} onClick={openEvidence}>
            {evidenceLabel(entry)} <ArrowUpRight size={12} />
          </span>
        ) : (
          <a className="mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium"
            style={{ background: "var(--bt-segment)", color: "var(--bt-text)" }} href={refId} target="_blank" rel="noreferrer"
            onClick={(e) => e.stopPropagation()}>
            {evidenceLabel(entry)} <ArrowUpRight size={12} />
          </a>
        ))}
        {open && !openable && refId && entry.ref_kind === "email" && (
          <p className="mt-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }}>Email recorded; no link to open it.</p>
        )}
      </button>
      {expandable && (
        <ChevronDown size={14} aria-hidden className="absolute right-0 top-3.5 shrink-0 transition-transform" style={{ color: "var(--bt-muted)", transform: open ? "rotate(180deg)" : "none" }} />
      )}
    </li>
  );
}

/** The whole story, as a connected, animated timeline that draws itself in every time it opens. */
export function Story({ activity, onOpenTrade, onOpenSupply }: {
  activity: DemandActivity[];
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
}) {
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <ol className="flex flex-col px-2 sm:px-3">
      {activity.map((entry, index) => (
        <StoryEntry key={entry.id} entry={entry} last={index === activity.length - 1}
          animate={animate} delay={Math.min(index * 50, 400)}
          onOpenTrade={onOpenTrade} onOpenSupply={onOpenSupply} />
      ))}
    </ol>
  );
}
