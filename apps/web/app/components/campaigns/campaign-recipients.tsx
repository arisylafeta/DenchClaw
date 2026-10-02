"use client";

import tableStyles from "../ui/data-table.module.css";
import { useMemo, useRef, useState } from "react";
import type { CampaignRecipient } from "@/lib/campaigns";
import { Card, inputClass, inputStyle } from "../bulk-trades/trade-ui";
import { Input } from "../ui/input";
import { CampaignDate, Observation, PAGE_SIZE, Pagination, PersonLink, cellStyle, firstClick, humanize, mutedStyle } from "./campaign-ui";

const FILTERS = ["All", "Opened", "Clicked", "Bounced", "Tracking pending"] as const;
type RecipientFilter = typeof FILTERS[number];

export function CampaignRecipients({ recipients, onNavigatePerson }: { recipients: CampaignRecipient[]; onNavigatePerson: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RecipientFilter>("All");
  const [page, setPage] = useState(0);
  const table = useRef<HTMLTableElement>(null);
  const rows = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return recipients.filter((recipient) => {
      const matchesFilter = filter === "All"
        || (filter === "Opened" && !!recipient.opened_at)
        || (filter === "Clicked" && !!firstClick(recipient))
        || (filter === "Bounced" && (!!recipient.bounced_at || recipient.state.toLowerCase() === "bounced"))
        || (filter === "Tracking pending" && recipient.tracking_pending);
      return matchesFilter && (!term || [recipient.person_name, recipient.company_name, recipient.recipient_email, ...recipient.listing_clicks.map((listing) => listing.label)].some((value) => value?.toLocaleLowerCase().includes(term)));
    });
  }, [recipients, query, filter]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
  const visible = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <div className={`bulk-trades ${tableStyles.surface}`}><Card label="Recipient ledger">
      <div data-table-part="toolbar" className="flex flex-wrap items-center gap-2.5 border-b px-3.5 py-3" style={{ background: "var(--bt-bg)", borderColor: "var(--bt-divider)" }}>
        <Input data-table-part="search" type="search" aria-label="Search recipients" placeholder="Search name, company, email or listing" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} className={`${inputClass} h-8 max-w-sm text-[13px] shadow-none focus-visible:ring-0`} style={inputStyle} />
        <div role="group" aria-label="Recipient activity" className="flex flex-wrap rounded-none border" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
          {FILTERS.map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0); }} className="h-8 rounded-none px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bt-text)]" style={filter === value ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)" } : { color: "var(--bt-text)" }}>{value}</button>)}
        </div>
      </div>
      <div className={`bulk-trades ${tableStyles.surface} max-w-full overflow-x-auto`}>
        <table ref={table} tabIndex={-1} aria-label="Recipients" className={`${tableStyles.table} min-w-[720px] focus:outline-none`}>
          <thead style={{ background: "var(--bt-table-head)" }}>
            <tr>{["Recipient", "Delivery", "First tracked open", "First tracked click", "Clicked listings"].map((label) => <th key={label} scope="col" className={tableStyles.headerCell} style={cellStyle}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {visible.map((recipient) => (
              <tr key={recipient.send_id} className="hover:bg-[var(--bt-row-hover)]">
                <td className={`${tableStyles.cell} min-w-[220px]`} style={cellStyle}>
                  <PersonLink id={recipient.person_id} onNavigate={onNavigatePerson}>{recipient.person_name || recipient.recipient_email}</PersonLink>
                  {recipient.company_name && <div className="mt-0.5" style={mutedStyle}>{recipient.company_name}</div>}
                  {recipient.person_name && <div className="mt-0.5 break-all text-xs" style={mutedStyle}>{recipient.recipient_email}</div>}
                </td>
                <td className={tableStyles.cell} style={cellStyle}>
                  <span style={{ color: recipient.bounced_at || recipient.state.toLowerCase() === "bounced" ? "var(--bt-red)" : "var(--bt-text)" }}>{recipient.bounced_at || recipient.state.toLowerCase() === "bounced" ? "Bounced" : recipient.delivered_at ? "Delivered" : recipient.accepted_at ? "Accepted" : humanize(recipient.state)}</span>
                  {(recipient.bounced_at || recipient.delivered_at || recipient.accepted_at) && <div className="mt-0.5 text-xs" style={mutedStyle}><CampaignDate value={recipient.bounced_at || recipient.delivered_at || recipient.accepted_at} withTime /></div>}
                  {recipient.tracking_pending && <div className="mt-0.5 text-xs" style={{ color: "var(--bt-amber)" }}>Tracking pending</div>}
                </td>
                <td className={tableStyles.cell} style={cellStyle}><Observation at={recipient.opened_at} recipient={recipient} /></td>
                <td className={tableStyles.cell} style={cellStyle}><Observation at={firstClick(recipient)} recipient={recipient} /></td>
                <td className={`${tableStyles.cell} min-w-[160px]`} style={cellStyle}>
                  {recipient.listing_clicks.length ? <ul className="flex flex-col gap-1">{recipient.listing_clicks.map((listing) => <li key={listing.listing_id}>{listing.label}</li>)}</ul> : <span style={mutedStyle}>{recipient.tracking_pending ? "Unknown · pending" : recipient.last_synced_at ? "None observed" : "Unknown"}</span>}
                </td>
              </tr>
            ))}
            {!visible.length && <tr><td colSpan={5} className="px-3.5 py-8 text-center text-[13px]" style={mutedStyle}>{recipients.length ? "No recipients match these filters." : "No retained recipients for this campaign."}</td></tr>}
          </tbody>
        </table>
      </div>
      <div data-table-part="footer"><Pagination page={currentPage} count={rows.length} onPage={(next) => { setPage(next); table.current?.focus({ preventScroll: true }); }} /></div>
    </Card></div>
  );
}
