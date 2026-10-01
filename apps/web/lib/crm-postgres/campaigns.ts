import type { CampaignDetail, CampaignListing, CampaignMetrics, CampaignRecipient, CampaignSummary } from "../campaigns";
import { queryPg } from "../postgres";

type Timestamp = string | Date | null;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type CampaignRow = {
  id: string;
  campaign_name: string;
  status: string;
  type?: string | null;
  channel?: string | null;
  audience?: string | null;
  source_system?: string | null;
  launched_at?: Timestamp;
  last_invite_at?: Timestamp;
  audience_size?: number | string | null;
  invites_sent?: number | string | null;
  emails_delivered?: number | string | null;
  emails_opened?: number | string | null;
  emails_clicked?: number | string | null;
  emails_bounced?: number | string | null;
  opted_out?: number | string | null;
  metrics_refreshed_at?: Timestamp;
} & Omit<Partial<CampaignDetail["details"]>, "created_at" | "updated_at" | "approved_at" | "reviewed_at">
  & { created_at?: Timestamp; updated_at?: Timestamp; approved_at?: Timestamp; reviewed_at?: Timestamp };

type SendRow = {
  send_id: string;
  campaign_id: string;
  state: string;
  accepted_at: Timestamp;
  delivered_at: Timestamp;
  bounced_at: Timestamp;
  provider_opened_at: Timestamp;
  provider_link_clicked_at: Timestamp;
  link_clicked_at: Timestamp;
  last_synced_at: Timestamp;
  person_id?: string;
  person_name?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  recipient_email?: string;
  listing_id?: string | null;
  auction_url?: string | null;
};

type LinkRow = {
  send_id: string;
  cta_key: string;
  listing_id: string | null;
  destination_url: string;
  first_clicked_at: Timestamp;
};

type Ledger = { available: boolean; links_available: boolean; listings_available: boolean };

function iso(value: Timestamp | undefined): string | null {
  if (!value) { return null; }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function earliest(...values: Array<Timestamp | undefined>): string | null {
  let result: string | null = null;
  for (const value of values) {
    const normalized = iso(value);
    if (normalized && (!result || normalized < result)) { result = normalized; }
  }
  return result;
}

function number(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") { return null; }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function accepted(send: SendRow): boolean {
  return send.accepted_at != null || send.state === "accepted";
}

function pending(send: SendRow): boolean {
  return accepted(send) && !send.last_synced_at;
}

function summarize(campaign: CampaignRow, sends: SendRow[], ledgerAvailable: boolean): CampaignSummary {
  const isLedger = campaign.source_system === "dench-campaign";
  const acceptedSends = sends.filter(accepted);
  const trackingPending = acceptedSends.filter(pending).length;
  let metrics: CampaignMetrics;
  if (isLedger) {
    // An unchecked cohort has no verified negative tracking observations. Positive
    // observations remain useful even if its provider synchronization is pending.
    const unchecked = acceptedSends.length > 0 && trackingPending === acceptedSends.length;
    const observedCount = (predicate: (send: SendRow) => boolean): number | null => {
      if (!ledgerAvailable) { return null; }
      const count = acceptedSends.filter(predicate).length;
      return unchecked && count === 0 ? null : count;
    };
    metrics = {
      sent: ledgerAvailable ? acceptedSends.length : null,
      delivered: observedCount((send) => !!send.delivered_at),
      opened: observedCount((send) => !!send.provider_opened_at),
      clicked: observedCount((send) => !!earliest(send.provider_link_clicked_at, send.link_clicked_at)),
      bounced: observedCount((send) => !!send.bounced_at),
      // Suppressions are not recorded in the send ledger; retain the campaign's
      // explicit opt-out snapshot rather than inventing per-recipient evidence.
      opted_out: number(campaign.opted_out),
    };
  } else {
    metrics = {
      sent: number(campaign.invites_sent),
      delivered: number(campaign.emails_delivered),
      opened: number(campaign.emails_opened),
      clicked: number(campaign.emails_clicked),
      bounced: number(campaign.emails_bounced),
      opted_out: number(campaign.opted_out),
    };
  }
  let observedAt = isLedger ? null : iso(campaign.metrics_refreshed_at);
  if (isLedger) {
    for (const send of acceptedSends) {
      const observed = iso(send.last_synced_at);
      if (observed && (!observedAt || observed > observedAt)) { observedAt = observed; }
    }
  }
  return {
    id: campaign.id,
    name: campaign.campaign_name,
    status: campaign.status,
    type: campaign.type ?? null,
    channel: campaign.channel ?? null,
    audience: campaign.audience?.replace(/;\s*(?:exact send ledger\s+)?SHA256\s+[a-f0-9]{64}\s*$/i, "").trim() || null,
    launched_at: iso(campaign.launched_at),
    last_invite_at: iso(campaign.last_invite_at),
    audience_size: number(campaign.audience_size),
    metrics,
    metrics_basis: isLedger ? "ledger" : "snapshot",
    metrics_observed_at: observedAt,
    recipient_count: sends.length,
    tracking_pending: trackingPending,
  };
}

async function ledgerAvailability(): Promise<Ledger> {
  const [ledger] = await queryPg<Ledger>(`
    select to_regclass('crm_campaign_sends') is not null as available,
           to_regclass('crm_campaign_send_links') is not null as links_available,
           to_regclass('crm_bulk_trade_lots') is not null as listings_available
  `);
  return ledger ?? { available: false, links_available: false, listings_available: false };
}

async function readSends(ids: string[], ledger: Ledger, withRecipients = false): Promise<SendRow[]> {
  if (!ledger.available || !ids.length) { return []; }
  return queryPg<SendRow>(`
    select s.id as send_id, s.campaign_id, s.state, s.accepted_at, s.delivered_at,
           s.bounced_at, s.provider_opened_at, s.provider_link_clicked_at, s.last_synced_at,
           ${ledger.links_available ? `(select min(l.first_clicked_at) from crm_campaign_send_links l where l.send_id = s.id)` : "null::timestamptz"} as link_clicked_at
           ${withRecipients ? `, s.person_id, p.full_name as person_name, coalesce(s.company_id, p.company_id) as company_id,
             company.name as company_name, s.recipient_email, s.listing_id, s.auction_url` : ""}
      from crm_campaign_sends s
      ${withRecipients ? `left join crm_people p on p.id = s.person_id
        left join crm_companies company on company.id = coalesce(s.company_id, p.company_id)` : ""}
     where s.campaign_id = any($1::text[])
     order by s.created_at, s.id
  `, [ids]);
}

/** All campaigns, including historical campaigns whose saved metrics outlive the retained ledger. */
export async function listCampaigns(): Promise<CampaignSummary[]> {
  // Select the physical row and whitelist the DTO below: optional audit columns
  // need not exist on older installations, and no speculative fallback SQL is used.
  const campaigns = await queryPg<CampaignRow>(`
    select c.* from campaigns c
     order by c.launched_at desc nulls last, c.created_at desc, c.id
  `);
  if (!campaigns.length) { return []; }
  const ledger = await ledgerAvailability();
  const sends = await readSends(campaigns.map((campaign) => campaign.id), ledger);
  const byCampaign = new Map<string, SendRow[]>();
  for (const send of sends) {
    const group = byCampaign.get(send.campaign_id) ?? [];
    group.push(send);
    byCampaign.set(send.campaign_id, group);
  }
  return campaigns.map((campaign) => summarize(campaign, byCampaign.get(campaign.id) ?? [], ledger.available));
}

/** Never return a recipient-specific redirect, credential, query string, or fragment. */
export function canonicalListingUrl(raw: string | null | undefined): string | null {
  if (!raw) { return null; }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !["rebattery.io", "www.rebattery.io"].includes(url.hostname)
      || url.username || url.password || (url.port && url.port !== "443")) { return null; }
    // Only known public listing routes qualify, not /t/<token> or other redirects.
    if (!/^\/marketplace\/(?:auctions|listings)\/[^/]+\/?$/.test(url.pathname)) { return null; }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function cachedListingMetadata(
  cached: { title: string | null; auction_slug: string | null }, platformSite: string,
): { title: string | null; url: string | null } {
  // Slugs come from the auction sync cache, never a tracker or inferred listing ID.
  const slug = cached.auction_slug;
  const url = slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug)
    ? canonicalListingUrl(`${platformSite}/marketplace/auctions/${slug}`) : null;
  return { title: cached.title?.trim() || null, url };
}

export async function getCampaignDetail(id: string): Promise<CampaignDetail | null> {
  const [campaign] = await queryPg<CampaignRow>("select c.* from campaigns c where c.id = $1", [id]);
  if (!campaign) { return null; }
  const ledger = await ledgerAvailability();
  const sends = await readSends([id], ledger, true);
  const links = ledger.available && ledger.links_available ? await queryPg<LinkRow>(`
    select l.send_id, l.cta_key, l.listing_id, l.destination_url, l.first_clicked_at
      from crm_campaign_send_links l
      join crm_campaign_sends s on s.id = l.send_id
     where s.campaign_id = $1
     order by l.cta_key, l.id
  `, [id]) : [];
  const listingIds = new Set<string>();
  for (const link of links) { if (link.listing_id) { listingIds.add(link.listing_id); } }
  for (const send of sends) { if (send.listing_id) { listingIds.add(send.listing_id); } }
  const cachedListings = ledger.listings_available && listingIds.size ? await queryPg<{
    listing_id: string; title: string | null; auction_slug: string | null;
  }>(`
    select distinct on (lot.listing_id) lot.listing_id, lot.title, lot.auction_slug
      from crm_bulk_trade_lots lot
     where lot.listing_id = any($1::text[])
     order by lot.listing_id, (nullif(lot.auction_slug, '') is not null) desc,
              lot.updated_at desc nulls last, lot.id
  `, [[...listingIds]]) : [];
  const cachedByListing = new Map<string, { title: string | null; url: string | null }>();
  const platformSite = (process.env.REBATTERY_SITE_URL ?? "https://rebattery.io").replace(/\/$/, "");
  for (const cached of cachedListings) {
    cachedByListing.set(cached.listing_id, cachedListingMetadata(cached, platformSite));
  }
  const linksBySend = new Map<string, LinkRow[]>();
  const otherDestinations = new Map<string, CampaignDetail["other_destinations"][number]>();
  for (const link of links) {
    const group = linksBySend.get(link.send_id) ?? [];
    group.push(link);
    linksBySend.set(link.send_id, group);
    if (!link.listing_id && !otherDestinations.has(link.cta_key)) {
      const label = UUID.test(link.cta_key) ? "General destination" : link.cta_key.replace(/[-_]+/g, " ").trim() || "General destination";
      otherDestinations.set(link.cta_key, { cta_key: link.cta_key, label });
    }
  }
  const listings = new Map<string, {
    listing: CampaignListing;
    included: Set<string>;
    clicked: Set<string>;
  }>();
  const recipients: CampaignRecipient[] = sends.map((send) => {
    const sendLinks = linksBySend.get(send.send_id) ?? [];
    const listingClicks = new Map<string, CampaignRecipient["listing_clicks"][number]>();
    const otherClicks = new Map<string, CampaignRecipient["other_clicks"][number]>();
    // Before per-CTA tracking, a send could have only a primary listing. Never
    // attribute a provider-wide click to it: the clicked destination is unknown.
    const includedLinks: LinkRow[] = sendLinks.length ? sendLinks : send.listing_id ? [{
      send_id: send.send_id,
      cta_key: send.listing_id,
      listing_id: send.listing_id,
      destination_url: send.auction_url ?? "",
      first_clicked_at: null,
    }] : [];
    for (const link of includedLinks) {
      if (!link.listing_id) {
        const click = accepted(send) ? iso(link.first_clicked_at) : null;
        const previous = otherClicks.get(link.cta_key);
        if (click && (!previous || click < previous.first_clicked_at)) {
          otherClicks.set(link.cta_key, { ...otherDestinations.get(link.cta_key)!, first_clicked_at: click });
        }
        continue; // General CTAs are not listing engagement.
      }
      const cached = cachedByListing.get(link.listing_id);
      const url = cached?.url ?? canonicalListingUrl(link.destination_url);
      let labelKey = link.cta_key;
      if (UUID.test(labelKey)) {
        labelKey = url ? new URL(url).pathname.split("/").filter(Boolean).at(-1)! : "Listing";
        if (UUID.test(labelKey)) { labelKey = "Listing"; }
      }
      let aggregate = listings.get(link.listing_id);
      if (!aggregate) {
        aggregate = {
          listing: { listing_id: link.listing_id, label: cached?.title || labelKey.replace(/[-_]+/g, " ").trim() || "Listing", url, recipients: 0, clicked_recipients: 0 },
          included: new Set(), clicked: new Set(),
        };
        listings.set(link.listing_id, aggregate);
      } else if (!aggregate.listing.url && url) {
        aggregate.listing.url = url;
      }
      aggregate.included.add(send.send_id);
      const click = accepted(send) ? iso(link.first_clicked_at) : null;
      if (!click) { continue; }
      const previous = listingClicks.get(link.listing_id);
      if (!previous || click < previous.first_clicked_at) {
        listingClicks.set(link.listing_id, { listing_id: link.listing_id, label: aggregate.listing.label, first_clicked_at: click });
      }
      aggregate.clicked.add(send.send_id);
    }
    // Also derive from loaded links, so link-only clicks are not lost if the
    // provider's aggregate timestamp is absent or later than a recorded CTA.
    const firstClick = earliest(send.provider_link_clicked_at, send.link_clicked_at, ...sendLinks.map((link) => link.first_clicked_at));
    send.link_clicked_at = firstClick;
    return {
      send_id: send.send_id,
      person_id: send.person_id!,
      person_name: send.person_name ?? null,
      company_id: send.company_id ?? null,
      company_name: send.company_name ?? null,
      recipient_email: send.recipient_email!,
      state: send.state,
      accepted_at: iso(send.accepted_at),
      delivered_at: iso(send.delivered_at),
      bounced_at: iso(send.bounced_at),
      opened_at: iso(send.provider_opened_at),
      clicked_at: firstClick,
      last_synced_at: iso(send.last_synced_at),
      tracking_pending: pending(send),
      listing_clicks: [...listingClicks.values()].toSorted((a, b) => a.label.localeCompare(b.label)),
      other_clicks: [...otherClicks.values()].toSorted((a, b) => a.label.localeCompare(b.label)),
    };
  });
  return {
    campaign: summarize(campaign, sends, ledger.available),
    recipients,
    other_destinations: [...otherDestinations.values()].toSorted((a, b) => a.label.localeCompare(b.label)),
    listings: [...listings.values()].map(({ listing, included, clicked }) => ({
      ...listing,
      recipients: included.size,
      clicked_recipients: clicked.size,
    })).toSorted((a, b) => a.label.localeCompare(b.label)),
    details: {
      auction_slug: campaign.auction_slug ?? null,
      source_system: campaign.source_system ?? null,
      audience_raw: campaign.audience ?? null,
      notes: campaign.notes ?? null,
      created_at: iso(campaign.created_at),
      updated_at: iso(campaign.updated_at),
      objective: campaign.objective ?? null,
      success_measure: campaign.success_measure ?? null,
      message_version: campaign.message_version ?? null,
      stock_snapshot_ref: campaign.stock_snapshot_ref ?? null,
      sender_identity: campaign.sender_identity ?? null,
      reply_owner: campaign.reply_owner ?? null,
      reply_mailbox: campaign.reply_mailbox ?? null,
      approved_manifest_sha256: campaign.approved_manifest_sha256 ?? null,
      approved_by: campaign.approved_by ?? null,
      approved_at: iso(campaign.approved_at),
      reviewed_at: iso(campaign.reviewed_at),
    },
  };
}
