// Home: bulk trades counted from the live Trades Preview tables (crm_bulk_listings, crm_bulk_offers,
// crm_bulk_listing_activity in local Postgres). Pure functions over rows read by lib/crm-postgres/home.ts.
//
// Open listings are those not closed and not on hold: a supply lot on hold cannot trade until its hold ends, so it
// is neither in the order book nor quiet. The one bulk target is take over Dec 2026 to Feb 2027 (TARGETS.bulk_take).
import { DAY_MS, QUIET_DAYS, TARGETS, mondayOf, monthOf, shiftWeek } from "./home-metrics";
import { PERIOD as TAKE_PERIOD } from "./okr";

export type BulkRows = {
  listings: {
    id: string;
    kind: string;
    status: string;
    /** The readable title (listing_title, else the summary) and the party, for the closing list. */
    title: string;
    party: string;
    /** spec.value_eur for supply, spec.max_price for demand: is there a price at all. */
    value_eur: number | string | null;
    max_price: number | string | null;
    on_hold: boolean;
    /** bulk_listing_deal_stage(): Offered to Delivered, Lost, or null. */
    deal_stage: string | null;
    /** Latest human contact (mail, call, note, quote, WhatsApp, outreach); null when none. */
    latest_touch_at: string | null;
  }[];
  /** Counterparty offers. */
  offers: {
    bulk_listing_id: string;
    stage: string | null;
    created_at: string;
    updated_at: string;
    firmness: string | null;
    paid_on: string | null;
    take_gbp: number | string | null;
  }[];
};

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") { return null; }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const isOpenListing = (l: Pick<BulkRows["listings"][number], "status" | "on_hold">) => l.status !== "closed" && !l.on_hold;

/** Offers made: offered and every stage after it, won or lost. A candidate was never put to anyone. */
const MADE = new Set(["offered", "negotiating", "contract_out", "signed", "invoiced", "paid", "complete", "declined", "lost"]);

export type TakeGoal = {
  /** Take in GBP on offers paid within the period so far. */
  take_gbp: number;
  target_gbp: number;
  /** Share of the period gone, 0 before it starts and 1 after it ends. */
  share: number;
  /** Where take would be today if it came in evenly. */
  pace_gbp: number;
  started: boolean;
  /** Paid offers in the period with no take recorded. */
  without_take: number;
  period_label: string;
};

/** Take banked in the target period: offers paid (or delivered) with a paid date inside it. */
export function takeGoal(offers: BulkRows["offers"], now: Date): TakeGoal {
  const start = Date.parse(`${TAKE_PERIOD.start}T00:00:00Z`);
  const end = Date.parse(`${TAKE_PERIOD.end}T00:00:00Z`) + DAY_MS;
  const share = Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
  const target = TARGETS.bulk_take.value;
  let take = 0, without = 0;
  for (const o of offers) {
    if (o.stage !== "paid" && o.stage !== "complete") { continue; }
    const at = o.paid_on ? Date.parse(`${o.paid_on.slice(0, 10)}T00:00:00Z`) : null;
    if (at === null || at < start || at >= end) { continue; }
    const t = num(o.take_gbp);
    if (t === null) { without += 1; } else { take += t; }
  }
  return {
    take_gbp: take, target_gbp: target, share, pace_gbp: Math.round(target * share), started: share > 0,
    without_take: without, period_label: TAKE_PERIOD.label,
  };
}

export type ClosingDeal = { title: string; value: string | null };

/** Deals at Agreed (contract out, signed or invoiced): the ones about to close. */
export const closingDeals = (listings: BulkRows["listings"]): ClosingDeal[] =>
  listings.filter((l) => l.status !== "closed" && l.deal_stage === "Agreed").map((l) => {
    const value = num(l.value_eur);
    return { title: l.party ? `${l.party}: ${l.title}` : l.title, value: value !== null ? `€${Math.round(value).toLocaleString("en-GB")}` : null };
  });

/** Counterparty offers marked declined or lost this month (by their last update). */
export function lostInMonth(offers: BulkRows["offers"], month: string): number {
  return offers.filter((o) => (o.stage === "declined" || o.stage === "lost") && monthOf(o.updated_at) === month).length;
}

export type OrderBook = { open: number; priced: number; quiet: number; buy_boxes: number; buy_boxes_priced: number };

/** Open supply with a value, open requests with a max price, and open supply nobody has touched for a week. */
export function orderBook(listings: BulkRows["listings"], now: Date): OrderBook {
  const open = listings.filter(isOpenListing);
  const supply = open.filter((l) => l.kind === "supply");
  const demand = open.filter((l) => l.kind === "demand");
  const cutoff = now.getTime() - QUIET_DAYS * DAY_MS;
  return {
    open: supply.length,
    priced: supply.filter((l) => num(l.value_eur) !== null).length,
    // Never touched at all counts as quiet.
    quiet: supply.filter((l) => !l.latest_touch_at || Date.parse(l.latest_touch_at) < cutoff).length,
    buy_boxes: demand.length,
    buy_boxes_priced: demand.filter((l) => num(l.max_price) !== null).length,
  };
}

export type OfferSummary = { since: string | null; total_30d: number; firm_30d: number; weekly: { week_start: string; all: number; firm: number }[] };

/** Offers made in the last 30 days, and every week since the first one as [all, firm] (terms.firmness). */
export function offerSummary(offers: BulkRows["offers"], now: Date): OfferSummary {
  const sorted = offers.filter((o) => MADE.has(o.stage ?? "")).toSorted((a, b) => a.created_at.localeCompare(b.created_at));
  const cutoff = now.getTime() - 30 * DAY_MS;
  const recent = sorted.filter((o) => Date.parse(o.created_at) >= cutoff);
  const weekly: OfferSummary["weekly"] = [];
  if (sorted.length) {
    const last = mondayOf(now);
    for (let week = mondayOf(new Date(sorted[0].created_at)); week <= last; week = shiftWeek(week, 1)) {
      const inWeek = sorted.filter((o) => mondayOf(new Date(o.created_at)) === week);
      weekly.push({ week_start: week, all: inWeek.length, firm: inWeek.filter((o) => o.firmness === "firm").length });
    }
  }
  return {
    since: sorted[0]?.created_at ?? null,
    total_30d: recent.length,
    firm_30d: recent.filter((o) => o.firmness === "firm").length,
    weekly,
  };
}

/** How far each counterparty on an open listing has got. Declined and lost offers are left out. */
export const COUNTERPARTY_STEPS: { label: string; stages: string[]; past: boolean }[] = [
  { label: "Candidate", stages: ["candidate"], past: false },
  { label: "Offered", stages: ["offered"], past: false },
  { label: "Negotiating", stages: ["negotiating"], past: true },
  { label: "Agreed", stages: ["contract_out", "signed", "invoiced"], past: true },
  { label: "Paid", stages: ["paid", "complete"], past: true },
];

export type CounterpartySteps = {
  steps: { label: string; count: number; past: boolean }[];
  /** Counterparties past Offered, out of those who were offered. */
  offered_passed: number;
  offered_total: number;
};

export function counterpartySteps(rows: BulkRows): CounterpartySteps {
  const open = new Set(rows.listings.filter((l) => l.status !== "closed").map((l) => l.id));
  const onOpen = rows.offers.filter((o) => open.has(o.bulk_listing_id));
  const steps = COUNTERPARTY_STEPS.map((s) => ({ label: s.label, past: s.past, count: onOpen.filter((o) => s.stages.includes(o.stage ?? "")).length }));
  const passed = steps.filter((s) => s.past).reduce((a, s) => a + s.count, 0);
  return { steps, offered_passed: passed, offered_total: steps[1].count + passed };
}

export type BulkHome = {
  take: TakeGoal;
  lost_this_month: number;
  closing: ClosingDeal[];
  order_book: OrderBook;
  offers: OfferSummary;
  counterparties: CounterpartySteps;
};

export function bulkHome(rows: BulkRows, now: Date): BulkHome {
  return {
    take: takeGoal(rows.offers, now),
    lost_this_month: lostInMonth(rows.offers, monthOf(now)),
    closing: closingDeals(rows.listings),
    order_book: orderBook(rows.listings, now),
    offers: offerSummary(rows.offers, now),
    counterparties: counterpartySteps(rows),
  };
}
