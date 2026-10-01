"use client";

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { CampaignActivity } from "@/lib/campaign-activity";
import type { CampaignDetail } from "@/lib/campaigns";
import { buildFileLink } from "@/lib/workspace-links";
import { request } from "../bulk-trades/trade-ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../platform-admin/ui/tabs";
import { CampaignRecipients } from "./campaign-recipients";
import { CampaignListings, CampaignWebsiteActivity } from "./campaign-activity-panel";
import { CampaignDate, MetricsStrip, StatusTag, followInApp, humanize, mutedStyle } from "./campaign-ui";

type Props = { detail: CampaignDetail; onBack: () => void; onNavigatePerson: (id: string) => void };
type ActivityState = { campaignId: string; activity: CampaignActivity | null; failed: boolean };

export function CampaignPage({ detail, onBack, onNavigatePerson }: Props) {
  const [tab, setTab] = useState("recipients");
  const campaign = detail.campaign;
  const [evidence, setEvidence] = useState<ActivityState>({ campaignId: campaign.id, activity: null, failed: false });
  useEffect(() => {
    const controller = new AbortController();
    setEvidence({ campaignId: campaign.id, activity: null, failed: false });
    async function load() {
      try {
        const activity = await request<CampaignActivity>(`/api/campaigns/${encodeURIComponent(campaign.id)}/activity`, { signal: controller.signal });
        if (!controller.signal.aborted && activity.campaign_id === campaign.id) {
          setEvidence({ campaignId: campaign.id, activity, failed: false });
        } else if (!controller.signal.aborted) {
          setEvidence({ campaignId: campaign.id, activity: null, failed: true });
        }
      } catch {
        if (!controller.signal.aborted) { setEvidence({ campaignId: campaign.id, activity: null, failed: true }); }
      }
    }
    void load();
    return () => controller.abort();
  }, [campaign.id]);
  const currentEvidence = evidence.campaignId === campaign.id ? evidence : null;
  const activity = currentEvidence?.activity ?? null;
  const activityLoading = !currentEvidence || (!currentEvidence.failed && !activity);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      <header className="flex flex-col gap-3.5 border-b px-4 pb-5 pt-5 sm:px-8" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <nav aria-label="Breadcrumb" className="text-[13px]" style={mutedStyle}>
          <a href={buildFileLink("campaign")} onClick={(event) => followInApp(event, onBack)} className="inline-flex items-center gap-1.5 hover:underline"><ArrowLeft size={14} aria-hidden="true" />Back to Campaigns</a>
        </nav>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="min-w-0 break-words text-[26px] font-semibold tracking-[-0.01em]">{campaign.name}</h1>
          <StatusTag status={campaign.status} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]" style={{ color: "var(--bt-text-2)" }}>
          {campaign.type && <span>{humanize(campaign.type)}</span>}
          {campaign.channel && <span>{humanize(campaign.channel)}</span>}
          <span>Audience: {campaign.audience ? humanize(campaign.audience) : "Unknown"}{campaign.audience_size != null ? ` · ${campaign.audience_size.toLocaleString("en-GB")}` : ""}</span>
          <span>Sent: <CampaignDate value={campaign.launched_at || campaign.last_invite_at} /></span>
        </div>
        <MetricsStrip campaign={campaign} />
        <p className="text-[13px]" style={mutedStyle}>Bounced: {campaign.metrics.bounced ?? "Unknown"} · Opted out: {campaign.metrics.opted_out ?? "Unknown"}</p>
        <section aria-label="Metrics provenance" className="flex flex-col gap-1 text-xs" style={mutedStyle}>
          <p>{campaign.metrics_basis === "snapshot" ? "Historical snapshot" : "Recipient ledger totals"} · {campaign.metrics_basis === "snapshot" ? `Original sent: ${campaign.metrics.sent ?? "Unknown"} · ` : ""}Retained recipients: {campaign.recipient_count.toLocaleString("en-GB")}</p>
          <p>{campaign.metrics_basis === "snapshot" ? "Saved totals are preserved; the retained recipient ledger below may not cover every original send." : "Totals come from the retained send ledger and its available tracking observations."}</p>
          <p>{campaign.metrics_observed_at ? <>{campaign.metrics_basis === "snapshot" ? "Snapshot refreshed" : "Latest recipient check"}: <CampaignDate value={campaign.metrics_observed_at} withTime />. This does not mean every recipient was checked.</> : "Observation freshness is unknown."}</p>
          <p>Open and click tracking may include automated activity; these counts do not verify human reads or website visits.</p>
        </section>
        {campaign.tracking_pending > 0 && <p role="status" className="border px-3 py-2 text-[13px]" style={{ background: "var(--bt-amber-bg)", borderColor: "var(--bt-amber-border)", color: "var(--bt-amber)" }}>{campaign.tracking_pending} accepted {campaign.tracking_pending === 1 ? "send has" : "sends have"} not been synced. Tracking is pending, not evidence of no engagement; any recorded events remain visible.</p>}
        <CampaignWebsiteActivity activity={activity} loading={activityLoading} />
      </header>
      <main className="min-w-0 px-4 pb-8 pt-4 sm:px-8">
        <Tabs value={tab} onValueChange={setTab} className="gap-4">
          <TabsList variant="line" aria-label="Campaign sections" className="group-data-[orientation=horizontal]/tabs:h-auto max-w-full justify-start rounded-none border-b p-0" style={{ borderColor: "var(--bt-border)", color: "var(--bt-muted)" }}>
            {[["recipients", "Recipients"], ["listings", "Listings"], ["details", "Details"]].map(([value, label]) => <TabsTrigger key={value} value={value} className="h-auto flex-none rounded-none border-0 px-3.5 py-3 text-[13px] shadow-none hover:text-[var(--bt-text)] focus-visible:ring-[var(--bt-text)] data-[state=active]:bg-transparent data-[state=active]:text-[var(--bt-text)] data-[state=active]:font-semibold after:bg-[var(--bt-text)] group-data-[orientation=horizontal]/tabs:after:bottom-0" style={{ color: tab === value ? "var(--bt-text)" : "var(--bt-muted)" }}>{label}</TabsTrigger>)}
          </TabsList>
          <TabsContent value="recipients" forceMount hidden={tab !== "recipients"} className="data-[state=inactive]:hidden">
            <CampaignRecipients recipients={detail.recipients} onNavigatePerson={onNavigatePerson} />
          </TabsContent>
          <TabsContent value="listings">
            <CampaignListings detail={detail} activity={activity} loading={activityLoading} onNavigatePerson={onNavigatePerson} />
          </TabsContent>
          <TabsContent value="details">
            <CampaignAudit detail={detail} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function CampaignAudit({ detail }: Pick<Props, "detail">) {
  const { details } = detail;
  const fields = [
    ["Source system", details.source_system], ["Auction", details.auction_slug], ["Original audience", details.audience_raw],
    ["Objective", details.objective], ["Success measure", details.success_measure], ["Message version", details.message_version],
    ["Stock snapshot reference", details.stock_snapshot_ref], ["Sender", details.sender_identity], ["Reply owner", details.reply_owner],
    ["Reply mailbox", details.reply_mailbox], ["Approved by", details.approved_by], ["Approved manifest SHA-256", details.approved_manifest_sha256],
  ].filter(([, value]) => value != null && value !== "");
  const dates = [["Created", details.created_at], ["Updated", details.updated_at], ["Approved", details.approved_at], ["Reviewed", details.reviewed_at]].filter(([, value]) => value != null);
  return (
    <div className="flex flex-col gap-3">
      <details className="rounded-none border" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
        <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]">Technical and audit details</summary>
        <dl className="grid gap-x-6 gap-y-3 border-t px-4 py-4 text-[13px] sm:grid-cols-2" style={{ borderColor: "var(--bt-divider)" }}>
          {fields.map(([label, value]) => <div key={label} className="min-w-0"><dt className="bt-label mb-1">{label}</dt><dd className="break-words">{value}</dd></div>)}
          {dates.map(([label, value]) => <div key={label}><dt className="bt-label mb-1">{label}</dt><dd><CampaignDate value={value} withTime /></dd></div>)}
          {!fields.length && !dates.length && <p style={mutedStyle}>No audit metadata is recorded.</p>}
        </dl>
      </details>
      <details className="rounded-none border" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
        <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]">Notes</summary>
        <p className="whitespace-pre-wrap break-words border-t px-4 py-4 text-[13px] leading-relaxed" style={{ borderColor: "var(--bt-divider)", color: details.notes ? "var(--bt-text)" : "var(--bt-muted)" }}>{details.notes || "No notes recorded."}</p>
      </details>
    </div>
  );
}
