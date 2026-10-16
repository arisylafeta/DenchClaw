"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { MailFilters, MailFollowup, MailMessageRow, MailPage } from "@/lib/mail-types";
import { ConversationsView } from "./conversations-view";
import { CampaignsView } from "../../campaigns/campaigns-view";

export type MailView = NonNullable<MailFilters["view"]>;
const views: Record<MailView, string> = { conversations: "Conversations", campaigns: "Campaigns", sent: "Sent", followups: "Follow-ups" };
const filterOptions: Record<string, string[]> = {
  identity: ["alex", "ari", "supply", "hello", "support", "enterprise"],
  direction: ["inbound", "outbound"], transport: ["gmail", "postmark-broadcast", "postmark-transactional"],
  purpose: ["personal", "marketing", "transactional"], state: ["draft", "frozen", "approved", "sending", "unknown", "accepted", "failed", "received"],
  event: ["opened", "clicked", "replied", "bounced"],
};
export function mailQuery(filters: MailFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "" && key !== "mailboxOwnerId") {params.set(key, String(value));}
  }
  return params.toString();
}
export function InboxView({ onOpenPerson, initialView, initialCampaignId }: { onOpenPerson?: (id: string) => void; initialView?: MailView; initialCampaignId?: string | null }) {
  const router = useRouter();
  const params = useSearchParams();
  const requestedView = params.get("view");
  const [filters, setFilters] = useState<MailFilters>(() => ({
    ...Object.fromEntries(["q", "from", "to", "thread", "identity", "direction", "transport", "purpose", "state", "event", "campaign", "since", "until"].map((key) => [key, params.get(key) ?? ""])),
    view: initialView ?? (requestedView && requestedView in views ? requestedView as MailView : "conversations"), crmOnly: params.get("crmOnly") !== "false", limit: 100,
  }));
  const [campaignId, setCampaignId] = useState<string | null>(initialCampaignId ?? params.get("campaignDetail"));
  const query = mailQuery(filters);
  const view = filters.view ?? "conversations";
  useEffect(() => {
    const next = new URLSearchParams(params.toString());
    next.set("crm", "inbox");
    for (const key of ["view", "q", "from", "to", "thread", "identity", "direction", "transport", "purpose", "state", "event", "campaign", "since", "until", "crmOnly"]) {
      const value = new URLSearchParams(query).get(key);
      if (value !== null) {next.set(key, value);} else {next.delete(key);}
    }
    if (campaignId) {next.set("campaignDetail", campaignId);} else {next.delete("campaignDetail");}
    router.replace(`/?${next.toString()}`, { scroll: false });
  // URL is written from this page's state, not used as a second state owner.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, campaignId, router]);
  const update = (key: string, value: string | boolean) => setFilters((current) => ({ ...current, [key]: value }));
  return <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-bg)", color: "var(--color-text)" }}>
    <header className="border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
      <h1 className="mb-3 text-xl font-semibold">Mail</h1>
      <nav role="tablist" aria-label="Mail views" className="flex flex-wrap gap-2">
        {(Object.entries(views) as [MailView, string][]).map(([key, label]) => <button key={key} role="tab" aria-selected={view === key} className={`rounded px-3 py-2 text-sm ${view === key ? "bg-[var(--color-surface-hover)] font-semibold" : ""}`} onClick={() => update("view", key)}>{label}</button>)}
      </nav>
      <div role="group" aria-label="Mail filters" className="mt-3 flex flex-wrap items-end gap-2 text-xs">
        <label>Search<input className="ml-2 rounded border p-1" type="search" value={filters.q ?? ""} onChange={(event) => update("q", event.target.value)} /></label>
        {Object.entries(filterOptions).map(([key, options]) => <label key={key} className="capitalize">{key}<select aria-label={key} className="ml-1 rounded border p-1" value={String(filters[key as keyof MailFilters] ?? "")} onChange={(event) => update(key, event.target.value)}><option value="">All</option>{options.map((option) => <option key={option}>{option}</option>)}</select></label>)}
        <label>Campaign<input className="ml-1 w-28 rounded border p-1" value={filters.campaign ?? ""} onChange={(event) => update("campaign", event.target.value)} /></label>
        {(["from", "to", "thread"] as const).map((key) => <label key={key} className="capitalize">{key}<input className="ml-1 w-28 rounded border p-1" value={filters[key] ?? ""} onChange={(event) => update(key, event.target.value)} /></label>)}
        <label>Since<input className="ml-1 rounded border p-1" type="date" value={filters.since ?? ""} onChange={(event) => update("since", event.target.value)} /></label>
        <label>Until<input className="ml-1 rounded border p-1" type="date" value={filters.until ?? ""} onChange={(event) => update("until", event.target.value)} /></label>
        <label className="flex gap-1"><input type="checkbox" checked={filters.crmOnly} onChange={(event) => update("crmOnly", event.target.checked)} />CRM-only</label>
      </div>
    </header>
    <section role="tabpanel" aria-label={views[view]} className="min-h-0 flex-1 overflow-auto">
      {view === "conversations" && <ConversationsView query={query} onSearchChange={(value) => update("q", value)} onOpenPerson={onOpenPerson} />}
      {view === "campaigns" && <CampaignsView campaignId={campaignId} onOpenCampaign={setCampaignId} onBack={() => setCampaignId(null)} onNavigatePerson={onOpenPerson ?? (() => undefined)} query={query} />}
      {(view === "sent" || view === "followups") && <MailLogRows view={view} query={query} />}
    </section>
  </div>;
}
function MailLogRows({ view, query }: { view: "sent" | "followups"; query: string }) {
  const [rows, setRows] = useState<(MailMessageRow | MailFollowup)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const latestQuery = useRef(query);
  useEffect(() => {
    latestQuery.current = query;
    const controller = new AbortController();
    setRows([]); setError(null); setLoading(true); setNextCursor(null);
    const endpoint = view === "followups" ? "followups" : "messages";
    void fetch(`/api/mail/${endpoint}?${query}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) {throw new Error(`HTTP ${response.status}`);}
      const page = await response.json() as MailPage<MailMessageRow | MailFollowup>;
      if (!controller.signal.aborted) {setRows(page.items); setNextCursor(page.nextCursor ?? null);}
    }).catch((failure: Error) => {if (!controller.signal.aborted) {setError(failure.message);}}).finally(() => {if (!controller.signal.aborted) {setLoading(false);}});
    return () => controller.abort();
  }, [view, query]);
  async function more() {
    const snapshot = query;
    try {
      const response = await fetch(`/api/mail/messages?${query}&cursor=${encodeURIComponent(nextCursor!)}`);
      if (!response.ok) {throw new Error(`HTTP ${response.status}`);}
      const page = await response.json() as MailPage<MailMessageRow>;
      if (latestQuery.current === snapshot) {setRows((current) => [...current, ...page.items]); setNextCursor(page.nextCursor);}
    } catch (failure) {setError(failure instanceof Error ? failure.message : "Could not load mail.");}
  }
  return <div className="p-4 text-sm">
    {loading && <p role="status">Loading {views[view].toLowerCase()}…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && !rows.length && <p>No {views[view].toLowerCase()} match these filters.</p>}
    <ul className="space-y-3">{rows.map((row) => <li key={row.id} className="rounded border p-3" style={{ borderColor: "var(--color-border)" }}>
      {"direction" in row ? <>
        <div className="font-semibold">{row.subject || "(No subject)"}</div><p>{row.identity_key} → {row.recipient_email ?? row.to_emails.join(", ")}</p>
        <p>{row.state}{["unknown", "sending"].includes(row.state) && <strong role="status" className="ml-2 text-amber-700">Reconcile before retrying: {row.state}</strong>}</p>
        <p>{["sent", "delivered", "bounced", "opened", "clicked", "replied"].map((event) => `${event}: ${row[`${event}_at` as keyof MailMessageRow] ?? "not recorded"}`).join(" · ")}</p>
        <p>Unsubscribed: {row.events?.some((event) => event.type === "unsubscribed") ? "recorded" : "not recorded"}</p>
      </> : <><strong>{row.state === "pending" && Date.parse(row.due_at) <= Date.now() ? "Due" : row.state}</strong><p>Due: {new Date(row.due_at).toLocaleString("en-GB")} · {row.identity_key}</p><p>{row.note}</p>{row.paused_reason && <p>Paused: {row.paused_reason}</p>}</>}
    </li>)}</ul>
    {nextCursor && <button onClick={() => void more()} className="mt-4 rounded border px-3 py-2">Load more</button>}
  </div>;
}
