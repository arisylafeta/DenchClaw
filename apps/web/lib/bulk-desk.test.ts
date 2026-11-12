import { describe, expect, it } from "vitest";
import { boardRows, countedDeals, dealTotals, deskCounts, EUR_PER_GBP, openDealRows, TAKE_TARGET, todayGroups, weightedFee } from "./bulk-desk";
import { BULK_TAKE_TARGET_GBP } from "./okr";
import { TARGETS } from "./home-metrics";
import type { SheetRow } from "./bulk-sheet";

const row = (id: string, over: Partial<SheetRow> = {}): SheetRow => ({
  key: id, id, kind: "supply", side: "seller", title: id, company: null, company_id: null, category: null, progress: "New", tone: "new",
  score: null, latest: null, next_action: null, next_due: null, owner: null, touched: null, ...over,
});

describe("take target", () => {
  it("is one target, £15k take for Dec 2026 to Feb 2027, shared by the desk, Home and the OKR page", () => {
    expect([TAKE_TARGET.gbp, TAKE_TARGET.eur, EUR_PER_GBP]).toEqual([15000, 17250, 1.15]);
    expect(BULK_TAKE_TARGET_GBP).toBe(15000);
    expect(Object.keys(TARGETS)).not.toContain("bulk_closed");
  });
});

describe("deal totals", () => {
  it("weights a fee by its chance only when both are known", () => {
    expect(weightedFee({ fee_eur: 4000, likelihood: 50 })).toBe(2000);
    expect(weightedFee({ fee_eur: 4000, likelihood: null })).toBeNull();
    expect(weightedFee({ fee_eur: null, likelihood: 50 })).toBeNull();
    expect(weightedFee({ fee_eur: 0, likelihood: 50 })).toBe(0);
  });
  it("sums value, fees and weighted fees, and counts the unsized deals", () => {
    const rows = [row("a", { value_eur: 40000, fee_eur: 4000, likelihood: 50 }), row("b", { fee_eur: 2200, likelihood: 100 }), row("c", { fee_eur: 9000 }), row("d", { likelihood: 40 })];
    expect(dealTotals(rows)).toEqual({ count: 4, value_eur: 40000, fee_eur: 15200, weighted_eur: 4200, unsized: 2 });
    expect(dealTotals([])).toEqual({ count: 0, value_eur: 0, fee_eur: 0, weighted_eur: 0, unsized: 0 });
  });
  it("counts a supply offered to a demand once, on the demand, when both are in the set", () => {
    const demand = row("d1", { kind: "demand", side: "buyer", fee_eur: 3000, likelihood: 50, value_eur: 30000, paired_listing_id: "s1" });
    const supply = row("s1", { fee_eur: 4800, likelihood: 60, value_eur: 48000, paired_listing_id: "d1" });
    const other = row("s2", { fee_eur: 1000, likelihood: 100, paired_listing_id: "d9" });
    expect(countedDeals([demand, supply, other]).map((r) => r.id)).toEqual(["d1", "s2"]);
    expect(dealTotals([demand, supply, other])).toEqual({ count: 2, value_eur: 30000, fee_eur: 4000, weighted_eur: 2500, unsized: 0 });
    // Without its demand in the set, the supply counts.
    expect(dealTotals([supply, other])).toMatchObject({ count: 2, fee_eur: 5800 });
    // An unsized paired supply is not counted as unsized either.
    expect(dealTotals([demand, row("s1", { paired_listing_id: "d1" })]).unsized).toBe(0);
  });
  it("keeps only listings with a deal stage for the Board, and leaves Delivered and Lost out of the open deals", () => {
    const deals = [null, "Offered", "Negotiating", "Agreed", "Paid", "Delivered", "Lost"] as const;
    const rows = deals.map((deal_stage) => row(deal_stage ?? "none", { deal_stage }));
    expect(boardRows(rows).map((r) => r.deal_stage)).toEqual(["Offered", "Negotiating", "Agreed", "Paid", "Delivered", "Lost"]);
    expect(openDealRows(rows).map((r) => r.deal_stage)).toEqual(["Offered", "Negotiating", "Agreed", "Paid"]);
  });
});

describe("desk counts", () => {
  it("counts what each tab lists: every request, every lot, and the deal cards in both", () => {
    const rows = [row("a", { kind: "demand", progress: "New" }), row("b", { kind: "demand", progress: "Found", deal_stage: "Offered" }),
      row("c", { kind: "supply", progress: "Available" }), row("d", { kind: "supply", progress: "Reserved", deal_stage: "Agreed" })];
    expect(deskCounts(rows)).toEqual({ requests: 2, supply: 2, deals: 2 });
    expect(deskCounts([])).toEqual({ requests: 0, supply: 0, deals: 0 });
  });
});

describe("Today groups", () => {
  const today = "2026-10-27";
  it("groups next actions by due date, then undated, then open listings with none, dropping closed listings and Delivered or Lost with nothing to do", () => {
    const rows = [
      row("late2", { next_action: "Chase", next_due: "2026-10-25" }), row("late1", { next_action: "Call", next_due: "2026-10-20" }),
      row("now", { next_action: "Send", next_due: today }), row("soon", { next_action: "Quote", next_due: "2026-11-02T00:00:00Z" }),
      row("someday-low", { next_action: "Ask", score: 20 }), row("someday-high", { next_action: "Ask", score: 80 }),
      row("idle", { score: 50 }), row("idle-unscored"), row("done", { deal_stage: "Delivered" }), row("done-but-busy", { deal_stage: "Delivered", next_action: "Invoice" }),
      row("lost", { deal_stage: "Lost" }), row("closed", { closed: true, next_action: "Nothing", next_due: "2026-10-01" }),
    ];
    const groups = todayGroups(rows, today);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["Overdue", ["late1", "late2"]], ["Today", ["now"]], ["Upcoming", ["soon"]],
      ["No date", ["someday-high", "someday-low", "done-but-busy"]], ["No next action", ["idle", "idle-unscored"]],
    ]);
  });
});
