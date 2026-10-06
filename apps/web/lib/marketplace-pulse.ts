// Marketplace Pulse: the weekly marketplace numbers, their targets, and buyers to follow up.
// The numbers are written by scripts/rebattery/marketplace_pulse_collect.py; weeks start Monday, UTC.

export type MetricKey =
  | "visitors" | "browsed" | "clicked_listing" | "viewed_listing" | "started_contact" | "sent_contact"
  | "deals_created" | "deals_paid" | "paid_value_gbp" | "deals_cancelled"
  | "offers_made" | "buyer_chats" | "auction_bids"
  | "listings_live" | "listings_new" | "sell_requests" | "joules_started"
  | "drop_no_price" | "drop_search_no_exact" | "drop_signin_wall" | "signup_submitted" | "buyer_signups"
  | "drop_signup_captcha" | "drop_signup_registered" | "drop_signup_other" | "drop_contact_error"
  | "drop_offers_expired" | "drop_payment_failed";

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
  drop_no_price: { label: "Saw no price (offer only)", hint: "people on a listing that asks for offers instead of showing a price", lowerIsBetter: true },
  drop_search_no_exact: { label: "Search found no exact match", hint: "people whose search fell back to looser results", lowerIsBetter: true },
  drop_signin_wall: { label: "Hit the sign-in box", hint: "people asked to sign in or sign up", lowerIsBetter: true },
  signup_submitted: { label: "Submitted a sign-up", hint: "people who sent the sign-up form" },
  buyer_signups: { label: "New buyer accounts", hint: "buyer accounts created on ReBattery" },
  drop_signup_captcha: { label: "Sign-up failed: captcha", hint: "Turnstile check failed", lowerIsBetter: true },
  drop_signup_registered: { label: "Sign-up failed: already registered", hint: "they already had an account", lowerIsBetter: true },
  drop_signup_other: { label: "Sign-up failed: other", hint: "any other sign-up error", lowerIsBetter: true },
  drop_contact_error: { label: "Message, offer or buy-now errored", hint: "people who hit an error sending", lowerIsBetter: true },
  drop_offers_expired: { label: "Offers expired unanswered", hint: "offers that ran out before the seller replied", lowerIsBetter: true },
  drop_payment_failed: { label: "Payments failed", hint: "deals whose first payment failed", lowerIsBetter: true },
};

/** A PostHog event, optionally narrowed by one event property, for a recordings link. */
export type ReplayEvent = { event: string; property?: { key: string; values: string[] } };

/** A row in "Where buyers drop off". `replay` links to PostHog recordings of people who did it. */
export type DropRow = { key: MetricKey | "viewed_not_started"; label: string; replay?: ReplayEvent[] };

const ev = (event: string, key?: string, ...values: string[]): ReplayEvent[] => [{ event, property: key ? { key, values } : undefined }];

export const DROP_STAGES: { stage: string; rows: DropRow[] }[] = [
  {
    stage: "Looking, not starting",
    rows: [
      { key: "viewed_not_started", label: "Viewed a listing but started nothing", replay: ev("listing_detail_viewed") },
      { key: "drop_no_price", label: METRICS.drop_no_price.label, replay: ev("listing_detail_viewed", "price_visibility", "offer_only") },
      { key: "drop_search_no_exact", label: METRICS.drop_search_no_exact.label, replay: ev("marketplace_search_outcome", "outcome", "fallback_results", "no_results") },
    ],
  },
  {
    stage: "Started, not sent",
    rows: [
      { key: "drop_signin_wall", label: METRICS.drop_signin_wall.label, replay: ev("auth_dialog_viewed") },
      { key: "signup_submitted", label: METRICS.signup_submitted.label, replay: ev("auth_signup_submitted") },
      { key: "buyer_signups", label: METRICS.buyer_signups.label },
      { key: "drop_signup_captcha", label: METRICS.drop_signup_captcha.label, replay: ev("auth_signup_failed", "reason_code", "turnstile_failed") },
      { key: "drop_signup_registered", label: METRICS.drop_signup_registered.label, replay: ev("auth_signup_failed", "reason_code", "user_already_registered") },
      { key: "drop_signup_other", label: METRICS.drop_signup_other.label, replay: ev("auth_signup_failed") },
      { key: "drop_contact_error", label: METRICS.drop_contact_error.label, replay: [...ev("listing_offer_failed"), ...ev("listing_message_failed"), ...ev("listing_buy_now_failed")] },
    ],
  },
  {
    stage: "Sent, not paid",
    rows: [
      { key: "drop_offers_expired", label: METRICS.drop_offers_expired.label },
      { key: "deals_cancelled", label: METRICS.deals_cancelled.label },
      { key: "drop_payment_failed", label: METRICS.drop_payment_failed.label },
    ],
  },
];

/** A drop row's value for a week: a stored number, or viewed minus started. */
export function dropValue(key: DropRow["key"], values: Partial<Record<MetricKey, number>>): number | undefined {
  if (key !== "viewed_not_started") return values[key];
  if (values.viewed_listing === undefined) return undefined;
  return Math.max(0, values.viewed_listing - (values.started_contact ?? 0));
}

/** PostHog recordings on the live site from the last 30 days with any of these events, test accounts left out. */
export function replayUrl(events: ReplayEvent[]): string {
  const host = { key: "$host", value: ["rebattery.io", "www.rebattery.io"], operator: "exact", type: "event" };
  const filters = {
    date_from: "-30d",
    filter_test_accounts: true,
    filter_group: {
      type: "AND",
      values: [{
        type: "OR",
        values: events.map(({ event, property }, order) => ({
          id: event, name: event, type: "events", order,
          properties: property ? [host, { key: property.key, value: property.values, operator: "exact", type: "event" }] : [host],
        })),
      }],
    },
  };
  return `https://us.posthog.com/project/375247/replay/home?filters=${encodeURIComponent(JSON.stringify(filters))}`;
}

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
  /** Offer status, "cancelled" or the deal's step; empty for chats and bids. */
  status: string;
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
  /** Opted out of email, or of Supply update. */
  opted_out: boolean;
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

export const SUGGESTION_STATUSES = ["New", "Doing", "Done", "Dismissed"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export type Suggestion = {
  id: string;
  batch: string;
  title: string;
  evidence: string;
  action: string;
  metric: string | null;
  owner: "Alex" | "Ari" | "Product";
  status: SuggestionStatus;
  /** The metric in the last full week when it was suggested. */
  before_week: string | null;
  before_value: number | null;
  status_changed_at: string | null;
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
  /** The latest batch's new suggestions, everything in progress, and the last 60 days of done or dismissed. */
  suggestions: Suggestion[];
};

const OFFER_OPENERS: Record<string, (title: string) => string> = {
  expired: (title) => `I saw your offer on the ${title} on ReBattery expired before you got an answer.`,
  rejected: (title) => `I saw your offer on the ${title} on ReBattery wasn't accepted.`,
  countered: (title) => `I saw the seller came back with a counter-offer on the ${title} on ReBattery.`,
  withdrawn: (title) => `I saw you withdrew your offer on the ${title} on ReBattery.`,
  accepted: (title) => `I saw your offer on the ${title} on ReBattery was accepted.`,
};

/** One factual line on what the buyer did, matched to the offer or deal status. */
export function opener(signal: FollowUpSignal, title: string): string {
  switch (signal.kind) {
    case "deal":
      return signal.status === "cancelled"
        ? `I saw your order for the ${title} on ReBattery was cancelled before payment.`
        : `I saw your order for the ${title} on ReBattery is still waiting on payment.`;
    case "offer":
      return (OFFER_OPENERS[signal.status] ?? ((t: string) => `I saw your offer on the ${t} on ReBattery.`))(title);
    case "chat":
      return `I saw you messaged about the ${title} on ReBattery.`;
    case "auction":
      return `Thanks for your bid on the ${title} auction on ReBattery.`;
  }
}

/** A short Gmail draft for a follow-up: one line on what they did, similar listings, one ask. */
export function draftFor(f: FollowUp, sender: string): { to: string; subject: string; body: string } {
  const title = f.latest.listing_title ?? "listing";
  const lines = [`Hi ${f.first_name ?? "[first name]"},`, "", opener(f.latest, title)];
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
