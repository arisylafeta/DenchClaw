"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { CampaignDetail, CampaignSummary } from "@/lib/campaigns";
import { buildEntryLink, buildFileLink } from "@/lib/workspace-links";
import { Card, ErrorText, buttonClass, buttonStyle, inputClass, inputStyle, request } from "../bulk-trades/trade-ui";
import { Input } from "../ui/input";
import { CampaignPage } from "./campaign-page";
import { CampaignDate, PAGE_SIZE, Pagination, StatusTag, cellClass, cellStyle, followInApp, humanize, mutedStyle } from "./campaign-ui";

export type CampaignsViewProps = {
  campaignId: string | null;
  onOpenCampaign: (id: string) => void;
  onBack: () => void;
  onNavigatePerson: (id: string) => void;
};

type Payload = { kind: "list"; campaigns: CampaignSummary[] } | { kind: "detail"; detail: CampaignDetail };
type Resource = { key: string; payload: Payload | null; error: string | null };

export function CampaignsView({ campaignId, onOpenCampaign, onBack, onNavigatePerson }: CampaignsViewProps) {
  const key = campaignId == null ? "list" : `campaign:${campaignId}`;
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState<Resource>({ key, payload: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setResource({ key, payload: null, error: null });
    async function load() {
      try {
        const payload: Payload = campaignId == null
          ? { kind: "list", campaigns: (await request<{ campaigns: CampaignSummary[] }>("/api/campaigns", { signal: controller.signal })).campaigns }
          : { kind: "detail", detail: await request<CampaignDetail>(`/api/campaigns/${encodeURIComponent(campaignId)}`, { signal: controller.signal }) };
        if (!controller.signal.aborted) { setResource({ key, payload, error: null }); }
      } catch (error) {
        if (!controller.signal.aborted) { setResource({ key, payload: null, error: error instanceof Error ? error.message : "Could not load campaigns." }); }
      }
    }
    void load();
    return () => controller.abort();
  }, [campaignId, key, attempt]);

  const current = resource.key === key ? resource : null;
  return (
    <div className="bulk-trades flex h-full min-h-0 min-w-0 flex-col overflow-auto">
      {current?.payload?.kind === "detail" ? <CampaignPage key={campaignId} detail={current.payload.detail} onBack={onBack} onNavigatePerson={onNavigatePerson} /> : (
        <>
          <header className="flex flex-col gap-2.5 border-b px-4 pb-5 pt-5 sm:px-8" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            {campaignId != null && <a href={buildFileLink("campaign")} onClick={(event) => followInApp(event, onBack)} className="inline-flex self-start items-center gap-1.5 text-[13px] hover:underline" style={mutedStyle}><ArrowLeft size={14} aria-hidden="true" />Back to Campaigns</a>}
            <h1 className="text-[26px] font-semibold tracking-[-0.01em]">Campaigns</h1>
          </header>
          <main className="min-w-0 flex-1 px-4 pb-8 pt-6 sm:px-8">
            {current?.error ? <div className="flex flex-col items-start gap-3"><ErrorText error={current.error} /><button type="button" onClick={() => setAttempt((value) => value + 1)} className={buttonClass} style={buttonStyle}>Retry</button></div>
              : current?.payload?.kind === "list" ? <CampaignsList campaigns={current.payload.campaigns} onOpenCampaign={onOpenCampaign} />
              : <p role="status" className="text-[13px]" style={mutedStyle}>Loading {campaignId == null ? "campaigns" : "campaign"}…</p>}
          </main>
        </>
      )}
    </div>
  );
}

function CampaignsList({ campaigns, onOpenCampaign }: { campaigns: CampaignSummary[]; onOpenCampaign: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const table = useRef<HTMLTableElement>(null);
  const term = query.trim().toLocaleLowerCase();
  const rows = campaigns.filter((campaign) => !term || [campaign.name, campaign.audience, campaign.status].some((value) => value?.toLocaleLowerCase().replace(/[_-]+/g, " ").includes(term)));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));

  if (!campaigns.length) { return <p className="py-8 text-[13px]" style={mutedStyle}>No campaigns are recorded yet.</p>; }
  return (
    <Card label="Campaign list">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-3" style={{ background: "var(--bt-bg)", borderColor: "var(--bt-divider)" }}>
        <Input type="search" aria-label="Search campaigns" placeholder="Search campaign, audience or status" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} className={`${inputClass} h-8 max-w-sm text-[13px] shadow-none focus-visible:ring-0`} style={inputStyle} />
        <span className="text-[13px]" style={mutedStyle}>{campaigns.length} {campaigns.length === 1 ? "campaign" : "campaigns"}</span>
      </div>
      <div className="max-w-full overflow-x-auto">
        <table ref={table} tabIndex={-1} aria-label="Campaigns" className="w-full min-w-[780px] border-collapse text-left focus:outline-none">
          <thead style={{ background: "var(--bt-table-head)" }}><tr>{["Campaign", "Sent date / audience", "Status", "Sent", "Delivered", "Tracked opens", "Tracked clicks"].map((label) => <th key={label} scope="col" className="bt-label border-b px-3.5 py-2.5" style={cellStyle}>{label}</th>)}</tr></thead>
          <tbody>
            {rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((campaign) => <tr key={campaign.id} className="hover:bg-[var(--bt-row-hover)]">
              <td className={`${cellClass} min-w-[190px]`} style={cellStyle}>
                <a href={buildEntryLink("campaign", campaign.id)} onClick={(event) => followInApp(event, () => onOpenCampaign(campaign.id))} className="text-sm font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]">{campaign.name}</a>
                <div className="mt-0.5 text-xs" style={mutedStyle}>{campaign.metrics_basis === "snapshot" ? "Historical snapshot" : "Recipient ledger"} · {campaign.recipient_count} retained</div>
                {campaign.tracking_pending > 0 && <div className="mt-0.5 text-xs" style={{ color: "var(--bt-amber)" }}>{campaign.tracking_pending} tracking pending</div>}
              </td>
              <td className={cellClass} style={cellStyle}><CampaignDate value={campaign.launched_at || campaign.last_invite_at} /><div className="mt-0.5" style={mutedStyle}>{humanize(campaign.audience)}</div></td>
              <td className={cellClass} style={cellStyle}><StatusTag status={campaign.status} /></td>
              {[campaign.metrics.sent, campaign.metrics.delivered, campaign.metrics.opened, campaign.metrics.clicked].map((value, index) => <td key={index} className={`${cellClass} bt-mono`} style={cellStyle}>{value == null ? "Unknown" : value.toLocaleString("en-GB")}</td>)}
            </tr>)}
            {!rows.length && <tr><td colSpan={7} className="px-3.5 py-8 text-center text-[13px]" style={mutedStyle}>No campaigns match your search.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={currentPage} count={rows.length} onPage={(next) => { setPage(next); table.current?.focus({ preventScroll: true }); }} />
    </Card>
  );
}
