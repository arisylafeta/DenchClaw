"use client";

import type { MouseEvent, ReactNode } from "react";
import type { CampaignRecipient } from "@/lib/campaigns";
import { buildEntryLink } from "@/lib/workspace-links";
import { buttonClass, buttonStyle } from "../bulk-trades/trade-ui";
import { LoaderCircle } from "lucide-react";
import styles from "./campaign-surface.module.css";

export function CampaignLoading({ label = "Loading…" }: { label?: string }) {
  return <div role="status" aria-busy="true" className="flex min-h-32 items-center justify-center gap-2 py-8 text-[12px]" style={mutedStyle}><LoaderCircle size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{label}</div>;
}

/** Soft campaign surface using the Trades Preview palette. */
export function CampaignCard({ children, label }: { children: ReactNode; label?: string }) {
  return <section aria-label={label} className={styles.card}>{children}</section>;
}

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
  event.stopPropagation();
  navigate();
}

export function PersonLink({ id, children, onNavigate }: { id: string; children: ReactNode; onNavigate: (id: string) => void }) {
  return <a href={buildEntryLink("people", id)} onClick={(event) => followInApp(event, () => onNavigate(id))} className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]" style={{ color: "var(--bt-link)" }}>{children}</a>;
}

const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  sent: { bg: "color-mix(in srgb, var(--color-accent-fill) 35%, transparent)", fg: "var(--bt-text)" },
  sending: { bg: "var(--bt-amber-bg)", fg: "var(--bt-amber)" },
  scheduled: { bg: "var(--bt-amber-bg)", fg: "var(--bt-amber)" },
  failed: { bg: "color-mix(in srgb, var(--bt-red) 12%, transparent)", fg: "var(--bt-red)" },
};
export function StatusTag({ status }: { status: string }) {
  const tone = STATUS_TONE[status.toLowerCase()];
  return <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ background: tone?.bg ?? "var(--bt-bg)", borderColor: "var(--bt-border)", color: tone?.fg ?? "var(--bt-text-2)" }}>{humanize(status)}</span>;
}

type Counts = { sent: number | null; delivered: number | null; bounced: number | null; opened: number | null; clicked: number | null; unsubscribed: number | null; replied: number | null };
export const METRIC_KEYS = ["sent", "delivered", "opened", "clicked", "replied", "bounced", "unsubscribed"] as const;
/** Delivery and bounce are shares of sent; opens, clicks, replies and unsubscribes are shares of delivered. No denominator renders as no rate, never 0%. */
export function metricRate(counts: Counts, key: typeof METRIC_KEYS[number]): string | null {
  if (key === "sent") { return null; }
  const value = counts[key]; const base = key === "delivered" || key === "bounced" ? counts.sent : counts.delivered;
  if (value == null || !base) { return null; }
  return `${new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((100 * value) / base)}%`;
}

/** One compact strip of the seven mail-log metrics with counts and rates. Columns reflow to the width, so it never scrolls sideways. `loading` shows one quiet status. */
export function MetricRow({ counts, notTracked = [], size = "sm", compact = false, loading = false }: { counts?: Counts; notTracked?: readonly string[]; size?: "sm" | "lg"; compact?: boolean; loading?: boolean }) {
  const lg = size === "lg";
  if (loading) { return <CampaignLoading />; }
  return <dl className="grid gap-x-4 gap-y-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${compact ? 64 : lg ? 84 : 72}px, 1fr))` }}>
    {METRIC_KEYS.map((key) => {
      const value = counts?.[key]; const rate = counts ? metricRate(counts, key) : null;
      return <div key={key} className="flex min-w-0 flex-col">
        <dt className="order-2 text-[12px] leading-5" style={mutedStyle}>{humanize(key)}</dt>
        <dd className={`font-semibold tabular-nums ${lg ? "h-8 text-[22px] leading-8" : "h-6 text-[15px] leading-6"}`}>
          {notTracked.includes(key) ? <span title="Not tracked" style={mutedStyle}>—<span className="sr-only">Not tracked</span></span>
            : value == null ? (lg ? "Unknown" : "—") : value.toLocaleString("en-GB")}
        </dd>
        <dd className="order-3 text-[11px] leading-4 tabular-nums" style={mutedStyle}>{rate ?? "\u00a0"}</dd>
      </div>;
    })}
  </dl>;
}

export function Observation({ at, recipient }: { at: string | null; recipient: CampaignRecipient }) {
  if (at) { return <CampaignDate value={at} withTime />; }
  if (!recipient.tracked) { return <span style={mutedStyle}>Not tracked</span>; }
  if (recipient.tracking_pending) { return <span style={mutedStyle}>Unknown · pending</span>; }
  return <span style={mutedStyle}>{recipient.last_synced_at ? "Not observed" : "Unknown"}</span>;
}

export function firstClick(recipient: CampaignRecipient): string | null {
  return recipient.listing_clicks.reduce<string | null>((first, click) => !first || click.first_clicked_at < first ? click.first_clicked_at : first, recipient.clicked_at);
}

export function Pagination({ page, count, onPage }: { page: number; count: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-3 text-[13px]" style={borderStyle}>
      <span aria-live="polite" style={mutedStyle}>{count ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, count)} of ${count}` : "0 results"}</span>
      <div className="flex items-center gap-2">
        <button type="button" className={`${buttonClass} rounded-lg`} style={buttonStyle} disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
        <span style={mutedStyle}>Page {page + 1} of {pages}</span>
        <button type="button" className={`${buttonClass} rounded-lg`} style={buttonStyle} disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </nav>
  );
}

const PIN_COLORS = ["#2f9e44", "#1c7ed6", "#e8590c", "#ae3ec9", "#0c8599", "#d6336c", "#5c7cfa", "#f08c00", "#099268"];
/** A stable colour per campaign so it can be spotted at a glance in a list. */
export function campaignColor(id: string) {
  return PIN_COLORS[Array.from(id).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PIN_COLORS.length];
}
export function CampaignPin({ id, size = 10 }: { id: string; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: campaignColor(id) }} />;
}

export const LIST_METRICS = ["sent", "opened", "replied"] as const;
