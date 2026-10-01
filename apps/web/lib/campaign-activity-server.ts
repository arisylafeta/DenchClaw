import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CampaignActivity, CampaignActivityCounts, CampaignActivityDestination, CampaignActivityPerson, CampaignActivityTotals } from "./campaign-activity";
import type { CampaignActivityLedger, CampaignActivityLedgerLink } from "./crm-postgres/campaign-activity";
import type { CampaignPostHogEvent } from "./campaign-posthog";
import { readCampaignActivityLedger } from "./crm-postgres/campaign-activity";
import { CampaignPostHogError, queryCampaignPostHog } from "./campaign-posthog";

type Attribution = CampaignActivityLedgerLink & { link_id: string };
class ManifestError extends Error {}

function counts(): CampaignActivityCounts {
  return { redirect_events: 0, page_views: 0, sessions: 0, offer_events: 0, message_events: 0, buy_now_events: 0 };
}

function totals(): CampaignActivityTotals {
  return { ...counts(), redirect_recipients: 0, visited_recipients: 0, offer_recipients: 0, message_recipients: 0, buy_now_recipients: 0 };
}

function iso(value: string | Date | null): string | null {
  if (!value) { return null; }
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

async function readManifest(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4_000_000) { throw new ManifestError(); }
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

async function findManifest(campaignId: string): Promise<unknown> {
  const explicit = process.env.CRM_CAMPAIGN_MANIFEST_PATH;
  if (explicit) {
    try { return await readManifest(explicit); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { return null; }
      throw new ManifestError();
    }
  }
  const root = process.env.CRM_CAMPAIGN_MANIFEST_DIR ?? join(homedir(), ".hermes", "workspace", "campaigns");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { return null; }
    throw new ManifestError();
  }
  if (entries.length > 256) { throw new ManifestError(); }
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && /send-manifest.*\.json$/.test(entry.name)) { paths.push(join(root, entry.name)); }
    if (!entry.isDirectory()) { continue; }
    const children = await readdir(join(root, entry.name), { withFileTypes: true });
    if (children.length > 256) { throw new ManifestError(); }
    for (const child of children) {
      if (child.isFile() && /send-manifest.*\.json$/.test(child.name)) { paths.push(join(root, entry.name, child.name)); }
    }
  }
  if (paths.length > 256) { throw new ManifestError(); }
  let matched: unknown = null;
  for (const path of paths) {
    const value = await readManifest(path);
    if (value && typeof value === "object" && (value as Record<string, unknown>).campaign_id === campaignId) {
      if (matched) { throw new ManifestError(); }
      matched = value;
    }
  }
  return matched;
}

/** Join both private identity fields, never URLs, against the accepted retained cohort. */
export function mapCampaignManifest(manifest: unknown, ledger: CampaignActivityLedger): Attribution[] {
  if (!manifest || typeof manifest !== "object") { throw new ManifestError(); }
  const value = manifest as Record<string, unknown>;
  if (value.campaign_id !== ledger.campaign_id || !Array.isArray(value.recipients)
    || !value.recipients.length || value.recipients.length > 10_000) { throw new ManifestError(); }
  const cohort = new Map<string, { email: string; links: CampaignActivityLedgerLink[] }>();
  const cohortEmails = new Map<string, string>();
  for (const link of ledger.links) {
    const email = link.recipient_email.trim().toLowerCase();
    const prior = cohort.get(link.person_id);
    if (prior && prior.email !== email || cohortEmails.has(email) && cohortEmails.get(email) !== link.person_id) {
      throw new ManifestError();
    }
    if (prior) { prior.links.push(link); }
    else { cohort.set(link.person_id, { email, links: [link] }); }
    cohortEmails.set(email, link.person_id);
  }
  const identities = new Set<string>();
  const emails = new Set<string>();
  const opaqueIds = new Set<string>();
  const attribution: Attribution[] = [];
  for (const recipient of value.recipients) {
    if (!recipient || typeof recipient !== "object" || typeof recipient.person_id !== "string" || !recipient.person_id
      || recipient.person_id.length > 128 || typeof recipient.email !== "string" || !recipient.email.trim()
      || !recipient.links || typeof recipient.links !== "object" || Array.isArray(recipient.links)) { throw new ManifestError(); }
    const email = recipient.email.trim().toLowerCase();
    if (identities.has(recipient.person_id) || emails.has(email)) { throw new ManifestError(); }
    identities.add(recipient.person_id);
    emails.add(email);
    const retained = cohort.get(recipient.person_id);
    if (retained && retained.email !== email || cohortEmails.has(email) && cohortEmails.get(email) !== recipient.person_id) {
      throw new ManifestError();
    }
    for (const [cta, record] of Object.entries(recipient.links)) {
      if (cta === "sourcing_form") { continue; }
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cta) || !record || typeof record !== "object"
        || !("link_id" in record) || typeof record.link_id !== "string" || !/^[a-f0-9]{32}$/.test(record.link_id)
        || opaqueIds.has(record.link_id)) { throw new ManifestError(); }
      opaqueIds.add(record.link_id);
      if (!retained) { continue; }
      const matching = retained.links.filter((link) => link.cta_key === cta);
      if (matching.length > 1) { throw new ManifestError(); }
      if (matching[0]) { attribution.push({ ...matching[0], link_id: record.link_id }); }
    }
  }
  return attribution;
}

/** Sessions and recipients are set unions, not sums of per-link group counts. */
export function aggregateCampaignActivity(attribution: Attribution[], events: CampaignPostHogEvent[]): {
  totals: CampaignActivityTotals; destinations: CampaignActivityDestination[];
} {
  const result = totals();
  const byLink = new Map(attribution.map((link) => [link.link_id, link]));
  const destinations = new Map<string, CampaignActivityDestination>();
  const globalPeople = new Map<string, CampaignActivityPerson>();
  const destinationPeople = new Map<string, Map<string, CampaignActivityPerson>>();
  const sessionSets = new Map<CampaignActivityCounts, Set<string>>();
  sessionSets.set(result, new Set());
  for (const link of attribution) {
    let destination = destinations.get(link.cta_key);
    if (destination && destination.listing_id !== link.listing_id) { throw new ManifestError(); }
    if (!destination) {
      destination = { ...totals(), cta_key: link.cta_key, listing_id: link.listing_id,
        label: link.label?.trim() || (link.cta_key === "grid" ? "All auctions" : link.cta_key.replace(/[_-]+/g, " ")),
        recipient_count: 0, email_clicked_recipients: 0, people: [] };
      destinations.set(link.cta_key, destination);
      destinationPeople.set(link.cta_key, new Map());
      sessionSets.set(destination, new Set());
    }
    const people = destinationPeople.get(link.cta_key)!;
    const clickAt = iso(link.first_clicked_at);
    let person = people.get(link.person_id);
    if (!person) {
      person = { ...counts(), person_id: link.person_id, email_clicked_at: clickAt,
        last_clicked_at: null, first_browser_at: null, last_browser_at: null, last_offer_at: null, last_message_at: null, last_buy_now_at: null };
      people.set(link.person_id, person);
      sessionSets.set(person, new Set());
    } else if (clickAt && (!person.email_clicked_at || clickAt < person.email_clicked_at)) { person.email_clicked_at = clickAt; }
    if (!globalPeople.has(link.person_id)) {
      const global = { ...counts(), person_id: link.person_id, email_clicked_at: null,
        last_clicked_at: null, first_browser_at: null, last_browser_at: null, last_offer_at: null, last_message_at: null, last_buy_now_at: null };
      globalPeople.set(link.person_id, global);
      sessionSets.set(global, new Set());
    }
  }
  for (const event of events) {
    const link = byLink.get(event.link_id);
    if (!link) { throw new ManifestError(); }
    const destination = destinations.get(link.cta_key)!;
    const person = destinationPeople.get(link.cta_key)!.get(link.person_id)!;
    const global = globalPeople.get(link.person_id)!;
    const metric: "redirect_events" | "page_views" | "offer_events" | "message_events" | "buy_now_events" =
      event.event === "campaign_link_clicked" ? "redirect_events" : event.event === "campaign_page_viewed" ? "page_views"
        : event.submission_kind === "offer" ? "offer_events" : event.submission_kind === "message" ? "message_events" : "buy_now_events";
    for (const aggregate of [result, destination, person, global]) {
      aggregate[metric] += event.event_count;
      if (event.event === "campaign_page_viewed" && event.session_id) { sessionSets.get(aggregate)!.add(event.session_id); }
    }
    if (event.event === "campaign_link_clicked") {
      for (const recipient of [person, global]) {
        if (!recipient.last_clicked_at || event.last_at > recipient.last_clicked_at) { recipient.last_clicked_at = event.last_at; }
      }
    } else if (event.event === "campaign_page_viewed") {
      for (const recipient of [person, global]) {
        if (!recipient.first_browser_at || event.first_at < recipient.first_browser_at) { recipient.first_browser_at = event.first_at; }
        if (!recipient.last_browser_at || event.last_at > recipient.last_browser_at) { recipient.last_browser_at = event.last_at; }
      }
    } else if (event.event === "public_auction_submission_created") {
      const timestamp: "last_offer_at" | "last_message_at" | "last_buy_now_at" =
        event.submission_kind === "offer" ? "last_offer_at" : event.submission_kind === "message" ? "last_message_at" : "last_buy_now_at";
      for (const recipient of [person, global]) {
        if (!recipient[timestamp] || event.last_at > recipient[timestamp]) { recipient[timestamp] = event.last_at; }
      }
    }
  }
  for (const [aggregate, sessions] of sessionSets) { aggregate.sessions = sessions.size; }
  for (const [key, destination] of destinations) {
    destination.people = [...destinationPeople.get(key)!.values()];
    destination.recipient_count = destination.people.length;
    destination.email_clicked_recipients = destination.people.filter((person) => person.email_clicked_at).length;
  }
  const recipientGroups: Array<readonly [CampaignActivityTotals, CampaignActivityPerson[]]> = [[result, [...globalPeople.values()]]];
  for (const destination of destinations.values()) { recipientGroups.push([destination, destination.people]); }
  for (const [aggregate, people] of recipientGroups) {
    for (const person of people) {
      if (person.redirect_events) { aggregate.redirect_recipients++; }
      if (person.page_views > 0) { aggregate.visited_recipients++; }
      if (person.offer_events) { aggregate.offer_recipients++; }
      if (person.message_events) { aggregate.message_recipients++; }
      if (person.buy_now_events) { aggregate.buy_now_recipients++; }
    }
  }
  return { totals: result, destinations: [...destinations.values()] };
}

export async function getCampaignActivity(id: string): Promise<CampaignActivity | null> {
  const ledger = await readCampaignActivityLedger(id);
  if (!ledger) { return null; }
  const response: CampaignActivity = { campaign_id: id, status: "unmapped", unavailable_reason: null,
    observed_at: null, period_start: iso(ledger.sent_at), period_end: null, totals: null, destinations: [] };
  const now = Date.now();
  if (!response.period_start || Date.parse(response.period_start) > now) {
    response.unavailable_reason = "campaign_not_tracked";
    return response;
  }
  response.period_end = new Date(Math.min(now, Date.parse(response.period_start) + 30 * 86_400_000)).toISOString();
  try {
    const manifest = await findManifest(id);
    if (!manifest) { response.unavailable_reason = "manifest_missing"; return response; }
    const attribution = mapCampaignManifest(manifest, ledger);
    if (!attribution.length) { response.unavailable_reason = "campaign_not_tracked"; return response; }
    const receipt = await queryCampaignPostHog(id, attribution.map((link) => link.link_id), response.period_start, response.period_end);
    const aggregate = aggregateCampaignActivity(attribution, receipt.events);
    return { ...response, ...aggregate, status: "available", unavailable_reason: null, observed_at: receipt.observed_at };
  } catch (error) {
    response.status = "unavailable";
    response.unavailable_reason = error instanceof CampaignPostHogError ? error.reason : "manifest_invalid";
    return response;
  }
}
