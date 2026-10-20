"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { MailFilters, MailFollowup, MailMessageListRow, MailPage } from "@/lib/mail-types";
import { WhatsappView } from "./whatsapp-view";
import { MailLine, MailLineSkeleton } from "./mail-line";
import { Loading } from "../../ui/shimmer";
import { AccountRail } from "./account-rail";
import { ConversationsView } from "./conversations-view";
import { MailDraftsView } from "./mail-drafts-view";
import { CampaignsPanel } from "../../campaigns/campaigns-view";
import { Mail, Megaphone, MessageCircle, Search, SlidersHorizontal, X } from "lucide-react";
import { formatAbsoluteDate, formatRelativeDate } from "../format-relative-date";
import styles from "./mail.module.css";
import { mailCounterparty } from "@/lib/mail-counterparty";

export type MailView = NonNullable<MailFilters["view"]>;
const views: Record<MailView, string> = { conversations: "Conversations", campaigns: "Campaigns", drafts: "Drafts", sent: "Sent", followups: "Follow-ups", whatsapp: "WhatsApp" };
// Two tab levels. Upper: Mail, WhatsApp, Campaigns. Inner (inside Mail): Conversations, Drafts, Sent. Follow-ups has no tab (still reachable by URL).
const mailViews: MailView[] = ["conversations", "drafts", "sent"];
const sections: { key: string; label: string; view: MailView; views: MailView[]; icon: typeof Mail }[] = [
  { key: "mail", label: "Mail", view: "conversations", views: [...mailViews, "followups"], icon: Mail },
  { key: "whatsapp", label: "WhatsApp", view: "whatsapp", views: ["whatsapp"], icon: MessageCircle },
  { key: "campaigns", label: "Campaigns", view: "campaigns", views: ["campaigns"], icon: Megaphone },
];
const campaignStatuses = ["sending", "sent", "launched", "completed", "retired", "legacy"];
const filterOptions: Record<string, string[]> = {
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
export function InboxView({ onOpenPerson, onOpenDraft, initialView, initialCampaignId }: { onOpenPerson?: (id: string) => void; onOpenDraft?: (id: string, title: string) => void; initialView?: MailView; initialCampaignId?: string | null }) {
  const router = useRouter();
  const params = useSearchParams();
  const requestedView = params.get("view");
  const [filters, setFilters] = useState<MailFilters>(() => ({
    ...Object.fromEntries(["q", "from", "to", "thread", "identity", "direction", "transport", "purpose", "state", "event", "campaign", "since", "until"].map((key) => [key, params.get(key) ?? ""])),
    view: initialView ?? (requestedView && requestedView in views ? requestedView as MailView : "conversations"), crmOnly: params.get("crmOnly") !== "false", ...(params.get("showInternal") === "true" ? { showInternal: true } : {}), limit: 100,
  }));
  const [campaignId, setCampaignId] = useState<string | null>(initialCampaignId ?? params.get("campaignDetail"));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [campaignStatus, setCampaignStatus] = useState("");
  const query = mailQuery(filters);
  const view = filters.view ?? "conversations";
  const section = (sections.find((entry) => entry.views.includes(view)) ?? sections[0]).key;
  useEffect(() => {
    const next = new URLSearchParams(params.toString());
    next.set("crm", "inbox");
    for (const key of ["view", "q", "from", "to", "thread", "identity", "direction", "transport", "purpose", "state", "event", "campaign", "since", "until", "crmOnly", "showInternal"]) {
      const value = new URLSearchParams(query).get(key);
      if (value !== null) {next.set(key, value);} else {next.delete(key);}
    }
    if (campaignId) {next.set("campaignDetail", campaignId);} else {next.delete("campaignDetail");}
    if (next.toString() !== params.toString()) {router.replace(`/?${next.toString()}`, { scroll: false });}
  // URL is written from this page's state, not used as a second state owner.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, campaignId, router]);
  const update = (key: string, value: string | boolean) => setFilters((current) => ({ ...current, [key]: value }));
  const activeFilters = Object.entries(filters).filter(([key, value]) => !["view", "q", "limit", "crmOnly", "showInternal"].includes(key) && value !== "" && value !== undefined);
  return <div className={`${styles.page} flex h-full min-h-0 flex-col`}>
    <header className={styles.header}>
      <h1 className="text-[26px] font-semibold tracking-[-0.01em]">Inbox</h1>
      <nav role="tablist" aria-label="Inbox sections" className={styles.tabs}>
        {sections.map(({ key, label, view: target, views: group, icon: Icon }) => <button key={key} role="tab" aria-selected={group.includes(view)} className={`${styles.tab} inline-flex items-center gap-1.5`} onClick={() => { if (!group.includes(view)) { setFilters((current) => ({ ...current, view: target, q: "", thread: "" })); setFiltersOpen(false); } }}><Icon size={14} aria-hidden />{label}</button>)}
      </nav>
    </header>
    {section === "mail" && <div role="group" aria-label="Mail filters" className={styles.toolbar}>
      <label className="relative flex min-w-48 max-w-sm flex-1 items-center">
        <Search size={14} aria-hidden className="absolute left-2.5" style={{ color: "var(--color-text-muted)" }} />
        <input aria-label="Search mail" placeholder="Search mail…" className={`${styles.control} w-full !pl-8`} type="search" value={filters.q ?? ""} onChange={(event) => update("q", event.target.value)} />
      </label>
      <button type="button" aria-expanded={filtersOpen} aria-controls="mail-filter-options" className={`${styles.control} ${styles.button}`} onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal size={14} aria-hidden />Filters{activeFilters.length > 0 && <span aria-label={`${activeFilters.length} active filters`} className="inline-flex min-w-4 items-center justify-center rounded bg-[var(--color-surface-hover)] px-1 text-[10px] font-medium">{activeFilters.length}</span>}</button>
      <label className="ml-1 flex items-center gap-1.5 text-[12px]" style={{ color: "var(--color-text-muted)" }}><input type="checkbox" className="accent-[var(--color-accent)]" checked={filters.crmOnly} onChange={(event) => update("crmOnly", event.target.checked)} />CRM-only</label>
      <label className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--color-text-muted)" }}><input type="checkbox" className="accent-[var(--color-accent)]" checked={filters.showInternal === true} onChange={(event) => setFilters((current) => { const { showInternal: _omit, ...rest } = current; return event.target.checked ? { ...rest, showInternal: true } : rest; })} />Show internal</label>
      {activeFilters.map(([key, value]) => <button key={key} className={styles.chip} aria-label={`Remove ${key} filter`} onClick={() => update(key, "")}><span className="capitalize">{key}</span>: {String(value)}<X size={11} aria-hidden /></button>)}
    </div>}
    {section === "whatsapp" && <div role="group" aria-label="WhatsApp search" className={styles.toolbar}>
      <label className="relative flex min-w-48 max-w-sm flex-1 items-center">
        <Search size={14} aria-hidden className="absolute left-2.5" style={{ color: "var(--color-text-muted)" }} />
        <input aria-label="Search chats" placeholder="Search chats…" className={`${styles.control} w-full !pl-8`} type="search" value={filters.q ?? ""} onChange={(event) => update("q", event.target.value)} />
      </label>
    </div>}
    {section === "campaigns" && <div role="group" aria-label="Campaign filters" className={styles.toolbar}>
      <label className="relative flex min-w-48 max-w-sm flex-1 items-center">
        <Search size={14} aria-hidden className="absolute left-2.5" style={{ color: "var(--color-text-muted)" }} />
        <input aria-label="Search campaigns" placeholder="Search campaigns…" className={`${styles.control} w-full !pl-8`} type="search" value={filters.q ?? ""} onChange={(event) => update("q", event.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--color-text-muted)" }}>Status
        <select aria-label="Campaign status" className={styles.control} value={campaignStatus} onChange={(event) => setCampaignStatus(event.target.value)}><option value="">All</option>{campaignStatuses.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select>
      </label>
    </div>}
    {section === "mail" && filtersOpen && <div id="mail-filter-options" className={styles.filters}>
      {Object.entries(filterOptions).map(([key, options]) => <label key={key} className={styles.filter}><span className="capitalize">{key}</span><select aria-label={key} className={styles.control} value={String(filters[key as keyof MailFilters] ?? "")} onChange={(event) => update(key, event.target.value)}><option value="">All</option>{options.map((option) => <option key={option}>{option}</option>)}</select></label>)}
      {(["campaign", "from", "to", "thread"] as const).map((key) => <label key={key} className={styles.filter}><span className="capitalize">{key}</span><input className={styles.control} value={filters[key] ?? ""} onChange={(event) => update(key, event.target.value)} /></label>)}
      {(["since", "until"] as const).map((key) => <label key={key} className={styles.filter}><span className="capitalize">{key}</span><input className={styles.control} type="date" value={filters[key] ?? ""} onChange={(event) => update(key, event.target.value)} /></label>)}
    </div>}
    <div className={styles.body}>
    {mailViews.includes(view) && <AccountRail query={query} identity={filters.identity ?? ""} showCounts={view !== "drafts"} onSelect={(value) => update("identity", value)} />}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {mailViews.includes(view) && <nav role="tablist" aria-label="Mail folders" className={styles.subtabs}>
        {mailViews.map((key) => <button key={key} role="tab" aria-selected={view === key} className={styles.subtab} onClick={() => update("view", key)}>{views[key]}</button>)}
      </nav>}
      <section role="tabpanel" aria-label={views[view]} className="min-h-0 min-w-0 flex-1 overflow-auto">
        {view === "conversations" && <ConversationsView query={query} onSearchChange={(value) => update("q", value)} onOpenPerson={onOpenPerson} />}
        {view === "campaigns" && <CampaignsPanel campaignId={campaignId} onOpenCampaign={setCampaignId} onBack={() => setCampaignId(null)} onNavigatePerson={onOpenPerson ?? (() => undefined)} search={filters.q ?? ""} status={campaignStatus} />}
        {view === "whatsapp" && <WhatsappView query={`q=${encodeURIComponent(filters.q ?? "")}`} selectedId={filters.thread || undefined} onSelect={(chat) => update("thread", chat)} onOpenPerson={onOpenPerson} />}
        {view === "drafts" && <MailDraftsView query={query} onOpenDraft={onOpenDraft} />}
        {(view === "sent" || view === "followups") && <MailLogRows view={view} query={query} />}
      </section>
    </div>
    </div>
  </div>;
}
function MailLogRows({ view, query }: { view: "sent" | "followups"; query: string }) {
  const [rows, setRows] = useState<(MailMessageListRow | MailFollowup)[]>([]);
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
      const page = await response.json() as MailPage<MailMessageListRow | MailFollowup>;
      if (!controller.signal.aborted) {setRows(page.items); setNextCursor(page.nextCursor ?? null);}
    }).catch((failure: Error) => {if (!controller.signal.aborted) {setError(failure.message);}}).finally(() => {if (!controller.signal.aborted) {setLoading(false);}});
    return () => controller.abort();
  }, [view, query]);
  async function more() {
    const snapshot = query;
    try {
      const response = await fetch(`/api/mail/messages?${query}&cursor=${encodeURIComponent(nextCursor!)}`);
      if (!response.ok) {throw new Error(`HTTP ${response.status}`);}
      const page = await response.json() as MailPage<MailMessageListRow>;
      if (latestQuery.current === snapshot) {setRows((current) => [...current, ...page.items]); setNextCursor(page.nextCursor);}
    } catch (failure) {setError(failure instanceof Error ? failure.message : "Could not load mail.");}
  }
  return <div className="text-[13px]">
    {loading && <Loading label={`Loading ${views[view].toLowerCase()}…`}>{Array.from({ length: 9 }, (_, i) => <MailLineSkeleton key={i} index={i} />)}</Loading>}
    {error && <p role="alert" className="px-8 py-6">{error}</p>}
    {!loading && !error && !rows.length && <p className="px-8 py-8" style={{ color: "var(--color-text-muted)" }}>No {views[view].toLowerCase()} match these filters.</p>}
    <ul>{rows.map((row) => {
      const counterparty = "direction" in row ? mailCounterparty(row) : null;
      return <li key={row.id} className={"direction" in row ? undefined : styles.logRow}>
      {"direction" in row ? <>
        <MailLine id={row.id} prefix={row.is_self ? "To:" : undefined} name={counterparty?.name ?? counterparty?.email ?? null} email={counterparty?.email ?? null} subject={row.subject || "(No subject)"} snippet={row.body_preview} at={row.sent_at ?? row.created_at}
          tag={<details className={styles.activity}><summary className={`${styles.chip} cursor-pointer`} aria-label={`Delivery activity: ${row.subject || "(No subject)"}`}>{row.state} · Activity</summary><div className={styles.activityPanel}><p>{(["sent", "delivered", "bounced", "opened", "clicked", "replied"] as const).map((event) => `${event}: ${row[`${event}_at`] ?? "not recorded"}`).join(" · ")}</p><p className="mt-1">Unsubscribed: {row.events?.some((event) => event.type === "unsubscribed") ? "recorded" : "not recorded"}</p></div></details>} />
        {["unknown", "sending"].includes(row.state) && <p role="status" className="px-4 pb-2 text-[12px]" style={{ color: "var(--bt-amber, #a16207)" }}>Reconcile before retrying: {row.state}</p>}
      </> : <><div className="flex items-center gap-2"><span className={styles.chip}>{row.state === "pending" && Date.parse(row.due_at) <= Date.now() ? "Due" : row.state}</span><span className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>{row.identity_key}</span><span className="ml-auto text-[12px]" title={formatAbsoluteDate(row.due_at)}>Due {formatRelativeDate(row.due_at)}</span></div><p className="mt-2 truncate text-[14px]">{row.note}</p>{row.paused_reason && <p className="mt-1 text-[12px]" style={{ color: "var(--color-text-muted)" }}>Paused: {row.paused_reason}</p>}</>}
    </li>;})}</ul>
    {nextCursor && <button onClick={() => void more()} className={`${styles.control} m-4`}>Load more</button>}
  </div>;
}
