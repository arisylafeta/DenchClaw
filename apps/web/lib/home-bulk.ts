// Home: bulk trades counted from the CRM (crm_bulk_trade_* in local Postgres). Pure functions over rows
// read by lib/crm-postgres/home.ts.
//
// Open lots are those not Done, Lost or On hold: a lot on hold cannot trade until its hold ends, so it
// is neither in the order book nor quiet.
import { DAY_MS, QUIET_DAYS, mondayOf, monthOf, shiftWeek } from "./home-metrics";

export type BulkRows = {
  lots: {
    id: string;
    title: string;
    trade_stage: string;
    value: string | null;
    /** YYYY-MM-DD, set by hand or by the inbox check. */
    last_touched: string | null;
    latest_activity_at: string | null;
    updated_at: string;
    /** When the trade log last recorded the lot moving into its current stage; null when it never did. */
    stage_event_at: string | null;
  }[];
  /** Buy-boxes that are open or being qualified. */
  demand: { status: string; max_price: number | string | null }[];
  bids: { created_at: string; firmness: string }[];
  buyers: { lot_id: string; status: string }[];
};

const CLOSED_STAGES = new Set(["Done", "Lost", "On hold"]);
export const isOpenLot = (lot: Pick<BulkRows["lots"][number], "trade_stage">) => !CLOSED_STAGES.has(lot.trade_stage);

/**
 * When a lot entered its current stage: the trade log's stage change when there is one, otherwise the
 * lot's updated_at. Older lots were moved before the log recorded stage changes, so updated_at is the
 * fallback; it moves with any later edit, so a Done lot edited this month counts this month.
 */
export const stageEnteredAt = (lot: BulkRows["lots"][number]) => lot.stage_event_at ?? lot.updated_at;

export function enteredStageInMonth(lots: BulkRows["lots"], stage: string, month: string): number {
  return lots.filter((l) => l.trade_stage === stage && monthOf(stageEnteredAt(l)) === month).length;
}

export type ClosingLot = { title: string; value: string | null };

export const closingLots = (lots: BulkRows["lots"]): ClosingLot[] =>
  lots.filter((l) => l.trade_stage === "Closing").map((l) => ({ title: l.title, value: l.value?.trim() || null }));

export type OrderBook = { open: number; priced: number; quiet: number; buy_boxes: number; buy_boxes_priced: number };

/** Open lots with a price, buy-boxes with a max price, and open lots nobody has touched for a week. */
export function orderBook(rows: Pick<BulkRows, "lots" | "demand">, now: Date): OrderBook {
  const open = rows.lots.filter(isOpenLot);
  const cutoff = now.getTime() - QUIET_DAYS * DAY_MS;
  const touched = (l: BulkRows["lots"][number]) => {
    const at = l.last_touched ? `${l.last_touched}T00:00:00Z` : l.latest_activity_at;
    return at ? Date.parse(at) : null;
  };
  return {
    open: open.length,
    priced: open.filter((l) => !!l.value?.trim()).length,
    // Never touched at all counts as quiet.
    quiet: open.filter((l) => { const t = touched(l); return t === null || t < cutoff; }).length,
    buy_boxes: rows.demand.length,
    buy_boxes_priced: rows.demand.filter((d) => d.max_price !== null && d.max_price !== "").length,
  };
}

export type Bids = { since: string | null; total_30d: number; firm_30d: number; weekly: { week_start: string; all: number; firm: number }[] };

/** Bids in the last 30 days, and every week since the first bid as [all, firm]. */
export function bidSummary(bids: BulkRows["bids"], now: Date): Bids {
  const sorted = bids.toSorted((a, b) => a.created_at.localeCompare(b.created_at));
  const cutoff = now.getTime() - 30 * DAY_MS;
  const recent = sorted.filter((b) => Date.parse(b.created_at) >= cutoff);
  const weekly: Bids["weekly"] = [];
  if (sorted.length) {
    const last = mondayOf(now);
    for (let week = mondayOf(new Date(sorted[0].created_at)); week <= last; week = shiftWeek(week, 1)) {
      const inWeek = sorted.filter((b) => mondayOf(new Date(b.created_at)) === week);
      weekly.push({ week_start: week, all: inWeek.length, firm: inWeek.filter((b) => b.firmness === "firm").length });
    }
  }
  return {
    since: sorted[0]?.created_at ?? null,
    total_30d: recent.length,
    firm_30d: recent.filter((b) => b.firmness === "firm").length,
    weekly,
  };
}

/**
 * The furthest step each buyer on an open lot has reached. "No reply" sits with Teaser sent (they had
 * the teaser); "Won" sits with LOI or deposit. Buyers who declined are left out.
 */
export const BUYER_STEPS: { label: string; statuses: string[]; past: boolean }[] = [
  { label: "To contact", statuses: ["To contact"], past: false },
  { label: "Teaser sent", statuses: ["Teaser sent", "No reply"], past: false },
  { label: "NDA, specs", statuses: ["NDA, specs sent"], past: true },
  { label: "Bid in", statuses: ["Bid in"], past: true },
  { label: "LOI, deposit", statuses: ["LOI or deposit", "Won"], past: true },
];

export type BuyerSteps = {
  steps: { label: string; count: number; past: boolean }[];
  /** Buyers past the teaser, out of those who got one. */
  teaser_passed: number;
  teaser_total: number;
};

export function buyerSteps(rows: Pick<BulkRows, "lots" | "buyers">): BuyerSteps {
  const open = new Set(rows.lots.filter(isOpenLot).map((l) => l.id));
  const onOpen = rows.buyers.filter((b) => open.has(b.lot_id));
  const steps = BUYER_STEPS.map((s) => ({ label: s.label, past: s.past, count: onOpen.filter((b) => s.statuses.includes(b.status)).length }));
  const passed = steps.filter((s) => s.past).reduce((a, s) => a + s.count, 0);
  return { steps, teaser_passed: passed, teaser_total: steps[1].count + passed };
}

export type BulkHome = {
  closed_this_month: number;
  lost_this_month: number;
  closing: ClosingLot[];
  order_book: OrderBook;
  bids: Bids;
  buyers: BuyerSteps;
};

export function bulkHome(rows: BulkRows, now: Date): BulkHome {
  const month = monthOf(now);
  return {
    closed_this_month: enteredStageInMonth(rows.lots, "Done", month),
    lost_this_month: enteredStageInMonth(rows.lots, "Lost", month),
    closing: closingLots(rows.lots),
    order_book: orderBook(rows, now),
    bids: bidSummary(rows.bids, now),
    buyers: buyerSteps(rows),
  };
}
