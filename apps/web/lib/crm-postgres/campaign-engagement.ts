import { queryPg } from "../postgres";
import { campaignReplyAtSql } from "./mail-replies";

export const OPEN_SESSION_GAP_MS = 10 * 60 * 1000;
export const SCANNER_WINDOW_MS = 5 * 1000;

export type EngagementEvent = {
  type: string;
  provider_event_id?: string | null;
  source?: string;
  occurred_at: string;
  detail: Record<string, unknown>;
};
export type EngagementMessage = {
  id: string;
  person_id: string | null;
  person_name: string | null;
  company_name: string | null;
  recipient_email: string;
  sent_at: string | null;
  delivered_at: string | null;
  replied: boolean;
  links: string[];
  events: EngagementEvent[];
};
export type CampaignEngagement = {
  recipient_key: string;
  person_id: string | null;
  person_name: string | null;
  company_name: string | null;
  recipient_email: string;
  total_opens: number;
  flagged_opens: number;
  return_sessions: number;
  last_opened: string | null;
  first_opened: string | null;
  days_to_first_open: number | null;
  late_opener: boolean;
  human_links_clicked: number;
  flagged_clicks: number;
  replied: boolean;
  likely_bot: boolean;
};

export function countOpenSessions(times: number[]): number {
  const sorted = [...times].toSorted((a, b) => a - b);
  return sorted.reduce((count, time, index) =>
    count + (index === 0 || time - sorted[index - 1] > OPEN_SESSION_GAP_MS ? 1 : 0), 0);
}

// A normal AppleWebKit/iPhone UA is not evidence of Mail Privacy Protection.
export function isProxyOrScanner(detail: Record<string, unknown>): boolean {
  if (["proxy", "proxy_evidence", "scanner", "scanner_evidence"].some((key) => detail[key] === true)) {
    return true;
  }
  const details = detail.Details as Record<string, unknown> | undefined;
  const client = detail.Client as Record<string, unknown> | undefined;
  const os = detail.OS as Record<string, unknown> | string | undefined;
  const signatures = /apple\s*mail\s*privacy|mail privacy protection|\bMPP\b|GoogleImageProxy|google image proxy|ggpht\.com|proofpoint|mimecast|barracuda|safelinks|urlscan|scanner|headless|\bbot\b|spider|crawler/i;
  return [details?.Summary, detail.UserAgent, client?.Name, detail.Platform, typeof os === "string" ? os : os?.Name]
    .some((value) => typeof value === "string" && signatures.test(value));
}

function dedupeMessageEvents(events: EngagementEvent[]): EngagementEvent[] {
  const webhook = (event: EngagementEvent) => event.source === "postmark-webhook" || event.detail.RecordType === "Open";
  const matched = new Set<EngagementEvent>();
  // Pair API first opens with webhook first opens, never collapse webhook repeats.
  const providerEvents = events.filter((event) => !event.provider_event_id?.startsWith("legacy:"));
  for (const api of providerEvents) {
    if (api.type !== "opened" || webhook(api)) {continue;}
    const equivalent = providerEvents.find((candidate) => !matched.has(candidate) &&
      candidate.type === "opened" && webhook(candidate) && candidate.detail.FirstOpen !== false &&
      Math.abs(Date.parse(candidate.occurred_at) - Date.parse(api.occurred_at)) <= 1000);
    if (equivalent) { matched.add(equivalent); matched.add(api); }
  }
  return events.filter((event) => {
    if (event.provider_event_id?.startsWith("legacy:")) {
      return !providerEvents.some((real) => real.type === event.type &&
        Math.abs(Date.parse(real.occurred_at) - Date.parse(event.occurred_at)) <= 1000);
    }
    return !matched.has(event) || webhook(event);
  });
}

function clickedLink(event: EngagementEvent): string | null {
  const details = event.detail.Details as Record<string, unknown> | undefined;
  const link = details?.Link ?? event.detail.OriginalLink ?? event.detail.Link;
  return typeof link === "string" && link.length > 0 ? link : null;
}

/** Pure observation projection. Session totals retain flagged observations. */
export function rankCampaignEngagement(messages: EngagementMessage[]): CampaignEngagement[] {
  const recipients = new Map<string, {
    row: CampaignEngagement; opens: number[]; humanLinks: Set<string>; activity: number; flagged: number;
  }>();
  for (const source of messages) {
    const message = { ...source, events: dedupeMessageEvents(source.events) };
    const key = message.person_id || message.recipient_email.toLowerCase() || message.id;
    let recipient = recipients.get(key);
    if (!recipient) {
      recipient = { row: {
        recipient_key: key, person_id: message.person_id, person_name: message.person_name,
        company_name: message.company_name, recipient_email: message.recipient_email,
        total_opens: 0, flagged_opens: 0, return_sessions: 0, last_opened: null,
        first_opened: null, days_to_first_open: null, late_opener: false,
        human_links_clicked: 0, flagged_clicks: 0, replied: false, likely_bot: false,
      }, opens: [], humanLinks: new Set(), activity: 0, flagged: 0 };
      recipients.set(key, recipient);
    }
    const { row } = recipient;
    row.replied ||= message.replied || message.events.some((event) => event.type === "replied");
    const clicks = message.events.filter((event) => event.type === "clicked")
      .toSorted((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    const burstClicks = new Set<EngagementEvent>();
    const tracked = new Set(message.links);
    for (let start = 0; start < clicks.length; start++) {
      const window: EngagementEvent[] = [];
      for (let end = start; end < clicks.length &&
        Date.parse(clicks[end].occurred_at) - Date.parse(clicks[start].occurred_at) <= SCANNER_WINDOW_MS; end++) {
        window.push(clicks[end]);
      }
      const urls = new Set(window.map(clickedLink).filter((url): url is string => url !== null));
      // Three simultaneous destinations also catch incomplete provider link inventories.
      if (urls.size >= 3 || (tracked.size >= 2 && [...tracked].every((url) => urls.has(url)))) {
        window.forEach((event) => burstClicks.add(event));
      }
    }
    const deliveries = message.events.filter((event) => event.type === "delivered")
      .map((event) => Date.parse(event.occurred_at));
    if (message.delivered_at) {deliveries.push(Date.parse(message.delivered_at));}
    const flaggedClicks = clicks.filter((event) => isProxyOrScanner(event.detail) || burstClicks.has(event) ||
      deliveries.some((time) => {
        const delta = Date.parse(event.occurred_at) - time;
        return delta >= 0 && delta <= SCANNER_WINDOW_MS;
      }));
    const flaggedSet = new Set(flaggedClicks);
    row.flagged_clicks += flaggedClicks.length;
    recipient.activity += clicks.length;
    recipient.flagged += flaggedClicks.length;
    for (const click of clicks) {
      const url = clickedLink(click);
      if (!flaggedSet.has(click) && url) {recipient.humanLinks.add(url);}
    }
    const opens = message.events.filter((event) => event.type === "opened");
    for (const open of opens) {
      row.total_opens++;
      recipient.activity++;
      const time = Date.parse(open.occurred_at);
      if (!row.first_opened || time < Date.parse(row.first_opened)) {
        row.first_opened = open.occurred_at;
        const sent = message.sent_at ? Date.parse(message.sent_at) : NaN;
        row.days_to_first_open = Number.isFinite(sent) && time >= sent ? (time - sent) / 86_400_000 : null;
        row.late_opener = row.days_to_first_open !== null && row.days_to_first_open > 1;
      }
      if (!row.last_opened || time > Date.parse(row.last_opened)) {row.last_opened = open.occurred_at;}
      // A lone open accompanying only a scanner burst is not independent human evidence.
      const flagged = isProxyOrScanner(open.detail) ||
        (opens.length === 1 && burstClicks.size > 0 && flaggedClicks.length === clicks.length);
      if (flagged) { row.flagged_opens++; recipient.flagged++; }
      recipient.opens.push(time);
    }
  }
  return [...recipients.values()].map(({ row, opens, humanLinks, activity, flagged }) => ({
    ...row, return_sessions: Math.max(0, countOpenSessions(opens) - 1),
    human_links_clicked: humanLinks.size, likely_bot: activity > 0 && activity === flagged,
  })).toSorted(compareCampaignEngagement);
}

export function compareCampaignEngagement(a: CampaignEngagement, b: CampaignEngagement): number {
  return b.return_sessions - a.return_sessions || b.human_links_clicked - a.human_links_clicked ||
    a.recipient_key.localeCompare(b.recipient_key);
}

export const CAMPAIGN_ENGAGEMENT_SQL = `
  select m.id, m.person_id, p.full_name as person_name, c.name as company_name,
         coalesce(m.recipient_email, m.to_emails[1], '') as recipient_email,
         m.sent_at, m.delivered_at, (${campaignReplyAtSql("m")} is not null) as replied,
         coalesce((select jsonb_agg(distinct l.destination_url) from mail_message_link l
                   where l.message_id = m.id), '[]'::jsonb) as links,
         coalesce((select jsonb_agg(jsonb_build_object('type', e.type,
                    'occurred_at', e.occurred_at, 'detail', e.detail, 'provider_event_id', e.provider_event_id, 'source', e.source) order by e.occurred_at, e.id)
                   from mail_event e where e.message_id = m.id
                     and e.type in ('opened', 'clicked', 'delivered', 'replied')), '[]'::jsonb) as events
    from mail_message m
    left join crm_people p on p.id = m.person_id
    left join crm_companies c on c.id = coalesce(m.company_id, p.company_id)
   where m.campaign_id = $1 and m.direction = 'outbound'
`;

export async function readCampaignEngagement(campaignId: string): Promise<CampaignEngagement[]> {
  return rankCampaignEngagement(await queryPg<EngagementMessage>(CAMPAIGN_ENGAGEMENT_SQL, [campaignId]));
}
