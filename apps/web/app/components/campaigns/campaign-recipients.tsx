"use client";

import tableStyles from "../ui/data-table.module.css";
import styles from "./campaign-surface.module.css";
import { TableCell } from "../ui/table-cell";
import { useMemo, useRef, useState } from "react";
import type { CampaignRecipient } from "@/lib/campaigns";
import type { MailMessageListRow } from "@/lib/mail-types";
import { inputClass, inputStyle } from "../bulk-trades/trade-ui";
import { Input } from "../ui/input";
import stack from "./stack-table.module.css";
import { StageTag } from "../dismantlers/dismantler-ui";
import type { Stage } from "@/lib/dismantlers";
import { CampaignCard, CampaignDate, Observation, PAGE_SIZE, Pagination, PersonLink, cellStyle, firstClick, humanize, mutedStyle } from "./campaign-ui";

const FILTERS = ["All", "Replied", "Opened", "Clicked", "Bounced", "Tracking pending"] as const;
type RecipientFilter = typeof FILTERS[number];

/** Outreach campaigns retain dismantler stage and the frozen subject. */
export function CampaignRecipients({ recipients, deliveryRows = [], onNavigatePerson, outreach = false }: { recipients: CampaignRecipient[]; deliveryRows?: MailMessageListRow[]; onNavigatePerson: (id: string) => void; outreach?: boolean }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RecipientFilter>("All");
  const [page, setPage] = useState(0);
  const table = useRef<HTMLTableElement>(null);
  const deliveryById = useMemo(() => new Map(deliveryRows.map((row) => [row.id, row])), [deliveryRows]);
  const rows = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return recipients.filter((recipient) => {
      const matchesFilter = filter === "All"
        || (filter === "Replied" && !!recipient.replied_at)
        || (filter === "Opened" && !!recipient.opened_at)
        || (filter === "Clicked" && !!firstClick(recipient))
        || (filter === "Bounced" && (!!recipient.bounced_at || recipient.state.toLowerCase() === "bounced"))
        || (filter === "Tracking pending" && recipient.tracking_pending);
      return matchesFilter && (!term || [recipient.person_name, recipient.company_name, recipient.recipient_email, ...recipient.listing_clicks.map((listing) => listing.label), recipient.subject, recipient.dismantler_stage].some((value) => value?.toLocaleLowerCase().includes(term)));
    });
  }, [recipients, query, filter]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
  const visible = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <div className="bulk-trades"><CampaignCard label="Recipient ledger">
      <div data-table-part="toolbar" className="flex flex-wrap items-center gap-3 px-4 py-4" style={{ background: "var(--bt-bg)", borderColor: "var(--bt-divider)" }}>
        <Input data-table-part="search" type="search" aria-label="Search recipients" placeholder="Search recipients" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} className={`${inputClass} h-8 max-w-sm text-[13px] shadow-none focus-visible:ring-0`} style={inputStyle} />
        <div role="group" aria-label="Recipient activity" className="flex max-w-full flex-wrap gap-1 rounded-lg p-1" style={{ borderColor: "var(--bt-border)", background: "var(--bt-segment)" }}>
          {FILTERS.map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0); }} className="min-h-11 rounded-md px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bt-text)]" style={filter === value ? { background: "var(--bt-surface)", color: "var(--bt-text)", boxShadow: "0 1px 2px var(--bt-border)" } : { color: "var(--bt-text)" }}>{value}</button>)}
        </div>
      </div>
      <div className={styles.tableFrame}><div className={`bulk-trades max-w-full overflow-x-auto`}>
        <table ref={table} tabIndex={-1} aria-label="Recipients" className={`${tableStyles.table} ${stack.stack} min-w-[720px] focus:outline-none`}>
          <thead style={{ background: "var(--bt-table-head)" }}>
            <tr>{["Recipient", "Delivery", "Reply", "First open", "First click", outreach ? "Dismantler" : "Clicked listings", "Unsubscribed"].map((label) => <th key={label} scope="col" className={tableStyles.headerCell} style={cellStyle}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {visible.map((recipient) => (
              <tr key={recipient.send_id} className="hover:bg-[var(--bt-row-hover)]">
                <TableCell data-label="Recipient" className={`${tableStyles.cell} min-w-[220px]`} style={cellStyle}>{recipient.person_id ? <PersonLink id={recipient.person_id} onNavigate={onNavigatePerson}>{recipient.person_name || recipient.recipient_email}</PersonLink> : <span>{recipient.recipient_email}</span>}
                {recipient.company_name && <div className="mt-0.5" style={mutedStyle}>{recipient.company_name}</div>}
                {recipient.person_name && <div className="mt-0.5 break-all text-xs" style={mutedStyle}>{recipient.recipient_email}</div>}</TableCell>
                <TableCell data-label="Delivery" className={tableStyles.cell} style={cellStyle}><span style={{ color: recipient.bounced_at || recipient.state.toLowerCase() === "bounced" ? "var(--bt-red)" : "var(--bt-text)" }}>{recipient.bounced_at || recipient.state.toLowerCase() === "bounced" ? "Bounced" : recipient.delivered_at ? "Delivered" : recipient.accepted_at ? (recipient.tracked ? "Accepted" : "Sent from Gmail") : humanize(recipient.state)}</span>
                {(recipient.bounced_at || recipient.delivered_at || recipient.accepted_at) && <div className="mt-0.5 text-xs" style={mutedStyle}><CampaignDate value={recipient.bounced_at || recipient.delivered_at || recipient.accepted_at} withTime /></div>}
                {["unknown", "sending"].includes(recipient.state) && <div role="status" className="text-xs" style={{ color: "var(--bt-amber)" }}>Reconcile before retrying</div>}
                {recipient.tracking_pending && <div className="mt-0.5 text-xs" style={{ color: "var(--bt-amber)" }}>Tracking pending</div>}</TableCell>
                <TableCell data-label="Reply" className={tableStyles.cell} style={cellStyle}>{recipient.replied_at ? <CampaignDate value={recipient.replied_at} withTime /> : <span style={mutedStyle}>{recipient.accepted_at ? "No reply yet" : "Not sent"}</span>}</TableCell>
                <TableCell data-label="First tracked open" className={tableStyles.cell} style={cellStyle}><Observation at={recipient.opened_at} recipient={recipient} /></TableCell>
                <TableCell data-label="First tracked click" className={tableStyles.cell} style={cellStyle}><Observation at={firstClick(recipient)} recipient={recipient} /></TableCell>
                {outreach ? <TableCell data-label="Dismantler" className={`${tableStyles.cell} min-w-[200px]`} style={cellStyle}>{recipient.dismantler_stage ? <StageTag stage={recipient.dismantler_stage as Stage} /> : <span style={mutedStyle}>Not a dismantler</span>}
                {recipient.subject && <div className="mt-1 text-xs" style={mutedStyle}>{recipient.subject}</div>}</TableCell>
                : <TableCell data-label="Clicked listings" className={`${tableStyles.cell} min-w-[160px]`} style={cellStyle}>{recipient.listing_clicks.length ? <ul className="flex flex-col gap-1">{recipient.listing_clicks.map((listing) => <li key={listing.listing_id}>{listing.label}</li>)}</ul> : <span style={mutedStyle}>{recipient.tracking_pending ? "Unknown · pending" : recipient.last_synced_at ? "None observed" : "Unknown"}</span>}</TableCell>}
                <TableCell data-label="Unsubscribed" className={tableStyles.cell} style={cellStyle}>{deliveryById.get(recipient.send_id)?.events?.some((event) => event.type === "unsubscribed") ? "Recorded" : "Not recorded"}</TableCell>
              </tr>
            ))}
            {!visible.length && <tr><td colSpan={7} className="px-3.5 py-8 text-center text-[13px]" style={mutedStyle}>{recipients.length ? "No recipients match these filters." : "No retained recipients for this campaign."}</td></tr>}
          </tbody>
        </table>
      </div></div>
      <div data-table-part="footer"><Pagination page={currentPage} count={rows.length} onPage={(next) => { setPage(next); table.current?.focus({ preventScroll: true }); }} /></div>
    </CampaignCard></div>
  );
}
