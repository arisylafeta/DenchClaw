"use client";
import { useState, useId } from "react";
import { Mail, MessageCircle, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import type { ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import { shortDate } from "@/lib/bulk-trade-details";
import { rowFocus } from "./demand-page";
import { MessageItem } from "./offers-tab";
export type ListingMail = { id: string; thread_id: string | null; direction: "inbound" | "outbound"; subject: string | null; preview: string | null; body?: string | null; from_email: string | null; at: string };
/** One channel's messages with the buyer as a single white accordion: a summary line that opens to every message, plus a link to the thread itself. */
function ChannelAccordion({ label, icon: Icon, entries, empty, linkLabel }: { label: string; icon: typeof Mail; entries: ThreadEntry[]; empty: string; linkLabel: string }) {
  const [open, setOpen] = useState(false);
  const newest = entries.reduce<ThreadEntry | null>((latest, e) => (!latest || Date.parse(e.at) > Date.parse(latest.at) ? e : latest), null);
  const threadHref = entries.filter((e) => e.href).sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0]?.href ?? null;
  const summary = entries.length ? `${entries.length} message${entries.length === 1 ? "" : "s"}${newest ? ` · last ${shortDate(newest.at.slice(0, 10))}` : ""}` : empty;
  const bodyId = useId();
  return (
    <div className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="flex items-center gap-2 pr-3">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} className={`${rowFocus} flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left`}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--bt-segment)", color: "var(--bt-muted)" }}><Icon size={13} aria-hidden /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">{label}</span>
            <span className="block truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>{summary}</span>
          </span>
          {open ? <ChevronDown size={14} aria-hidden style={{ color: "var(--bt-muted)" }} /> : <ChevronRight size={14} aria-hidden style={{ color: "var(--bt-muted)" }} />}
        </button>
        {threadHref && (
          <a href={threadHref} aria-label={linkLabel} title={linkLabel} className={`${rowFocus} inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px]`} style={{ background: "var(--bt-segment)", color: "var(--bt-text-2)" }}>
            <ExternalLink size={11} aria-hidden /> Open
          </a>
        )}
      </div>
      {open && <ul id={bodyId} className="border-t px-3" style={{ borderColor: "var(--bt-divider)" }}>{entries.map((e) => <MessageItem key={e.id} entry={e} loading={false} />)}</ul>}
    </div>
  );
}

/** The buyer's conversations, shown inside their card: one accordion for WhatsApp and one for email, each linking to the thread. */
export function ListingConversation({ mail, conversation, loading, subject = "demand" }: { mail: ListingMail[]; conversation: ThreadEntry[] | null; loading: boolean; subject?: string }) {
  // Labelled threads (email and WhatsApp about this exact demand) win; until a thread is labelled we show all mail with the buyer.
  const entries: ThreadEntry[] = conversation ?? mail.map((m) => ({
    id: m.id, channel: "mail" as const, direction: m.direction, title: m.subject ?? "(no subject)", body: m.body ?? m.preview, at: m.at, ref: m.thread_id,
    href: m.thread_id ? `/?crm=inbox&view=conversations&thread=${encodeURIComponent(m.thread_id)}&crmOnly=false` : null,
  }));
  if (loading) return null;
  return (
    <>
      {conversation && <ChannelAccordion label="WhatsApp" icon={MessageCircle} linkLabel="Open WhatsApp chat" entries={entries.filter((e) => e.channel === "whatsapp")} empty={`No WhatsApp messages linked to this ${subject}`} />}
      <ChannelAccordion label="Email" icon={Mail} linkLabel="Open email thread" entries={entries.filter((e) => e.channel === "mail")} empty={`No email linked to this ${subject}`} />
    </>
  );
}

