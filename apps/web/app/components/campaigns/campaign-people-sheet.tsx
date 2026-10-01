"use client";

import { useRef, useState } from "react";
import type { MouseEvent } from "react";
import { flushSync } from "react-dom";
import { ChevronRight, X } from "lucide-react";
import type { CampaignActivityPerson } from "@/lib/campaign-activity";
import type { CampaignRecipient } from "@/lib/campaigns";
import { buildEntryLink } from "@/lib/workspace-links";
import { buttonClass, buttonStyle, inputClass, inputStyle } from "../bulk-trades/trade-ui";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../platform-admin/ui/sheet";
import { Input } from "../ui/input";
import { CampaignDate, PAGE_SIZE, Pagination, cellClass, cellStyle, mutedStyle } from "./campaign-ui";

export type PeopleSource = "email" | "click" | "browser" | "offer" | "message" | "buy_now";
export type CampaignPersonRow = { recipient: CampaignRecipient; activity?: CampaignActivityPerson };
export const SOURCE_LABELS: Record<PeopleSource, string> = { email: "Email clicks", click: "Tracked clicks", browser: "Browser activity", offer: "Offers", message: "Messages", buy_now: "Buy now" };
export const SUBMISSION_FIELDS: Record<Exclude<PeopleSource, "email" | "click" | "browser">, {
  count: "offer_events" | "message_events" | "buy_now_events";
  last_at: "last_offer_at" | "last_message_at" | "last_buy_now_at";
}> = {
  offer: { count: "offer_events", last_at: "last_offer_at" },
  message: { count: "message_events", last_at: "last_message_at" },
  buy_now: { count: "buy_now_events", last_at: "last_buy_now_at" },
};

export function CampaignPeopleSheet({ destination, source, count, rows, onNavigatePerson }: {
  destination: string; source: PeopleSource; count: number; rows: CampaignPersonRow[]; onNavigatePerson: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const navigating = useRef(false);
  function navigate(event: MouseEvent<HTMLAnchorElement>, id: string) {
    const inApp = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (inApp) { event.preventDefault(); }
    navigating.current = inApp;
    flushSync(() => setOpen(false));
    if (inApp) { onNavigatePerson(id); }
  }
  return (
    <Sheet open={open} onOpenChange={(value) => { navigating.current = false; setOpen(value); }}>
      <SheetTrigger asChild>
        <button type="button" aria-label={`${destination}: ${SOURCE_LABELS[source]}, ${count}`} className="bt-mono inline-flex items-center gap-1 rounded-none text-[13px] underline decoration-transparent underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bt-text)]" style={{ color: "var(--bt-link)" }}>{count.toLocaleString("en-GB")} {source === "click" ? count === 1 ? "click" : "clicks" : source === "browser" || source === "email" ? count === 1 ? "recipient" : "recipients" : count === 1 ? "event" : "events"}<ChevronRight size={14} aria-hidden="true" /></button>
      </SheetTrigger>
      <SheetContent side="right" showCloseButton={false} className="bulk-trades gap-0 rounded-none p-0 sm:max-w-none" style={{ width: "min(960px, 100vw)", maxWidth: "100vw", borderRadius: 0, background: "var(--bt-surface)", color: "var(--bt-text)", borderColor: "var(--bt-border)" }} onCloseAutoFocus={(event) => { if (navigating.current) { event.preventDefault(); } }}>
        <header className="flex items-start justify-between gap-4 border-b px-4 py-4" style={{ borderColor: "var(--bt-border)" }}>
          <div className="min-w-0">
            <SheetTitle className="text-base font-semibold" style={{ color: "var(--bt-text)" }}>{destination} — {SOURCE_LABELS[source]}</SheetTitle>
            <SheetDescription className="mt-1 text-[13px]" style={mutedStyle}>{source === "email" ? "Email-clicked recipient records from the retained ledger. Counts and latest click/view times are separate PostHog observations, not Postmark totals. Unknown means website evidence is unavailable or unmapped." : "PostHog observations for assigned destination links. Redirect clicks can be automated; forwarded links do not verify the named recipient, and missing consented views do not prove inactivity."}</SheetDescription>
          </div>
          <SheetClose asChild><button type="button" aria-label="Close people sheet" className={`${buttonClass} h-8 w-8 shrink-0 rounded-none p-0`} style={{ ...buttonStyle, borderRadius: 0, height: 32, width: 32, padding: 0 }}><X size={14} aria-hidden="true" /></button></SheetClose>
        </header>
        <PeopleTable rows={rows} source={source} navigate={navigate} />
      </SheetContent>
    </Sheet>
  );
}

function PeopleTable({ rows, source, navigate }: { rows: CampaignPersonRow[]; source: PeopleSource; navigate: (event: MouseEvent<HTMLAnchorElement>, id: string) => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const table = useRef<HTMLTableElement>(null);
  const term = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(({ recipient }) => !term || [recipient.person_name, recipient.company_name, recipient.recipient_email].some((value) => value?.toLocaleLowerCase().includes(term)));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const headers = source === "email" ? ["Recipient", "Redirect clicks (PostHog)", "Last click (PostHog)", "Last view (PostHog)"] : source === "click" ? ["Recipient", "Redirect clicks", "Last click", "Last view"] : source === "browser" ? ["Recipient", "Page events", "Sessions", "Last view"] : ["Recipient", `${SOURCE_LABELS[source]} events`, "Last action"];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)", background: "var(--bt-bg)" }}>
        <Input type="search" aria-label="Search sheet people" placeholder="Search name, company or email" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} className={`${inputClass} h-8 max-w-sm text-[13px] shadow-none focus-visible:ring-0`} style={inputStyle} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table ref={table} tabIndex={-1} aria-label="Destination people" className="w-full min-w-[560px] border-collapse text-left focus:outline-none">
          <thead style={{ background: "var(--bt-table-head)" }}><tr>{headers.map((label) => <th key={label} scope="col" className="bt-label border-b px-3.5 py-2.5" style={cellStyle}>{label}</th>)}</tr></thead>
          <tbody>
            {filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(({ recipient, activity }) => <tr key={recipient.person_id} className="hover:bg-[var(--bt-row-hover)]">
              <td className={`${cellClass} min-w-[220px]`} style={cellStyle}>
                <a href={buildEntryLink("people", recipient.person_id)} onClick={(event) => navigate(event, recipient.person_id)} onAuxClick={(event) => { if (event.button === 1) { navigate(event, recipient.person_id); } }} className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]" style={{ color: "var(--bt-link)" }}>{recipient.person_name || recipient.recipient_email}</a>
                {recipient.company_name && <div className="mt-0.5" style={mutedStyle}>{recipient.company_name}</div>}
                {recipient.person_name && <div className="mt-0.5 break-all text-xs" style={mutedStyle}>{recipient.recipient_email}</div>}
              </td>
              {source === "email" || source === "click" ? <>
                <td className={`${cellClass} bt-mono`} style={cellStyle}>{activity?.redirect_events ?? "Unknown"}</td>
                <td className={cellClass} style={cellStyle}>{activity ? <CampaignDate value={activity.last_clicked_at} withTime /> : "Unknown"}</td>
                <td className={cellClass} style={cellStyle}>{activity ? <CampaignDate value={activity.last_browser_at} withTime /> : "Unknown"}</td>
              </> : source === "browser" ? <>
                <td className={`${cellClass} bt-mono`} style={cellStyle}>{activity?.page_views ?? "Unknown"}</td>
                <td className={`${cellClass} bt-mono`} style={cellStyle}>{activity?.sessions ?? "Unknown"}</td>
                <td className={cellClass} style={cellStyle}><CampaignDate value={activity?.last_browser_at ?? null} withTime /></td>
              </> : <>
                <td className={`${cellClass} bt-mono`} style={cellStyle}>{activity ? activity[SUBMISSION_FIELDS[source].count] : "Unknown"}</td>
                <td className={cellClass} style={cellStyle}><CampaignDate value={activity?.[SUBMISSION_FIELDS[source].last_at] ?? null} withTime /></td>
              </>}
            </tr>)}
            {!filtered.length && <tr><td colSpan={headers.length} className="px-3.5 py-8 text-center text-[13px]" style={mutedStyle}>{rows.length ? "No recipient records match this search." : "No recipient records with this activity were observed."}</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={currentPage} count={filtered.length} onPage={(next) => { setPage(next); table.current?.focus({ preventScroll: true }); }} />
    </div>
  );
}
