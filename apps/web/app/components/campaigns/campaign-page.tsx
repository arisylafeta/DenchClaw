"use client";

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { CampaignActivity } from "@/lib/campaign-activity";
import type { MailCampaignDetail } from "@/lib/mail-types";
import { JOURNEY } from "@/lib/dismantlers";
import { buildFileLink } from "@/lib/workspace-links";
import { request } from "../bulk-trades/trade-ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../platform-admin/ui/tabs";
import { CampaignEngagementRanking } from "./campaign-engagement-ranking";
import { CampaignRecipients } from "./campaign-recipients";
import { CampaignListings, CampaignWebsiteActivity } from "./campaign-activity-panel";
import styles from "./campaign-surface.module.css";
import { CampaignDate, CampaignPin, MetricRow, StatusTag, CampaignLoading, followInApp, humanize, mutedStyle } from "./campaign-ui";

type Props = { query?: string; detail: MailCampaignDetail; onBack: () => void; onNavigatePerson: (id: string) => void };
type ActivityState = { campaignId: string; query: string; activity: CampaignActivity | null; failed: boolean };

/** A quiet loading state, without placeholder tables or metric blocks. */
export function CampaignPageSkeleton() {
  return <CampaignLoading label="Loading campaign…" />;
}

export function CampaignPage({ detail, onBack, onNavigatePerson, query = "" }: Props) {
  const [tab, setTab] = useState("recipients");
  const campaign = detail.campaign;
  const [evidence, setEvidence] = useState<ActivityState>({ campaignId: campaign.id, query, activity: null, failed: false });
  useEffect(() => {
    const controller = new AbortController();
    setEvidence({ campaignId: campaign.id, query, activity: null, failed: false });
    async function load() {
      try {
        const activity = await request<CampaignActivity>(`/api/mail/campaigns/${encodeURIComponent(campaign.id)}/activity${query ? `?${query}` : ""}`, { signal: controller.signal });
        if (!controller.signal.aborted && activity.campaign_id === campaign.id) {
          setEvidence({ campaignId: campaign.id, query, activity, failed: false });
        } else if (!controller.signal.aborted) {
          setEvidence({ campaignId: campaign.id, query, activity: null, failed: true });
        }
      } catch {
        if (!controller.signal.aborted) { setEvidence({ campaignId: campaign.id, query, activity: null, failed: true }); }
      }
    }
    void load();
    return () => controller.abort();
  }, [campaign.id, query]);
  const currentEvidence = evidence.campaignId === campaign.id && evidence.query === query ? evidence : null;
  const activity = currentEvidence?.activity ?? null;
  const activityLoading = !currentEvidence || (!currentEvidence.failed && !activity);
  return (
    <div className={`bulk-trades ${styles.surface} flex min-h-0 min-w-0 flex-1 flex-col overflow-auto`}>
      <header className="flex flex-col gap-4 px-4 pb-3 pt-6 sm:px-8" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a href={buildFileLink("campaign")} onClick={(event) => followInApp(event, onBack)} aria-label="Back to Campaigns" className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-[var(--bt-row-hover)]" style={mutedStyle}><ArrowLeft size={15} aria-hidden="true" /></a>
          <CampaignPin id={campaign.id} size={12} />
          <h1 className="min-w-0 break-words text-[20px] font-semibold tracking-[-0.01em]">{campaign.name}</h1>
          <StatusTag status={detail.mail_state ?? campaign.status} />
          {campaign.tracking_pending > 0 && <span role="status" className="text-[12px]" style={{ color: "var(--bt-amber)" }} title="Accepted sends not yet synced. Not evidence of no engagement.">{campaign.tracking_pending} tracking pending</span>}
        </div>
        <p className="text-[13px]" style={mutedStyle}><CampaignDate value={campaign.launched_at || campaign.last_invite_at} />{campaign.audience ? ` · ${humanize(campaign.audience)}` : ""}{campaign.audience_size != null ? ` (${campaign.audience_size.toLocaleString("en-GB")})` : ""}{campaign.channel ? ` · ${humanize(campaign.channel)}` : ""}</p>
        <section title="Opens and clicks are observations, not verified people or site visits." aria-label="Campaign metrics" className="flex flex-col gap-4 rounded-xl px-5 py-5" style={{ borderColor: "var(--bt-border)", background: "var(--bt-bg)" }}>
          <MetricRow size="lg" counts={detail} notTracked={campaign.channel === "email-gmail" ? ["delivered", "opened", "clicked"] : []} />
          <p aria-label="Returning readers" aria-live="polite" className="flex items-baseline gap-2 text-[12px]" style={mutedStyle}><span className="order-2">Returning readers</span><span className="text-lg font-semibold tabular-nums" style={{ color: "var(--bt-text)" }}>{activity?.engagement ? activity.engagement.filter((row) => row.return_sessions > 0).length : activityLoading ? "Loading…" : "Unavailable"}</span></p>
          {detail.sent && detail.delivered != null && <div role="img" aria-label={`${detail.delivered} of ${detail.sent} delivered`} className="h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--bt-divider)" }}><div className="h-full rounded-full" style={{ width: `${Math.min(100, (100 * detail.delivered) / detail.sent)}%`, background: "var(--color-accent-fill)" }} /></div>}
        </section>
        {detail.dismantler_funnel && <DismantlerFunnel funnel={detail.dismantler_funnel} />}
        <details className="text-[12px]" style={mutedStyle}>
          <summary className="cursor-pointer select-none">About the numbers</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p role="note">Scanner evidence: {detail.scanner_evidence ? "recorded" : "not recorded"} · Proxy evidence: {detail.proxy_evidence ? "recorded" : "not recorded"}.</p>
            <section aria-label="Metrics provenance" className="flex flex-col gap-0.5">
              <p>{campaign.metrics_basis === "snapshot" ? `Historical snapshot · Original sent: ${campaign.metrics.sent ?? "Unknown"} · ` : "Mail log · "}Retained recipients: {campaign.recipient_count.toLocaleString("en-GB")}</p>
              <p>Rates: delivery and bounce are of sent; the rest are of delivered. {campaign.metrics_observed_at ? <>Checked <CampaignDate value={campaign.metrics_observed_at} withTime />.</> : null}</p>
            </section>
            <CampaignWebsiteActivity activity={activity} loading={activityLoading} />
          </div>
        </details>
      </header>
      <main className="min-w-0 px-4 pb-8 pt-4 sm:px-8">
        <Tabs value={tab} onValueChange={setTab} className="gap-4">
          <TabsList aria-label="Campaign sections" className="group-data-[orientation=horizontal]/tabs:h-auto max-w-full flex-wrap justify-start rounded-lg p-1" style={{ background: "var(--bt-segment)", color: "var(--bt-text-2)" }}>
            {[["recipients", "Recipients"], ["engagement", "Engagement"], ["listings", "Listings"], ["details", "Details"]].map(([value, label]) => <TabsTrigger key={value} value={value} className="min-h-11 flex-none rounded-md border-0 px-3 text-[13px] shadow-none focus-visible:ring-[var(--bt-text)] data-[state=active]:font-semibold after:hidden" style={{ color: tab === value ? "var(--bt-text)" : "var(--bt-text-2)", background: tab === value ? "var(--bt-surface)" : "transparent", boxShadow: tab === value ? "0 1px 2px var(--bt-border)" : undefined }}>{label}</TabsTrigger>)}
          </TabsList>
          <TabsContent value="recipients" forceMount hidden={tab !== "recipients"} className="data-[state=inactive]:hidden">
            <CampaignRecipients recipients={detail.recipients} deliveryRows={detail.delivery_rows} onNavigatePerson={onNavigatePerson} outreach={!!detail.dismantler_funnel} />
            <details className="mt-5 text-[12px]" style={mutedStyle}><summary className="cursor-pointer py-2">Tracked links</summary><section aria-label="Tracked links"><ul>{detail.links?.map((link) => <li key={link.id} className="py-1 text-sm"><a href={link.destination_url} target="_blank" rel="noreferrer" className="underline">{link.cta_key}</a> · {link.destination_url} · First click: <CampaignDate value={link.first_clicked_at} withTime /></li>)}</ul>{!detail.links?.length && <p>No tracked links recorded.</p>}</section></details>
          </TabsContent>
          <TabsContent value="engagement">
            {activityLoading ? <CampaignLoading label="Loading engagement…" /> : activity?.engagement ? <CampaignEngagementRanking rows={activity.engagement} onNavigateEntry={(_object, id) => onNavigatePerson(id)} /> : <p role="alert" style={mutedStyle}>Engagement unavailable. Reload to retry.</p>}
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

/** Where the emailed dismantlers are now. Stages move on the Dismantlers page; a send moves Found to Talking. */
function DismantlerFunnel({ funnel }: { funnel: NonNullable<MailCampaignDetail["dismantler_funnel"]> }) {
  const steps: Array<[string, number]> = [["Emailed", funnel.emailed], ["Replied", funnel.replied],
    ...JOURNEY.map((stage): [string, number] => [stage, funnel.stages[stage] ?? 0]), ["Parked", funnel.stages.Parked ?? 0]];
  return (
    <section aria-label="Dismantler progress" className="flex flex-col gap-1.5">
      <span className="bt-label">Dismantlers</span>
      <div className="grid gap-x-4 gap-y-1 text-[13px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))" }}>
        {steps.map(([label, count]) => <span key={label} className="flex items-baseline justify-between gap-2 py-1" style={{ borderColor: "var(--bt-divider)" }}><span style={mutedStyle}>{label}</span> <span className="bt-mono font-semibold">{count.toLocaleString("en-GB")}</span></span>)}
      </div>
    </section>
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
      <details className="rounded-xl" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
        <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]">Audit</summary>
        <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-[13px] sm:grid-cols-2" style={{ borderColor: "var(--bt-divider)" }}>
          {fields.map(([label, value]) => <div key={label} className="min-w-0"><dt className="bt-label mb-1">{label}</dt><dd className="break-words">{value}</dd></div>)}
          {dates.map(([label, value]) => <div key={label}><dt className="bt-label mb-1">{label}</dt><dd><CampaignDate value={value} withTime /></dd></div>)}
          {!fields.length && !dates.length && <p style={mutedStyle}>No audit metadata is recorded.</p>}
        </dl>
      </details>
      <details className="rounded-xl" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
        <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]">Notes</summary>
        <p className="whitespace-pre-wrap break-words px-4 py-4 text-[13px] leading-relaxed" style={{ borderColor: "var(--bt-divider)", color: details.notes ? "var(--bt-text)" : "var(--bt-muted)" }}>{details.notes || "No notes recorded."}</p>
      </details>
    </div>
  );
}
