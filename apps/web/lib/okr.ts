// OKR viewer: Dec 2026 to Feb 2027. Pure functions over rows read by lib/crm-postgres/okr.ts and
// lib/home-platform-read.ts, so every rule here is unit tested.
//
// Weeks start on Monday, UTC. A number that could not be read is null and the page says so; nothing
// here invents a 0. Weeks before a source has any history are null, not 0.
import {
  DAY_MS, MIN_PAID_AMOUNT, EUR_GBP, mondayOf, shiftWeek, weekOf, weekRange,
} from "./home-metrics";
import { internalBuyer, paidDeals, realDeals, type PlatformRows } from "./home-platform";
import type { PulseWeek } from "./marketplace-pulse";

// ---------------------------------------------------------------------------
// The quarter
// ---------------------------------------------------------------------------

export const PERIOD = { start: "2026-12-01", end: "2027-02-28", label: "Dec 2026 to Feb 2027" } as const;
/** Weeks drawn before the quarter, as the baseline the quarter is read against. */
export const LEAD_WEEKS = 8;
/** The quarter, Monday 30 Nov to Sunday 28 Feb, is 13 whole weeks. */
export const PERIOD_WEEKS = 13;
/** Weeks averaged into a baseline. */
export const BASELINE_WEEKS = 4;
/** The first week with bulk records in the CRM; earlier weeks are unknown, not zero. */
export const BULK_HISTORY_FROM = "2026-09-07";
/** One fixed rate for dollar amounts, labelled "about" like EUR_GBP. */
export const USD_GBP = 0.79;
/** Marketplace target carried over from Pulse (4 paid deals a month). To confirm for this quarter. */
export const MARKETPLACE_PAID_TARGET = 12;
export const BULK_TAKE_TARGET_GBP = 15_000;
/** An offer with no touch for this many days has gone quiet. */
export const QUIET_OFFER_DAYS = 21;

export type Kpi = {
  key: string;
  label: string;
  unit: "count" | "gbp";
  /** One value per week in `weeks`; null where the source has no data. */
  values: (number | null)[];
  /** One line under the figure, only when it changes how the number reads. */
  hint?: string;
};

export type KrStatus = "not_started" | "on_track" | "behind" | "met" | "no_data";

export type Kr = {
  key: string;
  objective: "marketplace" | "bulk";
  title: string;
  /** "count": a running total against a target. "milestone": hand-kept percent. */
  kind: "total" | "milestone";
  unit: "count" | "gbp" | "percent";
  target: number;
  /** Total so far in the quarter; null when it could not be read. */
  actual: number | null;
  /** Running total at the end of each quarter week, null for weeks not yet complete or started. */
  cumulative: (number | null)[];
  status: KrStatus;
  note: string | null;
  /** Where the target came from, shown when it is not agreed yet. */
  source: string;
};

export type Group = { key: "marketplace" | "bulk"; title: string; kpis: Kpi[] };

export type OkrData = {
  now: string;
  period: { start: string; end: string; label: string; day: number; days: number; share: number; started: boolean; ended: boolean };
  /** Monday of every drawn week: LEAD_WEEKS before the quarter, then the quarter. */
  weeks: string[];
  /** Index in `weeks` of the first quarter week. */
  period_index: number;
  /** Index of the week containing now, or null when now is outside the drawn weeks. */
  current_index: number | null;
  baseline: { from: number; to: number };
  krs: Kr[];
  groups: Group[];
  health: { warn: boolean; text: string }[];
};

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function drawnWeeks(): { weeks: string[]; period_index: number } {
  const first = mondayOf(new Date(`${PERIOD.start}T00:00:00Z`));
  return { weeks: weekRange(shiftWeek(first, PERIOD_WEEKS - 1), LEAD_WEEKS + PERIOD_WEEKS), period_index: LEAD_WEEKS };
}

export function periodPosition(now: Date) {
  const start = Date.parse(`${PERIOD.start}T00:00:00Z`);
  const end = Date.parse(`${PERIOD.end}T00:00:00Z`) + DAY_MS;
  const days = Math.round((end - start) / DAY_MS);
  const day = Math.min(days, Math.max(0, Math.floor((now.getTime() - start) / DAY_MS) + 1));
  return { start: PERIOD.start, end: PERIOD.end, label: PERIOD.label, day, days, share: day / days, started: now.getTime() >= start, ended: now.getTime() >= end };
}

const sum = (values: (number | null)[]) => values.reduce<number>((a, v) => a + (v ?? 0), 0);

/** Weeks that have finished, as a bound on what a series may show: the week in progress is partial. */
export function completeThrough(weeks: string[], now: Date): number {
  const current = weeks.indexOf(mondayOf(now));
  return current === -1 ? (Date.parse(`${weeks[0]}T00:00:00Z`) > now.getTime() ? -1 : weeks.length - 1) : current - 1;
}

/** Mean of the last BASELINE_WEEKS complete weeks before the quarter (or before now, if earlier). */
export function baselineRange(weeks: string[], periodIndex: number, now: Date): { from: number; to: number } {
  const current = weeks.indexOf(mondayOf(now));
  const to = Math.min(periodIndex - 1, current === -1 ? periodIndex - 1 : current - 1);
  return { from: Math.max(0, to - BASELINE_WEEKS + 1), to };
}

export function baselineAverage(kpi: Pick<Kpi, "values">, range: { from: number; to: number }): number | null {
  const values = kpi.values.slice(range.from, range.to + 1).filter((v): v is number => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function gbp(amount: number, currency: string | null | undefined): number | null {
  const code = (currency ?? "gbp").toLowerCase();
  if (code === "gbp") { return amount; }
  if (code === "eur") { return amount * EUR_GBP; }
  if (code === "usd") { return amount * USD_GBP; }
  return null;
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") { return null; }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Marketplace, counted from platform rows
// ---------------------------------------------------------------------------

export type MarketplaceWeekly = {
  offers: number[];
  paid: number[];
  gmv_gbp: number[];
  take_gbp: number[];
};

function bucket(weeks: string[]) {
  const index = new Map(weeks.map((w, i) => [w, i]));
  const values = weeks.map(() => 0);
  return { add(at: string, by: number) { const i = index.get(weekOf(at)); if (i !== undefined) { values[i] += by; } }, values };
}

export function marketplaceWeekly(rows: PlatformRows, weeks: string[]): MarketplaceWeekly {
  const deals = realDeals(rows);
  const dealIds = new Set(deals.map((d) => d.id));
  const offers = bucket(weeks);
  const paid = bucket(weeks);
  const gmv = bucket(weeks);
  const take = bucket(weeks);
  for (const o of rows.offers) {
    if (!internalBuyer(o.buyer_account_id, rows.accountEmails)) { offers.add(o.created_at, 1); }
  }
  for (const p of paidDeals(rows.payments, dealIds)) { paid.add(p.paid_at, 1); }
  for (const p of rows.payments) {
    if (p.status !== "captured" || !dealIds.has(p.deal_id)) { continue; }
    const at = p.captured_at ?? p.created_at;
    const amount = num(p.amount);
    if (amount !== null && amount >= MIN_PAID_AMOUNT) {
      const value = gbp(amount, p.currency);
      if (value !== null) { gmv.add(at, value); }
    }
    const fee = num(p.platform_fee_amount);
    const feeGbp = fee === null ? null : gbp(fee, p.currency);
    if (feeGbp !== null) { take.add(at, feeGbp); }
  }
  return { offers: offers.values, paid: paid.values, gmv_gbp: gmv.values, take_gbp: take.values };
}

/** Pulse snapshot values per drawn week, null where the week has no snapshot. */
export function pulseSeries(pulse: PulseWeek[], metric: string, weeks: string[]): (number | null)[] {
  const byWeek = new Map(pulse.map((w) => [w.week_start, w.values as Record<string, number | undefined>]));
  return weeks.map((w) => byWeek.get(w)?.[metric] ?? null);
}

// ---------------------------------------------------------------------------
// Bulk trades, counted from crm_bulk_listings and crm_bulk_offers
// ---------------------------------------------------------------------------

export type BulkRows = {
  listings: { id: string; kind: string; status: string; closed_reason: string | null; created_at: string }[];
  offers: {
    id: string;
    bulk_listing_id: string;
    stage: string | null;
    created_at: string;
    updated_at: string;
    last_touch_on: string | null;
    amount: number | string | null;
    unit: string | null;
    quantity: number | string | null;
    currency: string | null;
    take_gbp: number | string | null;
  }[];
  /** Human contact on a listing: mail, outreach, quotes, notes, calls and WhatsApp. */
  touches: { bulk_listing_id: string; occurred_at: string }[];
};

/** Records that are research or housekeeping, not deals. */
const NOT_DEALS = new Set(["research_profile", "duplicate", "moved_to_profile", "not_demand"]);
export const isDeal = (l: BulkRows["listings"][number]) => !NOT_DEALS.has(l.closed_reason ?? "");

const MADE = new Set(["offered", "negotiating", "signed", "paid", "declined"]);
const ONE_UNIT = new Set(["", "pack", "lot", "total", "unit", "container", "system"]);

/**
 * What an offer is worth in pounds: price times quantity when both are known, otherwise the price when
 * it is for a single lot or pack. Per-cell or per-kWh prices without a quantity have no value.
 */
export function offerValueGbp(o: Pick<BulkRows["offers"][number], "amount" | "unit" | "quantity" | "currency">): number | null {
  const amount = num(o.amount);
  if (amount === null) { return null; }
  const quantity = num(o.quantity);
  const total = quantity !== null ? amount * quantity : ONE_UNIT.has((o.unit ?? "").toLowerCase()) ? amount : null;
  return total === null ? null : gbp(total, o.currency);
}

export type BulkWeekly = {
  new_deals: (number | null)[];
  new_deals_value: (number | null)[];
  active_deals: (number | null)[];
  active_deals_value: (number | null)[];
  offers: (number | null)[];
  offers_value: (number | null)[];
  closed: (number | null)[];
  closed_value: (number | null)[];
  abandoned: (number | null)[];
  take_gbp: (number | null)[];
  valued: { offers: number; offers_total: number; closed: number; closed_total: number };
  quiet_offers: number;
  closed_without_take: number;
};

export function bulkWeekly(rows: BulkRows, weeks: string[], now: Date): BulkWeekly {
  const index = new Map(weeks.map((w, i) => [w, i]));
  const known = weeks.map((w) => w >= BULK_HISTORY_FROM);
  const series = () => weeks.map(() => 0);
  const out = {
    new_deals: series(), new_deals_value: series(), active_deals: series(), active_deals_value: series(),
    offers: series(), offers_value: series(), closed: series(), closed_value: series(), abandoned: series(), take_gbp: series(),
  };
  const slot = (at: string) => index.get(weekOf(at));

  // Best priced offer per listing: what the deal is worth while it is being worked.
  const dealValue = new Map<string, number>();
  for (const o of rows.offers) {
    const v = MADE.has(o.stage ?? "") ? offerValueGbp(o) : null;
    if (v !== null) { dealValue.set(o.bulk_listing_id, Math.max(dealValue.get(o.bulk_listing_id) ?? 0, v)); }
  }
  const deals = rows.listings.filter(isDeal);
  const dealIds = new Set(deals.map((l) => l.id));
  for (const l of deals) {
    const i = slot(l.created_at);
    if (i !== undefined) { out.new_deals[i] += 1; out.new_deals_value[i] += dealValue.get(l.id) ?? 0; }
  }
  const activeIn = new Map<number, Set<string>>();
  for (const t of rows.touches) {
    const i = slot(t.occurred_at);
    if (i === undefined || !dealIds.has(t.bulk_listing_id)) { continue; }
    activeIn.set(i, (activeIn.get(i) ?? new Set()).add(t.bulk_listing_id));
  }
  for (const [i, ids] of activeIn) {
    out.active_deals[i] = ids.size;
    out.active_deals_value[i] = [...ids].reduce((a, id) => a + (dealValue.get(id) ?? 0), 0);
  }

  let offersTotal = 0, offersValued = 0, closedTotal = 0, closedValued = 0, quiet = 0, closedNoTake = 0;
  const quietBefore = now.getTime() - QUIET_OFFER_DAYS * DAY_MS;
  for (const o of rows.offers) {
    const stage = o.stage ?? "";
    if (!dealIds.has(o.bulk_listing_id) && !MADE.has(stage)) { continue; }
    const value = offerValueGbp(o);
    if (MADE.has(stage)) {
      const i = slot(o.created_at);
      if (i !== undefined) {
        out.offers[i] += 1;
        out.offers_value[i] += value ?? 0;
        offersTotal += 1;
        if (value !== null) { offersValued += 1; }
      }
    }
    if (stage === "paid") {
      const i = slot(o.updated_at);
      if (i !== undefined) {
        out.closed[i] += 1;
        out.closed_value[i] += value ?? 0;
        closedTotal += 1;
        if (value !== null) { closedValued += 1; }
        const take = num(o.take_gbp);
        if (take !== null) { out.take_gbp[i] += take; } else { closedNoTake += 1; }
      }
    }
    if (stage === "declined") {
      const i = slot(o.updated_at);
      if (i !== undefined) { out.abandoned[i] += 1; }
    }
    if (stage === "offered") {
      const touched = o.last_touch_on ? Date.parse(`${o.last_touch_on}T00:00:00Z`) : Date.parse(o.updated_at);
      if (touched < quietBefore) { quiet += 1; }
    }
  }
  // Before the first bulk records existed, a week is unknown rather than quiet.
  const mask = (values: number[]): (number | null)[] => values.map((v, i) => (known[i] ? v : null));
  return {
    new_deals: mask(out.new_deals), new_deals_value: mask(out.new_deals_value),
    active_deals: mask(out.active_deals), active_deals_value: mask(out.active_deals_value),
    offers: mask(out.offers), offers_value: mask(out.offers_value),
    closed: mask(out.closed), closed_value: mask(out.closed_value),
    abandoned: mask(out.abandoned), take_gbp: mask(out.take_gbp),
    valued: { offers: offersValued, offers_total: offersTotal, closed: closedValued, closed_total: closedTotal },
    quiet_offers: quiet,
    closed_without_take: closedNoTake,
  };
}

// ---------------------------------------------------------------------------
// Key results
// ---------------------------------------------------------------------------

/** Running totals over the quarter's weeks; null for a week that has not finished (the one in progress shows its total so far). */
export function cumulative(values: (number | null)[], periodIndex: number, current: number | null): (number | null)[] {
  let total = 0;
  return Array.from({ length: PERIOD_WEEKS }, (_, i) => {
    const at = periodIndex + i;
    if (current === null ? false : at > current) { return null; }
    total += values[at] ?? 0;
    return total;
  });
}

export function krStatus(actual: number | null, target: number, position: ReturnType<typeof periodPosition>): KrStatus {
  if (actual === null) { return "no_data"; }
  if (actual >= target) { return "met"; }
  if (!position.started) { return "not_started"; }
  // On track when within a tenth of an even run to the target.
  return actual >= target * position.share * 0.9 ? "on_track" : "behind";
}

export type OkrInput = {
  now: Date;
  platform: PlatformRows | null;
  pulse: PulseWeek[];
  pulseCollectedAt: string | null;
  bulk: BulkRows | null;
  progress: Record<string, { percent: number; note: string; updated_at: string }>;
  errors: { platform: boolean; crm: boolean };
};

export function buildOkr(input: OkrInput): OkrData {
  const { now } = input;
  const { weeks, period_index } = drawnWeeks();
  const position = periodPosition(now);
  const currentWeek = weeks.indexOf(mondayOf(now));
  const current = currentWeek === -1 ? null : currentWeek;
  const baseline = baselineRange(weeks, period_index, now);
  // Weeks after the one in progress have no data yet.
  const future = (values: (number | null)[]) => values.map((v, i) => (current !== null && i > current ? null : v));
  const platformWeeks = input.platform ? marketplaceWeekly(input.platform, weeks) : null;
  const fromPlatform = (values: number[] | undefined) => (values ? future(values) : weeks.map(() => null));

  const visitors = future(pulseSeries(input.pulse, "visitors", weeks));
  const listingsNew = future(pulseSeries(input.pulse, "listings_new", weeks));
  const liveNow = [...input.pulse].reverse().map((w) => (w.values as Record<string, number | undefined>).listings_live).find((v) => v !== undefined);

  const marketplace: Kpi[] = [
    { key: "mkt_listings", label: "New listings", unit: "count", values: listingsNew, hint: liveNow !== undefined ? `${liveNow} live at last count` : undefined },
    { key: "mkt_hits", label: "Web hits", unit: "count", values: visitors, hint: "Visitors to marketplace and listing pages" },
    { key: "mkt_offers", label: "Offers made", unit: "count", values: fromPlatform(platformWeeks?.offers) },
    { key: "mkt_conversions", label: "Conversions", unit: "count", values: fromPlatform(platformWeeks?.paid), hint: "Deals paid" },
    { key: "mkt_gmv", label: "GMV", unit: "gbp", values: fromPlatform(platformWeeks?.gmv_gbp), hint: "Captured payments, euro at a fixed rate" },
    { key: "mkt_take", label: "Take", unit: "gbp", values: fromPlatform(platformWeeks?.take_gbp), hint: "Platform fees on captured payments" },
  ];

  const bulkData = input.bulk ? bulkWeekly(input.bulk, weeks, now) : null;
  const fromBulk = (values: (number | null)[] | undefined) => (values ? future(values) : weeks.map(() => null));
  const bulk: Kpi[] = [
    { key: "bulk_new", label: "New deals", unit: "count", values: fromBulk(bulkData?.new_deals) },
    { key: "bulk_new_value", label: "New deals, implied value", unit: "gbp", values: fromBulk(bulkData?.new_deals_value), hint: "Best priced offer on each deal" },
    { key: "bulk_active", label: "Active deals", unit: "count", values: fromBulk(bulkData?.active_deals), hint: "Deals with contact that week" },
    { key: "bulk_active_value", label: "Active deals, implied value", unit: "gbp", values: fromBulk(bulkData?.active_deals_value) },
    { key: "bulk_offers", label: "Offers made", unit: "count", values: fromBulk(bulkData?.offers) },
    { key: "bulk_offers_value", label: "Offers made, implied value", unit: "gbp",
      values: fromBulk(bulkData?.offers_value),
      hint: bulkData ? `Priced for ${bulkData.valued.offers} of ${bulkData.valued.offers_total} offers` : undefined },
    { key: "bulk_closed", label: "Deals closed", unit: "count", values: fromBulk(bulkData?.closed), hint: "Offers marked paid" },
    { key: "bulk_closed_value", label: "Deals closed, value", unit: "gbp", values: fromBulk(bulkData?.closed_value) },
    { key: "bulk_abandoned", label: "Offers abandoned", unit: "count", values: fromBulk(bulkData?.abandoned),
      hint: bulkData ? `Declined. ${bulkData.quiet_offers} more have gone quiet for ${QUIET_OFFER_DAYS}+ days` : "Declined" },
  ];

  const periodTotal = (values: (number | null)[]) => sum(values.slice(period_index, period_index + PERIOD_WEEKS));
  const paidKpi = marketplace.find((k) => k.key === "mkt_conversions")!;
  const takeValues = fromBulk(bulkData?.take_gbp);

  const marketplaceActual = platformWeeks ? periodTotal(paidKpi.values) : null;
  const takeActual = bulkData ? periodTotal(takeValues) : null;
  const sop = input.progress.bulk_sop;

  const krs: Kr[] = [
    {
      key: "mkt_paid", objective: "marketplace", kind: "total", unit: "count",
      title: "Paid marketplace deals", target: MARKETPLACE_PAID_TARGET, actual: marketplaceActual,
      cumulative: cumulative(paidKpi.values, period_index, current),
      status: krStatus(marketplaceActual, MARKETPLACE_PAID_TARGET, position),
      note: null, source: "4 a month, carried over from Pulse. To confirm.",
    },
    {
      key: "bulk_take", objective: "bulk", kind: "total", unit: "gbp",
      title: "Take from bulk trades", target: BULK_TAKE_TARGET_GBP, actual: takeActual,
      cumulative: cumulative(takeValues, period_index, current),
      status: krStatus(takeActual, BULK_TAKE_TARGET_GBP, position),
      note: bulkData && bulkData.closed_without_take > 0
        ? `${bulkData.closed_without_take} paid ${bulkData.closed_without_take === 1 ? "deal has" : "deals have"} no take recorded yet`
        : null,
      source: "Sean, 9 Nov: £15k take Dec to Feb through weekly meetings and KPIs.",
    },
    {
      key: "bulk_sop", objective: "bulk", kind: "milestone", unit: "percent",
      title: "Written SOP for bulk trades", target: 100, actual: sop ? sop.percent : 0,
      cumulative: weeks.slice(period_index, period_index + PERIOD_WEEKS).map(() => null),
      status: sop && sop.percent >= 100 ? "met" : position.started ? (sop && sop.percent > 0 ? "on_track" : "behind") : "not_started",
      note: sop?.note || null,
      source: "Sean, 9 Nov: the SOP powers the agentic tools. Stretch: an end-to-end agent transaction by Feb 2027.",
    },
  ];

  const stale = !input.pulseCollectedAt || now.getTime() - Date.parse(input.pulseCollectedAt) > 36 * 3_600_000;
  const health: OkrData["health"] = [];
  if (input.errors.platform) { health.push({ warn: true, text: "Could not read ReBattery just now, so marketplace offers, conversions, GMV and take are missing." }); }
  if (input.errors.crm) { health.push({ warn: true, text: "Could not read the CRM just now, so bulk trades and web hits are missing." }); }
  if (stale) {
    health.push({ warn: true, text: input.pulseCollectedAt
      ? `Web hits and listings come from the weekly collector, last run ${input.pulseCollectedAt.slice(0, 10)}.`
      : "Web hits and listings come from the weekly collector, which has not run yet." });
  }
  health.push({ warn: false, text: `Bulk records start the week of ${BULK_HISTORY_FROM}; earlier weeks are blank, not zero.` });
  health.push({ warn: false, text: "Bulk take is read from a paid offer's take_gbp; deals without it are listed on the key result." });

  return {
    now: now.toISOString(),
    period: position,
    weeks,
    period_index,
    current_index: current,
    baseline,
    krs,
    groups: [
      { key: "marketplace", title: "Marketplace", kpis: marketplace },
      { key: "bulk", title: "Bulk trades", kpis: bulk },
    ],
    health,
  };
}
