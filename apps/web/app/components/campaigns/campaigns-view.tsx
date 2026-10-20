"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { CampaignSummary } from "@/lib/campaigns";
import type { MailCampaignDetail, MailCampaignSummary } from "@/lib/mail-types";
import { buildEntryLink, buildFileLink } from "@/lib/workspace-links";
import { ErrorText, buttonClass, buttonStyle, inputClass, inputStyle, request } from "../bulk-trades/trade-ui";
import { Input } from "../ui/input";
import { Loading, ShimmerBar } from "../ui/shimmer";
import { InboxLayout, PANEL_LAYOUT } from "../crm/inbox/inbox-layout";
import { CampaignPage, CampaignPageSkeleton } from "./campaign-page";
import { CampaignDate, CampaignPin, LIST_METRICS, PAGE_SIZE, Pagination, StatusTag, followInApp, humanize, metricRate, mutedStyle } from "./campaign-ui";

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
              : campaignId == null ? <CampaignListSkeleton /> : <CampaignPageSkeleton />}
          </main>
        </>
      )}
    </div>
  );
}

/** Same row as a campaign: pin, title, three metrics, status pill, date, with the same height and divider. */
function CampaignRowSkeleton({ compact, index, single }: { compact: boolean; index: number; single: boolean }) {
  const widths = ["52%", "64%", "40%", "58%"];
  return <li aria-hidden className={`flex min-h-[52px] items-center gap-3 border-b px-4 py-3 last:border-b-0 ${compact ? "" : "sm:px-8"}`} style={{ borderColor: "var(--bt-divider)" }}>
    <ShimmerBar w={10} h={10} round />
    <span className="min-w-0 flex-1"><ShimmerBar w={widths[index % widths.length]} h={14} /></span>
    <span className={`flex shrink-0 items-center ${compact ? "gap-3" : "gap-4"}`}>{Array.from({ length: single ? 1 : 3 }, (_, i) => <ShimmerBar key={i} w={compact ? 22 : 56} h={12} />)}</span>
    <ShimmerBar w={64} h={22} round />
    <ShimmerBar w={compact ? 68 : 84} h={12} className="shrink-0" />
  </li>;
}
export function CampaignListSkeleton({ compact = false, single = false, rows = 8 }: { compact?: boolean; single?: boolean; rows?: number }) {
  return <Loading label="Loading campaigns…"><ul className="border-y" style={{ borderColor: "var(--bt-divider)" }}>{Array.from({ length: rows }, (_, i) => <CampaignRowSkeleton key={i} index={i} compact={compact} single={single} />)}</ul></Loading>;
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
        {rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((campaign) => {
          const selected = selectedId === campaign.id;
          return <li key={campaign.id} aria-current={selected ? "true" : undefined} className={`flex min-h-[52px] items-center gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-[var(--bt-row-hover)] ${compact ? "cursor-pointer" : "sm:px-8"}`}
            style={{ borderColor: "var(--bt-divider)", background: selected ? "color-mix(in srgb, var(--color-accent-fill) 14%, transparent)" : undefined, boxShadow: selected ? "inset 3px 0 0 var(--color-accent)" : undefined }} onClick={compact ? () => onOpenCampaign(campaign.id) : undefined}>
            <CampaignPin id={campaign.id} />
            <a href={buildEntryLink("campaign", campaign.id)} onClick={(event) => followInApp(event, () => onOpenCampaign(campaign.id))} className="min-w-0 flex-1 truncate text-[14px] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]">{campaign.name}</a>
            <dl className={`flex shrink-0 items-center text-[12px] ${compact ? "gap-3" : "gap-4"}`}>
              {(selectedId ? LIST_METRICS.slice(0, 1) : LIST_METRICS).map((key) => <div key={key} className="flex items-baseline gap-1" title={metricRate(campaign, key) ? `${humanize(key)} ${metricRate(campaign, key)}` : humanize(key)}>
                <dd className="bt-mono font-semibold tabular-nums">{campaign[key] == null ? "—" : campaign[key]!.toLocaleString("en-GB")}</dd>
                {!compact && <dt style={mutedStyle}>{humanize(key)}</dt>}
              </div>)}
            </dl>
            <StatusTag status={campaign.mail_state ?? campaign.status} />
            <span className={`shrink-0 text-right text-[12px] ${compact ? "w-[68px]" : "w-[84px]"}`} style={mutedStyle}><CampaignDate value={campaign.launched_at || campaign.last_invite_at} /></span>
          </li>;
        })}
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
  // Nothing open: the list takes the whole screen, with no empty detail pane beside it.
  if (campaignId == null) {
    return <div className="bulk-trades h-full min-h-0 overflow-y-auto pt-3" style={{ background: "var(--color-bg)" }}>
      {list.error ? <div className="flex flex-col items-start gap-3 px-4"><ErrorText error={list.error} />{retry}</div>
        : list.campaigns ? <CampaignsList campaigns={list.campaigns} onOpenCampaign={onOpenCampaign} search={search} status={status} />
        : <CampaignListSkeleton />}
    </div>;
  }
  return <InboxLayout {...PANEL_LAYOUT} defaultWidth={520} minWidth={360} storageKey="denchclaw.crm-inbox.campaigns-width" hasSelection={campaignId != null}
    list={<div className="bulk-trades h-full min-h-0 overflow-y-auto pt-3" style={{ background: "var(--color-bg)" }}>
      {list.error ? <div className="flex flex-col items-start gap-3 px-4"><ErrorText error={list.error} />{retry}</div>
        : list.campaigns ? <CampaignsList compact campaigns={list.campaigns} selectedId={campaignId} onOpenCampaign={onOpenCampaign} search={search} status={status} />
        : <CampaignListSkeleton compact single={campaignId != null} />}
    </div>}
    conversation={detail?.error ? <div className="flex flex-col items-start gap-3 p-6"><ErrorText error={detail.error} />{retry}</div>
      : detail?.value && detail.id === campaignId ? <div className="bulk-trades flex h-full min-h-0 min-w-0 flex-col"><CampaignPage key={campaignId} detail={detail.value} onBack={onBack} onNavigatePerson={onNavigatePerson} /></div>
      : <CampaignPageSkeleton />} />;
}
