import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CampaignPostHogEvent = {
  link_id: string;
  event: "campaign_link_clicked" | "campaign_page_viewed" | "public_auction_submission_created";
  submission_kind: "offer" | "message" | "buy_now" | null;
  session_id: string | null;
  event_count: number;
  first_at: string;
  last_at: string;
};

export class CampaignPostHogError extends Error {
  readonly reason: "credentials_missing" | "provider_unavailable" | "provider_incomplete";
  constructor(reason: "credentials_missing" | "provider_unavailable" | "provider_incomplete") {
    super(reason);
    this.reason = reason;
  }
}

const ROW_LIMIT = 50_000;
const COLUMNS = ["link_id", "event", "submission_kind", "session_id", "event_count", "first_at", "last_at"];

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) { return null; }
  // HogQL's DateTime serialization is UTC but may omit the timezone suffix.
  const time = Date.parse(value.replace(" ", "T") + (/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? "" : "Z"));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Decode a complete bounded receipt; never turn truncated/invalid evidence into zero. */
export function decodeCampaignPostHogReceipt(
  payload: unknown, linkIds: ReadonlySet<string>, start: string, end: string,
  receiptDate: string | null, requestedAt: number, receivedAt: number,
): { events: CampaignPostHogEvent[]; observed_at: string } {
  if (!payload || typeof payload !== "object") { throw new CampaignPostHogError("provider_incomplete"); }
  const body = payload as Record<string, unknown>;
  // Explicit HogQL LIMIT returns null pagination metadata; hitting the row cap still fails closed.
  if (body.error != null || body.query_status === "pending"
    || (body.hasMore != null && body.hasMore !== false)
    || !Array.isArray(body.results) || body.results.length >= ROW_LIMIT
    || !Array.isArray(body.columns) || body.columns.join("|") !== COLUMNS.join("|")) {
    throw new CampaignPostHogError("provider_incomplete");
  }
  let observed = timestamp(body.last_refresh);
  if (body.last_refresh != null && !observed) { throw new CampaignPostHogError("provider_incomplete"); }
  if (!observed && receiptDate) {
    const time = Date.parse(receiptDate);
    if (Number.isFinite(time) && time >= requestedAt - 300_000 && time <= receivedAt + 60_000) {
      observed = new Date(time).toISOString();
    }
  }
  if (!observed || Date.parse(observed) > receivedAt + 60_000 || observed < start) {
    throw new CampaignPostHogError("provider_incomplete");
  }
  const events: CampaignPostHogEvent[] = [];
  for (const row of body.results) {
    if (!Array.isArray(row) || row.length !== COLUMNS.length) { throw new CampaignPostHogError("provider_incomplete"); }
    const [link, event, kind, session, count, first, last] = row;
    const firstAt = timestamp(first);
    const lastAt = timestamp(last);
    if (typeof link !== "string" || !linkIds.has(link)
      || !["campaign_link_clicked", "campaign_page_viewed", "public_auction_submission_created"].includes(event)
      || (event === "public_auction_submission_created" ? !["offer", "message", "buy_now"].includes(kind) : kind !== null && kind !== "")
      || (session !== null && session !== "" && (typeof session !== "string" || session.length > 256))
      || !Number.isSafeInteger(count) || count <= 0 || !firstAt || !lastAt
      || firstAt < start || lastAt >= end || lastAt < firstAt) {
      throw new CampaignPostHogError("provider_incomplete");
    }
    events.push({ link_id: link, event, submission_kind: kind || null, session_id: session || null,
      event_count: count, first_at: firstAt, last_at: lastAt });
  }
  return { events, observed_at: observed };
}

/** Only opaque random attribution IDs cross this boundary; never recipient identities or URLs. */
export async function queryCampaignPostHog(campaignId: string, linkIds: string[], start: string, end: string) {
  let credentials: { host: string; token: string };
  try {
    const path = process.env.CRM_POSTHOG_CREDENTIALS_PATH ?? join(homedir(), ".posthog", "credentials.json");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 65_536) { throw new Error("insecure"); }
      const value = JSON.parse(await file.readFile("utf8"));
      if (!["https://us.posthog.com", "https://eu.posthog.com"].includes(value.host)
        || String(value.env_id) !== "375247" || typeof value.token !== "string" || !value.token.trim()
        || /[\r\n]/.test(value.token)) { throw new Error("invalid"); }
      credentials = { host: value.host, token: value.token };
    } finally { await file.close(); }
  } catch { throw new CampaignPostHogError("credentials_missing"); }
  if (!linkIds.length || linkIds.length > 10_000 || linkIds.some((id) => !/^[a-f0-9]{32}$/.test(id))) {
    throw new CampaignPostHogError("provider_incomplete");
  }
  const campaignLiteral = campaignId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = `select toString(properties.campaign_link_id) as link_id, event,
    nullIf(toString(properties.submission_kind), '') as submission_kind,
    nullIf(toString(properties.$session_id), '') as session_id,
    count() as event_count, min(timestamp) as first_at, max(timestamp) as last_at
    from events
    where event in ('campaign_link_clicked', 'campaign_page_viewed', 'public_auction_submission_created')
      and properties.campaign_link_id in (${linkIds.map((id) => `'${id}'`).join(",")})
      and (event != 'campaign_link_clicked' or properties.campaign = '${campaignLiteral}')
      and timestamp >= toDateTime('${start}') and timestamp < toDateTime('${end}')
      and {filters}
    group by link_id, event, submission_kind, session_id
    limit ${ROW_LIMIT}`;
  const requestedAt = Date.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${credentials.host}/api/projects/375247/query/`, {
      method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", filters: { filterTestAccounts: true }, query } }),
    });
    if (!response.ok) { throw new CampaignPostHogError("provider_unavailable"); }
    return decodeCampaignPostHogReceipt(await response.json(), new Set(linkIds), start, end,
      response.headers.get("date"), requestedAt, Date.now());
  } catch (error) {
    if (error instanceof CampaignPostHogError) { throw error; }
    throw new CampaignPostHogError("provider_unavailable");
  } finally { clearTimeout(deadline); }
}
