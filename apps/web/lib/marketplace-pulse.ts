// Marketplace Pulse: the weekly marketplace numbers, their targets, and buyers to follow up.
// The numbers are written by scripts/rebattery/marketplace_pulse_collect.py; weeks start Monday, UTC.

export type MetricKey =
  | "visitors" | "browsed" | "clicked_listing" | "viewed_listing" | "started_contact" | "sent_contact"
  | "deals_created" | "deals_paid" | "paid_value_gbp" | "deals_cancelled"
  | "offers_made" | "buyer_chats" | "auction_bids"
  | "listings_live" | "listings_new" | "sell_requests" | "joules_started";

type Metric = { label: string; hint: string; money?: boolean; lowerIsBetter?: boolean };

export const METRICS: Record<MetricKey, Metric> = {
  visitors: { label: "Visitors", hint: "people who saw the marketplace or a listing" },
  browsed: { label: "Browsed", hint: "people on the marketplace page" },
  clicked_listing: { label: "Clicked a listing", hint: "people who clicked a listing card" },
  viewed_listing: { label: "Viewed a listing", hint: "people on a listing page" },
  started_contact: { label: "Started a message, offer or buy", hint: "people who started one" },
  sent_contact: { label: "Sent it", hint: "people whose message, offer or buy went through" },
  deals_created: { label: "Deals", hint: "deals created, test buyers left out" },
  deals_paid: { label: "Paid", hint: "deals whose first payment was captured" },
  paid_value_gbp: { label: "Paid value", hint: "what paid deals sold for, about £", money: true },
  deals_cancelled: { label: "Cancelled deals", hint: "deals cancelled that week", lowerIsBetter: true },
  offers_made: { label: "Offers", hint: "offers made on listings" },
  buyer_chats: { label: "Buyer chats", hint: "new purchase conversations" },
  auction_bids: { label: "Auction bids", hint: "offers and buy-nows on auctions" },
  listings_live: { label: "Live listings", hint: "published now" },
  listings_new: { label: "New listings", hint: "listings added that week" },
  sell_requests: { label: "Joules sell requests", hint: "saved by Joules, tests left out" },
  joules_started: { label: "Joules chats", hint: "people who started Joules" },
};

/** The headline numbers, in order. */
export const SCORECARD: MetricKey[] = [
  "visitors", "viewed_listing", "started_contact", "sent_contact", "deals_created", "deals_paid", "paid_value_gbp", "listings_live",
];

/** Visitor to paid deal. Steps are counted separately each week, so a later step can exceed an earlier one. */
export const FUNNEL: MetricKey[] = ["visitors", "viewed_listing", "started_contact", "sent_contact", "deals_created", "deals_paid"];

/** Shown in the weekly history under the headline numbers. */
export const OTHER_METRICS: MetricKey[] = [
  "browsed", "clicked_listing", "offers_made", "buyer_chats", "auction_bids", "deals_cancelled", "listings_new", "sell_requests", "joules_started",
];

export const isMetricKey = (value: unknown): value is MetricKey => typeof value === "string" && value in METRICS;

export type PulseWeek = { week_start: string; values: Partial<Record<MetricKey, number>> };

export type FollowUpSignal = {
  kind: "deal" | "offer" | "chat" | "auction";
  text: string;
  listing_title: string | null;
  listing_url: string | null;
  at: string;
};

export type ListingLink = { title: string; url: string };

export type FollowUp = {
  key: string;
  name: string;
  email: string | null;
  person_id: string | null;
  first_name: string | null;
  /** On the Supply update list. */
  subscribed: boolean;
  last_contact: string | null;
  contacted_since: boolean;
  latest: FollowUpSignal;
  more: number;
  /** Up to three live listings like the one in the latest signal. */
  similar: ListingLink[];
};

/** Something only we can move: an offer the seller has not answered, or an accepted deal left unpaid. */
export type WaitingItem = {
  kind: "offer" | "deal";
  text: string;
  buyer: string;
  seller: string | null;
  listing_title: string | null;
  listing_url: string | null;
  at: string;
  /** When the offer expires; null for deals. */
  expires_at: string | null;
};

export type PulseData = {
  weeks: PulseWeek[];
  targets: Partial<Record<MetricKey, number>>;
  collected_at: string | null;
  follow_ups: FollowUp[];
  waiting: WaitingItem[];
  follow_up_error: string | null;
  /** First name of the signed-in user, for signing drafts. */
  sender: string;
};

const OPENERS: Record<FollowUpSignal["kind"], (title: string) => string> = {
  deal: (title) => `I saw your order for the ${title} on ReBattery didn't go through to payment.`,
  offer: (title) => `I saw your offer on the ${title} on ReBattery didn't get an answer in time.`,
  chat: (title) => `I saw you messaged about the ${title} on ReBattery.`,
  auction: (title) => `Thanks for your bid on the ${title} auction on ReBattery.`,
};

/** A short Gmail draft for a follow-up: one line on what they did, similar listings, one ask. */
export function draftFor(f: FollowUp, sender: string): { to: string; subject: string; body: string } {
  const title = f.latest.listing_title ?? "listing";
  const lines = [`Hi ${f.first_name ?? "[first name]"},`, "", OPENERS[f.latest.kind](title)];
  if (f.latest.listing_url) lines.push(f.latest.listing_url);
  if (f.similar.length) {
    lines.push("", f.similar.length === 1 ? "We also have this one, in case it fits:" : "We also have these, in case they fit:");
    for (const listing of f.similar) lines.push(`${listing.title} - ${listing.url}`);
  }
  lines.push("", "Is it still of interest?", "", sender);
  return { to: f.email ?? "", subject: title, body: lines.join("\n") };
}

export type FunnelStep = { key: MetricKey; value: number; rate: number | null };

/** Adds up weekly values, so people are counted once per week. Missing values count as 0. */
export function totals(weeks: PulseWeek[], keys: MetricKey[]): Record<MetricKey, number> {
  const out = {} as Record<MetricKey, number>;
  for (const key of keys) out[key] = weeks.reduce((sum, week) => sum + (week.values[key] ?? 0), 0);
  return out;
}

/** Funnel steps with the rate from the step before, and the index of the weakest rate. */
export function funnel(values: Partial<Record<MetricKey, number>>): { steps: FunnelStep[]; weakest: number | null } {
  const steps = FUNNEL.map((key, index) => {
    const value = values[key] ?? 0;
    const before = index ? values[FUNNEL[index - 1]] ?? 0 : 0;
    return { key, value, rate: index && before > 0 ? value / before : null };
  });
  let weakest: number | null = null;
  steps.forEach((step, index) => {
    if (step.rate !== null && (weakest === null || step.rate < steps[weakest].rate!)) weakest = index;
  });
  return { steps, weakest };
}

/** "+12%" against last week, or null when there is nothing to compare. */
export function change(current: number | undefined, previous: number | undefined): string | null {
  if (current === undefined || previous === undefined) return null;
  if (previous === 0) return current === 0 ? "±0" : "new";
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct > 0 ? "+" : pct === 0 ? "±" : ""}${pct}%`;
}

export function formatMetric(key: MetricKey, value: number | undefined): string {
  if (value === undefined || value === null) return "–";
  if (METRICS[key].money) return `£${Math.round(value).toLocaleString("en-GB")}`;
  return Math.round(value).toLocaleString("en-GB");
}

/** "6 Oct" for a week's Monday. */
export function weekLabel(weekStart: string): string {
  return new Date(`${weekStart}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** The Monday (UTC) of the week a moment falls in, as YYYY-MM-DD. */
export function mondayOf(moment: Date): string {
  const day = new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}
