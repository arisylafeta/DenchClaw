"use client";

import type { MouseEvent, ReactNode } from "react";
import type { CampaignRecipient, CampaignSummary } from "@/lib/campaigns";
import { buildEntryLink } from "@/lib/workspace-links";
import { buttonClass, buttonStyle } from "../bulk-trades/trade-ui";

export const PAGE_SIZE = 25;
export const mutedStyle = { color: "var(--bt-muted)" };
export const borderStyle = { borderColor: "var(--bt-border)" };
export const cellStyle = { borderColor: "var(--bt-divider)" };

export function humanize(value: string | null): string {
  if (!value) { return "Unknown"; }
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

export function CampaignDate({ value, withTime = false }: { value: string | null; withTime?: boolean }) {
  if (!value || !Number.isFinite(Date.parse(value))) { return <span>Unknown</span>; }
  const date = new Date(value);
  return <time dateTime={value} title={`${timeFormat.format(date)} (London)`} className="whitespace-nowrap">{(withTime ? timeFormat : dateFormat).format(date)}</time>;
}

export function followInApp(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) { return; }
  event.preventDefault();
  navigate();
}

export function PersonLink({ id, children, onNavigate }: { id: string; children: ReactNode; onNavigate: (id: string) => void }) {
  return <a href={buildEntryLink("people", id)} onClick={(event) => followInApp(event, () => onNavigate(id))} className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]" style={{ color: "var(--bt-link)" }}>{children}</a>;
}

export function StatusTag({ status }: { status: string }) {
  return <span className="inline-flex rounded-none border px-2 py-0.5 text-xs font-medium" style={{ background: "var(--bt-bg)", borderColor: "var(--bt-border)", color: "var(--bt-text-2)" }}>{humanize(status)}</span>;
}

export function MetricsStrip({ campaign }: { campaign: CampaignSummary }) {
  const cells = [["Sent", campaign.metrics.sent], ["Delivered", campaign.metrics.delivered], ["Tracked opens", campaign.metrics.opened], ["Tracked clicks", campaign.metrics.clicked]] as const;
  return (
    <section aria-label="Campaign metrics" className="grid grid-cols-2 rounded-none border sm:grid-cols-4" style={borderStyle}>
      {cells.map(([label, value], index) => (
        <div key={label} className="flex flex-col gap-1 border-r px-3.5 py-2.5 last:border-r-0" style={{ borderColor: "var(--bt-divider)", background: index === 0 ? "var(--bt-bg)" : "var(--bt-surface)" }}>
          <span className="bt-label">{label}</span>
          <span className="bt-mono text-[22px] font-semibold">{value == null ? "Unknown" : value.toLocaleString("en-GB")}</span>
          {value == null && campaign.metrics_basis === "ledger" && campaign.tracking_pending > 0 && <span className="text-xs" style={mutedStyle}>Tracking pending</span>}
        </div>
      ))}
    </section>
  );
}

export function Observation({ at, recipient }: { at: string | null; recipient: CampaignRecipient }) {
  if (at) { return <CampaignDate value={at} withTime />; }
  if (recipient.tracking_pending) { return <span style={mutedStyle}>Unknown · pending</span>; }
  return <span style={mutedStyle}>{recipient.last_synced_at ? "Not observed" : "Unknown"}</span>;
}

export function firstClick(recipient: CampaignRecipient): string | null {
  return recipient.listing_clicks.reduce<string | null>((first, click) => !first || click.first_clicked_at < first ? click.first_clicked_at : first, recipient.clicked_at);
}

export function Pagination({ page, count, onPage }: { page: number; count: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 border-t px-3.5 py-3 text-[13px]" style={borderStyle}>
      <span aria-live="polite" style={mutedStyle}>{count ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, count)} of ${count}` : "0 results"}</span>
      <div className="flex items-center gap-2">
        <button type="button" className={buttonClass} style={buttonStyle} disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
        <span style={mutedStyle}>Page {page + 1} of {pages}</span>
        <button type="button" className={buttonClass} style={buttonStyle} disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </nav>
  );
}
