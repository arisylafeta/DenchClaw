import { describe, expect, it } from "vitest";
import { boardRows, countedDeals, dealTotals, deskCounts, EUR_PER_GBP, QUARTER_TARGET_GBP, quarterTarget, todayGroups, weightedFee } from "./bulk-desk";
import type { SheetRow } from "./bulk-sheet";

const row = (id: string, over: Partial<SheetRow> = {}): SheetRow => ({
  key: id, id, kind: "supply", side: "seller", title: id, company: null, company_id: null, category: null, progress: "New", tone: "new",
  score: null, latest: null, next_action: null, next_due: null, owner: null, touched: null, ...over,
});

describe("quarter target", () => {
  it("is £27k per driver: both drivers for All, one for a single owner, in approximate euros", () => {
    expect([QUARTER_TARGET_GBP, EUR_PER_GBP]).toEqual([27000, 1.15]);
    expect(quarterTarget("all")).toEqual({ gbp: 54000, eur: 62100, needed_eur: 310500 });
    for (const owner of ["Alex", "Sean"] as const) expect(quarterTarget(owner)).toEqual({ gbp: 27000, eur: 31050, needed_eur: 155250 });
    expect(quarterTarget("Ari")).toBeNull();
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
  it("keeps only deal stages for the Board", () => {
    const stages = ["New", "Qualified", "Sourcing", "Can't source", "Available", "Offered", "Negotiating", "Agreed", "Paid", "Delivered"] as const;
    expect(boardRows(stages.map((progress) => row(progress, { progress }))).map((r) => r.progress)).toEqual(["Offered", "Negotiating", "Agreed", "Paid", "Delivered"]);
  });
});

describe("desk counts", () => {
  it("counts what each tab lists: every request, every lot, and the deal cards in both", () => {
    const rows = [row("a", { kind: "demand", progress: "New" }), row("b", { kind: "demand", progress: "Offered" }),
      row("c", { kind: "supply", progress: "Available" }), row("d", { kind: "supply", progress: "Agreed" })];
    expect(deskCounts(rows)).toEqual({ requests: 2, supply: 2, deals: 2 });
    expect(deskCounts([])).toEqual({ requests: 0, supply: 0, deals: 0 });
  });
});

describe("Today groups", () => {
  const today = "2026-10-27";
  it("groups next actions by due date, then undated, then open listings with none, dropping Delivered with nothing to do", () => {
    const rows = [
      row("late2", { next_action: "Chase", next_due: "2026-10-25" }), row("late1", { next_action: "Call", next_due: "2026-10-20" }),
      row("now", { next_action: "Send", next_due: today }), row("soon", { next_action: "Quote", next_due: "2026-11-02T00:00:00Z" }),
      row("someday-low", { next_action: "Ask", score: 20 }), row("someday-high", { next_action: "Ask", score: 80 }),
      row("idle", { score: 50 }), row("idle-unscored"), row("done", { progress: "Delivered" }), row("done-but-busy", { progress: "Delivered", next_action: "Invoice" }),
    ];
    const groups = todayGroups(rows, today);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["Overdue", ["late1", "late2"]], ["Today", ["now"]], ["Upcoming", ["soon"]],
      ["No date", ["someday-high", "someday-low", "done-but-busy"]], ["No next action", ["idle", "idle-unscored"]],
    ]);
  });
});
