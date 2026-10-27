// The Bulk desk numbers: the quarter target, what the Board's deals are worth, and the Today list. Safe for client and server.
import { isBoardStage } from "./bulk-listing";
import type { DealOwner } from "./bulk-owner";
import type { SheetRow } from "./bulk-sheet";

/** Take (our fees) each driver aims for in a quarter, in GBP. Alex and Sean are the drivers. */
export const QUARTER_TARGET_GBP = 27_000;
/** Approximate rate used only to show the target in EUR next to the EUR fees; not a live rate. */
export const EUR_PER_GBP = 1.15;
/** How many drivers share the target when every owner is shown (Alex and Sean). */
export const TARGET_DRIVERS = 2;
/** Share of the Board's deals we expect to win; the unweighted fees needed are the target divided by this. */
export const WIN_RATE = 0.2;

/** The quarter target for the owner filter: both drivers for All, one for a single owner. */
export function quarterTarget(owner: DealOwner | "all"): { gbp: number; eur: number; needed_eur: number } {
  const gbp = QUARTER_TARGET_GBP * (owner === "all" ? TARGET_DRIVERS : 1);
  const eur = Math.round(gbp * EUR_PER_GBP);
  return { gbp, eur, needed_eur: Math.round(eur / WIN_RATE) };
}

/** A deal's fee scaled by its chance of completing; null unless both are known. */
export function weightedFee(row: Pick<SheetRow, "fee_eur" | "likelihood">): number | null {
  return row.fee_eur != null && row.likelihood != null ? (row.fee_eur * row.likelihood) / 100 : null;
}

export type DealTotals = {
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

export function dealTotals(rows: SheetRow[]): DealTotals {
  return rows.reduce<DealTotals>((sum, row) => {
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

/** The deals on the Board: listings at Offered or later. */
export function boardRows(rows: SheetRow[]): SheetRow[] {
  return rows.filter((row) => isBoardStage(row.progress));
}

export type TodayGroupKey = "overdue" | "today" | "upcoming" | "undated" | "none";
export type TodayGroup = { key: TodayGroupKey; label: string; rows: SheetRow[] };
const GROUP_LABEL: Record<TodayGroupKey, string> = { overdue: "Overdue", today: "Today", upcoming: "Upcoming", undated: "No date", none: "No next action" };

/**
 * Next actions by when they are due: Overdue, Today, Upcoming, No date, then the open listings with no next action.
 * Delivered listings with nothing left to do are left out. Dated groups run soonest first; the rest by score.
 */
export function todayGroups(rows: SheetRow[], today: string): TodayGroup[] {
  const byScore = (a: SheetRow, b: SheetRow) => (b.score ?? -1) - (a.score ?? -1) || a.title.localeCompare(b.title);
  const byDue = (a: SheetRow, b: SheetRow) => (a.next_due ?? "").localeCompare(b.next_due ?? "") || byScore(a, b);
  const groups: Record<TodayGroupKey, SheetRow[]> = { overdue: [], today: [], upcoming: [], undated: [], none: [] };
  for (const row of rows) {
    if (!row.next_action) { if (row.progress !== "Delivered") groups.none.push(row); continue; }
    const due = row.next_due?.slice(0, 10) ?? null;
    groups[!due ? "undated" : due < today ? "overdue" : due === today ? "today" : "upcoming"].push(row);
  }
  return (Object.keys(groups) as TodayGroupKey[]).map((key) => ({
    key, label: GROUP_LABEL[key], rows: groups[key].sort(key === "undated" || key === "none" ? byScore : byDue),
  }));
}
