// The Bulk desk numbers: the take target, what the Board's deals are worth, and the Today list. Safe for client and server.
import { EUR_PER_GBP, type SheetRow } from "./bulk-sheet";
import { TARGETS } from "./home-metrics";

export { EUR_PER_GBP };

/** The one bulk target: take (our fees) for the whole desk over Dec 2026 to Feb 2027, in GBP and approximate EUR.
 * Set in TARGETS (home-metrics); Home, the OKR page and the desk all read it from there. */
export const TAKE_TARGET = { gbp: TARGETS.bulk_take.value, eur: Math.round(TARGETS.bulk_take.value * EUR_PER_GBP), label: TARGETS.bulk_take.label } as const;

/** A deal's fee scaled by its chance of completing; null unless both are known. */
export function weightedFee(row: Pick<SheetRow, "fee_eur" | "likelihood">): number | null {
  return row.fee_eur != null && row.likelihood != null ? (row.fee_eur * row.likelihood) / 100 : null;
}

/**
 * The rows that count as deals in a total. A supply listing offered to a demand listing is one deal that shows on both;
 * it is counted once, on the demand side: a supply row is left out when the demand it is paired with is in the same set.
 */
export function countedDeals(rows: SheetRow[]): SheetRow[] {
  const demand = new Set(rows.filter((row) => row.kind === "demand").map((row) => row.id));
  return rows.filter((row) => !(row.kind === "supply" && row.paired_listing_id && demand.has(row.paired_listing_id)));
}

export type DealTotals = {
  /** Deals counted, after pairing (see countedDeals). */
  count: number;
  /** Sum of known values. */
  value_eur: number;
  /** Sum of known fees, unweighted. */
  fee_eur: number;
  /** Sum of fee x chance over deals that have both. */
  weighted_eur: number;
  /** Deals missing a fee or a chance, so not in the weighted sum. */
  unsized: number;
};

/** Totals over the rows, counting a paired supply and demand once (see countedDeals). */
export function dealTotals(rows: SheetRow[]): DealTotals {
  return countedDeals(rows).reduce<DealTotals>((sum, row) => {
    const weighted = weightedFee(row);
    return {
      count: sum.count + 1,
      value_eur: sum.value_eur + (row.value_eur ?? 0),
      fee_eur: sum.fee_eur + (row.fee_eur ?? 0),
      weighted_eur: sum.weighted_eur + (weighted ?? 0),
      unsized: sum.unsized + (weighted === null ? 1 : 0),
    };
  }, { count: 0, value_eur: 0, fee_eur: 0, weighted_eur: 0, unsized: 0 });
}

/** What each desk tab lists: every request, every supply lot, and the deal cards (Offered or later; a request or lot that
 * is a deal is in both). The tab counts and the Today summary both read this, so they always agree with the lists. */
export function deskCounts(rows: SheetRow[]): { requests: number; supply: number; deals: number } {
  return {
    requests: rows.filter((row) => row.kind === "demand").length,
    supply: rows.filter((row) => row.kind === "supply").length,
    deals: boardRows(rows).length,
  };
}

/** The deals on the Board: listings with a deal stage (Offered or later, or Lost). */
export function boardRows(rows: SheetRow[]): SheetRow[] {
  return rows.filter((row) => !!row.deal_stage);
}

/** The open deals: on the Board and neither Delivered nor Lost. What the take target is weighed against. */
export function openDealRows(rows: SheetRow[]): SheetRow[] {
  return boardRows(rows).filter((row) => row.deal_stage !== "Delivered" && row.deal_stage !== "Lost");
}

export type TodayGroupKey = "overdue" | "today" | "upcoming" | "undated" | "none";
export type TodayGroup = { key: TodayGroupKey; label: string; rows: SheetRow[] };
const GROUP_LABEL: Record<TodayGroupKey, string> = { overdue: "Overdue", today: "Today", upcoming: "Upcoming", undated: "No date", none: "No next action" };

/**
 * Next actions by when they are due: Overdue, Today, Upcoming, No date, then the open listings with no next action.
 * Closed listings, and Delivered or Lost deals with nothing left to do, are left out. Dated groups run soonest first; the rest by score.
 */
export function todayGroups(rows: SheetRow[], today: string): TodayGroup[] {
  const byScore = (a: SheetRow, b: SheetRow) => (b.score ?? -1) - (a.score ?? -1) || a.title.localeCompare(b.title);
  const byDue = (a: SheetRow, b: SheetRow) => (a.next_due ?? "").localeCompare(b.next_due ?? "") || byScore(a, b);
  const groups: Record<TodayGroupKey, SheetRow[]> = { overdue: [], today: [], upcoming: [], undated: [], none: [] };
  for (const row of rows) {
    if (row.closed) continue;
    if (!row.next_action) { if (row.deal_stage !== "Delivered" && row.deal_stage !== "Lost") groups.none.push(row); continue; }
    const due = row.next_due?.slice(0, 10) ?? null;
    groups[!due ? "undated" : due < today ? "overdue" : due === today ? "today" : "upcoming"].push(row);
  }
  return (Object.keys(groups) as TodayGroupKey[]).map((key) => ({
    key, label: GROUP_LABEL[key], rows: groups[key].sort(key === "undated" || key === "none" ? byScore : byDue),
  }));
}
