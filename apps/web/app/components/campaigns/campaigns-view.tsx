"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { CampaignSummary } from "@/lib/campaigns";
import type { MailCampaignDetail, MailCampaignSummary } from "@/lib/mail-types";
import { buildEntryLink, buildFileLink } from "@/lib/workspace-links";
import { ErrorText, buttonClass, buttonStyle, inputClass, inputStyle, request } from "../bulk-trades/trade-ui";
import { Input } from "../ui/input";
import { Loading } from "../ui/shimmer";
import { InboxLayout, PANEL_LAYOUT } from "../crm/inbox/inbox-layout";
import { CampaignPage } from "./campaign-page";
import { CampaignDate, MetricRow, PAGE_SIZE, Pagination, StatusTag, followInApp, humanize, mutedStyle } from "./campaign-ui";

export type CampaignsViewProps = {
  campaignId: string | null;
  onOpenCampaign: (id: string) => void;
  onBack: () => void;
  onNavigatePerson: (id: string) => void;
  query?: string;
  embedded?: boolean;
  /** When set, the host toolbar owns search and status; the list shows no search box of its own. */
  search?: string;
  status?: string;
};

type Payload = { kind: "list"; campaigns: (CampaignSummary & MailCampaignSummary)[] } | { kind: "detail"; detail: MailCampaignDetail };
type Resource = { key: string; payload: Payload | null; error: string | null };

export function CampaignsView({ campaignId, onOpenCampaign, onBack, onNavigatePerson, query = "", embedded = false, search, status = "" }: CampaignsViewProps) {
  const key = campaignId == null ? `list:${query}` : `campaign:${campaignId}:${query}`;
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState<Resource>({ key, payload: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setResource({ key, payload: null, error: null });
    async function load() {
      try {
        const payload: Payload = campaignId == null
          ? { kind: "list", campaigns: (await request<{ items: (CampaignSummary & MailCampaignSummary)[] }>(`/api/mail/campaigns${query ? `?${query}` : ""}`, { signal: controller.signal })).items }
          : { kind: "detail", detail: await request<MailCampaignDetail>(`/api/mail/campaigns/${encodeURIComponent(campaignId)}${query ? `?${query}` : ""}`, { signal: controller.signal }) };
        if (!controller.signal.aborted) { setResource({ key, payload, error: null }); }
      } catch (error) {
        if (!controller.signal.aborted) { setResource({ key, payload: null, error: error instanceof Error ? error.message : "Could not load campaigns." }); }
      }
    }
    void load();
    return () => controller.abort();
  }, [campaignId, key, attempt, query]);

  const current = resource.key === key ? resource : null;
  return (
    <div className="bulk-trades flex h-full min-h-0 min-w-0 flex-col overflow-auto">
      {current?.payload?.kind === "detail" ? <CampaignPage key={campaignId} detail={current.payload.detail} onBack={onBack} onNavigatePerson={onNavigatePerson} /> : (
        <>
          {!embedded && <header className="flex flex-col gap-2.5 border-b px-4 pb-5 pt-5 sm:px-8" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            {campaignId != null && <a href={buildFileLink("campaign")} onClick={(event) => followInApp(event, onBack)} className="inline-flex self-start items-center gap-1.5 text-[13px] hover:underline" style={mutedStyle}><ArrowLeft size={14} aria-hidden="true" />Back to Campaigns</a>}
            <h1 className="text-[26px] font-semibold tracking-[-0.01em]">Campaigns</h1>
          </header>}
          <main className="min-w-0 flex-1 pb-8 pt-6">
            {current?.error ? <div className="flex flex-col items-start gap-3 px-4 sm:px-8"><ErrorText error={current.error} /><button type="button" onClick={() => setAttempt((value) => value + 1)} className={buttonClass} style={buttonStyle}>Retry</button></div>
              : current?.payload?.kind === "list" ? <CampaignsList campaigns={current.payload.campaigns} onOpenCampaign={onOpenCampaign} search={search} status={status} />
              : <Loading label={`Loading ${campaignId == null ? "campaigns" : "campaign"}…`} variant={campaignId == null ? "cards" : "detail"} />}
          </main>
        </>
      )}
    </div>
  );
}

function CampaignsList({ campaigns, onOpenCampaign, search, status, compact = false, selectedId = null }: { campaigns: (CampaignSummary & MailCampaignSummary)[]; onOpenCampaign: (id: string) => void; search?: string; status: string; compact?: boolean; selectedId?: string | null }) {
  const [localQuery, setLocalQuery] = useState("");
  const [page, setPage] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const term = (search ?? localQuery).trim().toLocaleLowerCase();
  const rows = campaigns.filter((campaign) => (!status || (campaign.mail_state ?? campaign.status) === status)
    && (!term || [campaign.name, campaign.audience, campaign.status, campaign.mail_state].some((value) => value?.toLocaleLowerCase().replace(/[_-]+/g, " ").includes(term))));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));

  if (!campaigns.length) { return <p className="px-4 py-8 text-[13px] sm:px-8" style={mutedStyle}>No campaigns are recorded yet.</p>; }
  return (
    <section aria-label="Campaign list" className="bulk-trades">
      {search === undefined && <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-4 sm:px-8">
        <Input type="search" aria-label="Search campaigns" placeholder="Search campaign, audience or status" value={localQuery} onChange={(event) => { setLocalQuery(event.target.value); setPage(0); }} className={`${inputClass} h-8 max-w-sm text-[13px] shadow-none focus-visible:ring-0`} style={inputStyle} />
      </div>}
      <p className="px-4 pb-2 text-[12px] sm:px-8" style={mutedStyle} aria-live="polite">{rows.length === campaigns.length ? `${campaigns.length} ${campaigns.length === 1 ? "campaign" : "campaigns"}` : `${rows.length} of ${campaigns.length} campaigns`}</p>
      <ul ref={list} aria-label="Campaigns" className="border-y" style={{ borderColor: "var(--bt-divider)" }}>
        {rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((campaign) => <li key={campaign.id} aria-current={selectedId === campaign.id ? "true" : undefined} className={`flex flex-col gap-2.5 border-b px-4 py-3.5 last:border-b-0 hover:bg-[var(--bt-row-hover)] ${compact ? "" : "sm:px-8"} ${compact ? "cursor-pointer" : ""}`} style={{ borderColor: "var(--bt-divider)", background: selectedId === campaign.id ? "color-mix(in srgb, var(--color-accent-fill) 14%, transparent)" : undefined, boxShadow: selectedId === campaign.id ? "inset 3px 0 0 var(--color-accent)" : undefined }} onClick={compact ? () => onOpenCampaign(campaign.id) : undefined}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <a href={buildEntryLink("campaign", campaign.id)} onClick={(event) => followInApp(event, () => onOpenCampaign(campaign.id))} className="min-w-0 max-w-full truncate text-[15px] font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]">{campaign.name}</a>
            <span className="text-[12px]" style={mutedStyle}><CampaignDate value={campaign.launched_at || campaign.last_invite_at} /> · {humanize(campaign.audience)} · {campaign.recipient_count.toLocaleString("en-GB")} deliveries</span>
            {campaign.tracking_pending > 0 && <span className="text-[12px]" style={{ color: "var(--bt-amber)" }}>{campaign.tracking_pending} tracking pending</span>}
            <span className="ml-auto"><StatusTag status={campaign.mail_state ?? campaign.status} /></span>
          </div>
          <MetricRow counts={campaign} compact={compact} />
        </li>)}
        {!rows.length && <li className="px-4 py-8 text-center text-[13px]" style={mutedStyle}>No campaigns match your filters.</li>}
      </ul>
      <Pagination page={currentPage} count={rows.length} onPage={(next) => { setPage(next); list.current?.focus({ preventScroll: true }); }} />
    </section>
  );
}

/** Campaigns as a panel, like mail: the list stays on the left and the open campaign fills the right pane. */
export function CampaignsPanel({ campaignId, onOpenCampaign, onBack, onNavigatePerson, search = "", status = "" }: Omit<CampaignsViewProps, "query" | "embedded">) {
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<{ campaigns: (CampaignSummary & MailCampaignSummary)[] | null; error: string | null }>({ campaigns: null, error: null });
  const [detail, setDetail] = useState<{ id: string; value: MailCampaignDetail | null; error: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request<{ items: (CampaignSummary & MailCampaignSummary)[] }>("/api/mail/campaigns", { signal: controller.signal })
      .then((body) => { if (!controller.signal.aborted) { setList({ campaigns: body.items, error: null }); } })
      .catch((error) => { if (!controller.signal.aborted) { setList({ campaigns: null, error: error instanceof Error ? error.message : "Could not load campaigns." }); } });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    if (!campaignId) { setDetail(null); return; }
    const controller = new AbortController();
    setDetail({ id: campaignId, value: null, error: null });
    request<MailCampaignDetail>(`/api/mail/campaigns/${encodeURIComponent(campaignId)}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) { setDetail({ id: campaignId, value, error: null }); } })
      .catch((error) => { if (!controller.signal.aborted) { setDetail({ id: campaignId, value: null, error: error instanceof Error ? error.message : "Could not load campaign." }); } });
    return () => controller.abort();
  }, [campaignId, attempt]);
  const retry = <button type="button" onClick={() => setAttempt((value) => value + 1)} className={buttonClass} style={buttonStyle}>Retry</button>;
  return <InboxLayout {...PANEL_LAYOUT} hasSelection={campaignId != null}
    list={<div className="bulk-trades h-full min-h-0 overflow-y-auto pt-3" style={{ background: "var(--color-bg)" }}>
      {list.error ? <div className="flex flex-col items-start gap-3 px-4"><ErrorText error={list.error} />{retry}</div>
        : list.campaigns ? <CampaignsList compact campaigns={list.campaigns} selectedId={campaignId} onOpenCampaign={onOpenCampaign} search={search} status={status} />
        : <Loading label="Loading campaigns…" variant="cards" />}
    </div>}
    conversation={campaignId == null
      ? <div className="flex h-full flex-col items-center justify-center gap-1.5 px-8 text-center" style={{ background: "var(--color-main-bg)" }}><span className="text-lg font-medium">Pick a campaign</span><span className="max-w-xs text-[13px]" style={mutedStyle}>Open a campaign to see its delivery, engagement and recipients here.</span></div>
      : detail?.error ? <div className="flex flex-col items-start gap-3 p-6"><ErrorText error={detail.error} />{retry}</div>
      : detail?.value && detail.id === campaignId ? <div className="bulk-trades flex h-full min-h-0 min-w-0 flex-col"><CampaignPage key={campaignId} detail={detail.value} onBack={onBack} onNavigatePerson={onNavigatePerson} /></div>
      : <Loading label="Loading campaign…" variant="detail" />} />;
}
