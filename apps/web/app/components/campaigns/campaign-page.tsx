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
import tableStyles from "../ui/data-table.module.css";
import { ShimmerBar } from "../ui/shimmer";
import stackStyles from "./stack-table.module.css";
import { CampaignDate, CampaignPin, MetricRow, StatusTag, cellStyle, followInApp, humanize, mutedStyle } from "./campaign-ui";

type Props = { query?: string; detail: MailCampaignDetail; onBack: () => void; onNavigatePerson: (id: string) => void };
type ActivityState = { campaignId: string; query: string; activity: CampaignActivity | null; failed: boolean };

/** The campaign page with its real header, metric strip, tabs and recipient table, holding placeholders where data goes. */
export function CampaignPageSkeleton() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto" role="status" aria-busy="true">
      <span className="sr-only">Loading campaign…</span>
      <header aria-hidden className="flex flex-col gap-3 border-b px-4 pb-4 pt-4 sm:px-8" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex h-7 w-7 items-center justify-center"><ShimmerBar w={15} h={15} round /></span>
          <ShimmerBar w={12} h={12} round />
          <ShimmerBar w="min(320px, 55%)" h={28} />
          <ShimmerBar w={72} h={24} round />
        </div>
        <p className="h-5"><ShimmerBar w="min(360px, 70%)" h={13} style={{ marginTop: 3 }} /></p>
        <section className="flex flex-col gap-3 rounded-lg border px-4 py-3" style={{ borderColor: "var(--bt-border)", background: "var(--bt-bg)" }}>
          <MetricRow size="lg" loading />
          <div className="h-1 w-full rounded-full" style={{ background: "var(--bt-divider)" }} />
        </section>
        <p className="h-4"><ShimmerBar w={130} h={11} /></p>
      </header>
      <main aria-hidden className="min-w-0 px-4 pb-8 pt-4 sm:px-8">
        <div className="flex gap-0 border-b" style={{ borderColor: "var(--bt-border)" }}>
          {[96, 76, 70].map((width, i) => <span key={i} className="px-3.5 py-3"><ShimmerBar w={width} h={20} /></span>)}
        </div>
        <div className={`bulk-trades ${tableStyles.surface} mt-4 overflow-hidden border`} style={{ borderColor: "var(--bt-border)" }}>
          <div className="flex flex-wrap items-center gap-2.5 border-b px-3.5 py-3" style={{ background: "var(--bt-bg)", borderColor: "var(--bt-divider)" }}>
            <ShimmerBar w="min(320px, 100%)" h={32} /><ShimmerBar w={280} h={32} />
          </div>
          <table className={`${tableStyles.table} ${stackStyles.stack}`}>
            <thead style={{ background: "var(--bt-table-head)" }}><tr>{[0, 1, 2, 3, 4, 5, 6].map((i) => <th key={i} scope="col" className={tableStyles.headerCell} style={cellStyle}><ShimmerBar w="60%" h={10} /></th>)}</tr></thead>
            <tbody>{Array.from({ length: 6 }, (_, row) => <tr key={row}>{[0, 1, 2, 3, 4, 5, 6].map((i) => <td key={i} className={tableStyles.cell} style={cellStyle}><ShimmerBar w={i === 0 ? "78%" : "56%"} h={12} style={{ margin: "4px 0" }} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      </main>
    </div>
  );
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      <header className="flex flex-col gap-3 border-b px-4 pb-4 pt-4 sm:px-8" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a href={buildFileLink("campaign")} onClick={(event) => followInApp(event, onBack)} aria-label="Back to Campaigns" className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--bt-row-hover)]" style={mutedStyle}><ArrowLeft size={15} aria-hidden="true" /></a>
          <CampaignPin id={campaign.id} size={12} />
          <h1 className="min-w-0 break-words text-[20px] font-semibold tracking-[-0.01em]">{campaign.name}</h1>
          <StatusTag status={detail.mail_state ?? campaign.status} />
          {campaign.tracking_pending > 0 && <span role="status" className="text-[12px]" style={{ color: "var(--bt-amber)" }} title="Accepted sends not yet synced. Not evidence of no engagement.">{campaign.tracking_pending} tracking pending</span>}
        </div>
        <p className="text-[13px]" style={mutedStyle}><CampaignDate value={campaign.launched_at || campaign.last_invite_at} />{campaign.audience ? ` · ${humanize(campaign.audience)}` : ""}{campaign.audience_size != null ? ` (${campaign.audience_size.toLocaleString("en-GB")})` : ""}{campaign.channel ? ` · ${humanize(campaign.channel)}` : ""}</p>
        <section aria-label="Campaign metrics" className="flex flex-col gap-3 rounded-lg border px-4 py-3" style={{ borderColor: "var(--bt-border)", background: "var(--bt-bg)" }}>
          <MetricRow size="lg" counts={detail} notTracked={campaign.channel === "email-gmail" ? ["delivered", "opened", "clicked"] : []} />
          <p className="text-[13px]" style={mutedStyle}>Returning readers: <span className="bt-mono font-semibold">{activity?.engagement ? activity.engagement.filter((row) => row.return_sessions > 0).length : activityLoading ? "Loading…" : "Unavailable"}</span></p>
          {detail.sent && detail.delivered != null && <div role="img" aria-label={`${detail.delivered} of ${detail.sent} delivered`} className="h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--bt-divider)" }}><div className="h-full rounded-full" style={{ width: `${Math.min(100, (100 * detail.delivered) / detail.sent)}%`, background: "var(--color-accent-fill)" }} /></div>}
        </section>
        {detail.dismantler_funnel && <DismantlerFunnel funnel={detail.dismantler_funnel} />}
        <details className="text-[12px]" style={mutedStyle}>
          <summary className="cursor-pointer select-none">About these numbers</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p role="note">Scanner evidence: {detail.scanner_evidence ? "recorded" : "not recorded"} · Proxy evidence: {detail.proxy_evidence ? "recorded" : "not recorded"}. Opens and clicks can be automated.</p>
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
          <TabsList variant="line" aria-label="Campaign sections" className="group-data-[orientation=horizontal]/tabs:h-auto max-w-full justify-start rounded-none border-b p-0" style={{ borderColor: "var(--bt-border)", color: "var(--bt-muted)" }}>
            {[["recipients", "Recipients"], ["engagement", "Engagement"], ["listings", "Listings"], ["details", "Details"]].map(([value, label]) => <TabsTrigger key={value} value={value} className="h-auto flex-none rounded-none border-0 px-3.5 py-3 text-[13px] shadow-none hover:text-[var(--bt-text)] focus-visible:ring-[var(--bt-text)] data-[state=active]:bg-transparent data-[state=active]:text-[var(--bt-text)] data-[state=active]:font-semibold after:bg-[var(--bt-text)] group-data-[orientation=horizontal]/tabs:after:bottom-0" style={{ color: tab === value ? "var(--bt-text)" : "var(--bt-muted)" }}>{label}</TabsTrigger>)}
          </TabsList>
          <TabsContent value="recipients" forceMount hidden={tab !== "recipients"} className="data-[state=inactive]:hidden">
            <CampaignRecipients recipients={detail.recipients} deliveryRows={detail.delivery_rows} onNavigatePerson={onNavigatePerson} outreach={!!detail.dismantler_funnel} />
            <section aria-label="Tracked links" className="mt-4"><h2 className="font-semibold">Tracked links</h2><ul>{detail.links?.map((link) => <li key={link.id} className="py-1 text-sm"><a href={link.destination_url} target="_blank" rel="noreferrer" className="underline">{link.cta_key}</a> · {link.destination_url} · First click: <CampaignDate value={link.first_clicked_at} withTime /></li>)}</ul>{!detail.links?.length && <p>No tracked links recorded.</p>}</section>
          </TabsContent>
          <TabsContent value="engagement">
            {activityLoading ? <p role="status" style={mutedStyle}>Loading engagement…</p> : activity?.engagement ? <CampaignEngagementRanking rows={activity.engagement} onNavigateEntry={(_object, id) => onNavigatePerson(id)} /> : <p role="alert" style={mutedStyle}>Engagement is unavailable. Reload the campaign to try again.</p>}
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
        {steps.map(([label, count]) => <span key={label} className="flex items-baseline justify-between gap-2 border-b py-0.5" style={{ borderColor: "var(--bt-divider)" }}><span style={mutedStyle}>{label}</span> <span className="bt-mono font-semibold">{count.toLocaleString("en-GB")}</span></span>)}
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
