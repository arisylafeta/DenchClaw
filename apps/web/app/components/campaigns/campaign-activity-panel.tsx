"use client";

import tableStyles from "../ui/data-table.module.css";
import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import type { CampaignActivity, CampaignActivityDestination } from "@/lib/campaign-activity";
import type { CampaignDetail, CampaignRecipient } from "@/lib/campaigns";
import { Card } from "../bulk-trades/trade-ui";
import { CampaignPeopleSheet, SUBMISSION_FIELDS } from "./campaign-people-sheet";
import type { CampaignPersonRow, PeopleSource } from "./campaign-people-sheet";
import { CampaignDate, cellStyle, mutedStyle } from "./campaign-ui";

type Props = { detail: CampaignDetail; activity: CampaignActivity | null; loading: boolean; onNavigatePerson: (id: string) => void };

export function CampaignWebsiteActivity({ activity, loading }: Pick<Props, "activity" | "loading">) {
  const totals = activity?.status === "available" ? activity.totals : null;
  const message = loading ? "Loading PostHog website evidence…" : activity?.status === "unmapped" ? "This campaign has no mapped website attribution. Website activity is unknown." : !totals ? "PostHog website evidence is unavailable. Website activity is unknown; the email ledger remains available." : null;
  return (
    <section aria-label="PostHog website evidence" className="flex flex-col gap-2 border-t pt-3 text-[13px]" style={{ borderColor: "var(--bt-divider)" }}>
      <h2 className="font-semibold">PostHog website evidence</h2>
      {message ? <p role="status" style={mutedStyle}>{message}</p> : totals && <>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {([["Visited recipient records via assigned links", totals.visited_recipients], ["Distinct browser sessions", totals.sessions], ["Recorded submission events", totals.offer_events + totals.message_events + totals.buy_now_events]] as const).map(([label, count]) => <div key={label}><dt className="text-xs" style={mutedStyle}>{label}</dt><dd className="bt-mono mt-0.5 text-lg font-semibold">{count.toLocaleString("en-GB")}</dd></div>)}
        </dl>
        {totals.page_views === 0 && totals.offer_events + totals.message_events + totals.buy_now_events === 0 && <p role="status" style={mutedStyle}>No browser page or submission events were recorded in this period.</p>}
        <p style={mutedStyle}>Offers: {totals.offer_events} · Messages: {totals.message_events} · Buy now: {totals.buy_now_events} · Page events: {totals.page_views}</p>
        <p style={mutedStyle}>Period: <CampaignDate value={activity?.period_start ?? null} withTime /> – <CampaignDate value={activity?.period_end ?? null} withTime /> · Observed: <CampaignDate value={activity?.observed_at ?? null} withTime /></p>
      </>}
      <p className="text-xs" style={mutedStyle}>Separate from historical email metrics; these observations are not a conversion rate. Assigned links can be forwarded and do not verify the named recipient. Missing consented browser events do not prove inactivity. Destination rows can overlap; totals include other destinations.</p>
    </section>
  );
}

function emailRows(recipients: CampaignRecipient[], key: string, kind: "listing" | "other", destination?: CampaignActivityDestination): CampaignPersonRow[] {
  const rows = new Map<string, CampaignPersonRow>();
  const observations = new Map<string, CampaignActivityDestination["people"][number]>();
  for (const person of destination?.people ?? []) { observations.set(person.person_id, person); }
  for (const recipient of recipients) {
    if (!recipient.accepted_at && recipient.state !== "accepted") { continue; }
    const click = kind === "listing" ? recipient.listing_clicks.find((value) => value.listing_id === key) : recipient.other_clicks.find((value) => value.cta_key === key);
    if (!click) { continue; }
    if (!rows.has(recipient.person_id)) { rows.set(recipient.person_id, { recipient, activity: observations.get(recipient.person_id) }); }
  }
  return [...rows.values()];
}

function activityRows(destination: CampaignActivityDestination, byId: ReadonlyMap<string, CampaignRecipient>, source: Exclude<PeopleSource, "email">): CampaignPersonRow[] {
  const rows: CampaignPersonRow[] = [];
  for (const activity of destination.people) {
    const positive = source === "browser" ? activity.page_views > 0 : source === "click" ? activity.redirect_events > 0 : activity[SUBMISSION_FIELDS[source].count] > 0;
    const recipient = byId.get(activity.person_id);
    if (recipient && positive) { rows.push({ recipient, activity }); }
  }
  return rows;
}

export function CampaignListings({ detail, activity, loading, onNavigatePerson }: Props) {
  const available = activity?.status === "available";
  const recipientsById = useMemo(() => {
    const byId = new Map<string, CampaignRecipient>();
    for (const recipient of detail.recipients) { byId.set(recipient.person_id, recipient); }
    return byId;
  }, [detail.recipients]);
  return (
    <div className="flex flex-col gap-4">
      <Card label="Pitched listings">
        <p className="border-b px-3.5 py-3 text-xs" style={{ ...mutedStyle, borderColor: "var(--bt-divider)" }}>Email clicks come from accepted, destination-specific tracking in the retained ledger. Website columns are separate PostHog evidence.{detail.campaign.tracking_pending > 0 ? " Email tracking is incomplete; zero observed clicks does not prove no engagement." : ""}{loading ? " Website evidence is loading." : ""}</p>
        <div className={`bulk-trades ${tableStyles.surface} max-w-full overflow-x-auto`}>
          <table aria-label="Listings" className={`${tableStyles.table} min-w-[720px]`}>
            <thead style={{ background: "var(--bt-table-head)" }}><tr>{["Listing", "Recipients pitched", "Email clicks", "Website activity", "Submissions"].map((label) => <th key={label} scope="col" className={tableStyles.headerCell} style={cellStyle}>{label}</th>)}</tr></thead>
            <tbody>
              {detail.listings.map((listing) => {
                const destination = available ? activity.destinations.find((value) => value.listing_id === listing.listing_id) : undefined;
                const clicked = emailRows(detail.recipients, listing.listing_id, "listing", destination);
                return <tr key={listing.listing_id} className="hover:bg-[var(--bt-row-hover)]">
                  <td className={`${tableStyles.cell} min-w-[180px]`} style={cellStyle}>{listing.url ? <a href={listing.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-start gap-1.5 font-medium hover:underline focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]" style={{ color: "var(--bt-link)" }}>{listing.label}<ExternalLink size={14} className="mt-0.5 shrink-0" aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a> : <span className="font-medium">{listing.label}</span>}</td>
                  <td className={`${tableStyles.cell} bt-mono`} style={cellStyle}>{listing.recipients}</td>
                  <td className={tableStyles.cell} style={cellStyle}><CampaignPeopleSheet destination={listing.label} source="email" count={clicked.length} rows={clicked} onNavigatePerson={onNavigatePerson} />{detail.campaign.tracking_pending > 0 && <span className="block text-xs" style={mutedStyle}>observed · pending</span>}</td>
                  <WebsiteCells label={listing.label} destination={destination} recipientsById={recipientsById} onNavigatePerson={onNavigatePerson} />
                </tr>;
              })}
              {!detail.listings.length && <tr><td colSpan={5} className="px-3.5 py-8 text-center text-[13px]" style={mutedStyle}>No pitched listings are recorded in the retained ledger.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      {!!detail.other_destinations.length && <Card label="Other destinations">
        <div className={`bulk-trades ${tableStyles.surface} max-w-full overflow-x-auto`}><table aria-label="Other destinations" className={`${tableStyles.table} min-w-[640px]`}>
          <thead style={{ background: "var(--bt-table-head)" }}><tr>{["Destination", "Email clicks", "Website activity", "Submissions"].map((label) => <th key={label} scope="col" className={tableStyles.headerCell} style={cellStyle}>{label}</th>)}</tr></thead>
          <tbody>{detail.other_destinations.map((other) => {
            const destination = available ? activity.destinations.find((value) => value.listing_id == null && value.cta_key === other.cta_key) : undefined;
            const clicked = emailRows(detail.recipients, other.cta_key, "other", destination);
            return <tr key={other.cta_key} className="hover:bg-[var(--bt-row-hover)]">
              <td className={tableStyles.cell} style={cellStyle}>{other.label}</td>
              <td className={tableStyles.cell} style={cellStyle}><CampaignPeopleSheet destination={other.label} source="email" count={clicked.length} rows={clicked} onNavigatePerson={onNavigatePerson} /></td>
              <WebsiteCells label={other.label} destination={destination} recipientsById={recipientsById} onNavigatePerson={onNavigatePerson} />
            </tr>;
          })}</tbody>
        </table></div>
      </Card>}
    </div>
  );
}

function WebsiteCells({ label, destination, recipientsById, onNavigatePerson }: { label: string; destination?: CampaignActivityDestination; recipientsById: ReadonlyMap<string, CampaignRecipient>; onNavigatePerson: (id: string) => void }) {
  if (!destination) { return <><td className={tableStyles.cell} style={{ ...cellStyle, ...mutedStyle }}>Unknown</td><td className={tableStyles.cell} style={{ ...cellStyle, ...mutedStyle }}>Unknown</td></>; }
  const submissions = (["offer", "message", "buy_now"] as const).filter((source) => destination[SUBMISSION_FIELDS[source].count] > 0);
  return <>
    <td className={tableStyles.cell} style={cellStyle}>
      <CampaignPeopleSheet destination={label} source="browser" count={destination.visited_recipients} rows={activityRows(destination, recipientsById, "browser")} onNavigatePerson={onNavigatePerson} />
      <span className="mt-0.5 block text-xs" style={mutedStyle}>{destination.sessions} {destination.sessions === 1 ? "browser session" : "browser sessions"}</span>
      <div className="mt-1"><CampaignPeopleSheet destination={label} source="click" count={destination.redirect_events} rows={activityRows(destination, recipientsById, "click")} onNavigatePerson={onNavigatePerson} /></div>
    </td>
    <td className={tableStyles.cell} style={cellStyle}>
      {submissions.length ? <div className="flex flex-col items-start gap-1">{submissions.map((source) => <div key={source}>
        <CampaignPeopleSheet destination={label} source={source} count={destination[SUBMISSION_FIELDS[source].count]} rows={activityRows(destination, recipientsById, source)} onNavigatePerson={onNavigatePerson} />
        <span className="ml-1.5 text-xs" style={mutedStyle}>{source === "buy_now" ? "Buy now" : source === "offer" ? "Offers" : "Messages"}</span>
      </div>)}</div> : <span style={mutedStyle}>0 recorded</span>}
    </td>
  </>;
}
