import { describe, expect, it } from "vitest";
import { bidSummary, bulkHome, buyerSteps, closingLots, enteredStageInMonth, isOpenLot, orderBook, type BulkRows } from "./home-bulk";

const NOW = new Date("2026-10-22T15:00:00Z");

type Lot = BulkRows["lots"][number];
const lot = (over: Partial<Lot>): Lot => ({
  id: "l", title: "Lot", trade_stage: "With buyers", value: null, last_touched: "2026-10-21",
  latest_activity_at: null, updated_at: "2026-10-22T10:37:07Z", stage_event_at: null, ...over,
});

describe("closed and lost this month", () => {
  const lots = [
    // Logged as moved to Done this month.
    lot({ id: "a", trade_stage: "Done", stage_event_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" }),
    // The log says it moved in September, even though it was edited in October.
    lot({ id: "b", trade_stage: "Done", stage_event_at: "2026-09-30T23:00:00Z", updated_at: "2026-10-12T00:00:00Z" }),
    // No logged stage change: updated_at stands in.
    lot({ id: "c", trade_stage: "Done", updated_at: "2026-09-13T16:21:40Z" }),
    lot({ id: "d", trade_stage: "Lost", updated_at: "2026-10-16T17:30:56Z" }),
    lot({ id: "e", trade_stage: "Lost", updated_at: "2026-10-18T15:30:56Z" }),
  ];

  it("counts lots that entered the stage this month", () => {
    expect(enteredStageInMonth(lots, "Done", "2026-10")).toBe(1);
    expect(enteredStageInMonth(lots, "Done", "2026-09")).toBe(2);
    expect(enteredStageInMonth(lots, "Lost", "2026-10")).toBe(2);
  });
});

describe("order book", () => {
  const lots = [
    lot({ id: "closing", trade_stage: "Closing", value: "$516,800", last_touched: "2026-10-20" }),
    lot({ id: "priced", value: "€55–85k", last_touched: "2026-10-21" }),
    lot({ id: "blank", value: "  ", last_touched: "2026-10-15" }),
    lot({ id: "needs", trade_stage: "Needs info", last_touched: "2026-10-16" }),
    // No hand-set touch: the latest activity stands in.
    lot({ id: "activity", last_touched: null, latest_activity_at: "2026-09-07T11:22:37Z" }),
    lot({ id: "never", last_touched: null }),
    lot({ id: "hold", trade_stage: "On hold", value: "x", last_touched: "2026-01-01" }),
    lot({ id: "done", trade_stage: "Done", value: "x" }),
    lot({ id: "lost", trade_stage: "Lost" }),
  ];
  const demand = [{ status: "open", max_price: 120 }, { status: "qualifying", max_price: null }, { status: "open", max_price: "95" }];

  it("leaves Done, Lost and On hold out of the open lots", () => {
    expect(lots.filter(isOpenLot).map((l) => l.id)).toEqual(["closing", "priced", "blank", "needs", "activity", "never"]);
  });

  it("counts priced lots, buy-boxes with a max price, and lots quiet for seven days or more", () => {
    // 15 Oct is seven days before 22 Oct, so quiet; 16 Oct is not.
    expect(orderBook({ lots, demand }, NOW)).toEqual({ open: 6, priced: 2, quiet: 3, buy_boxes: 3, buy_boxes_priced: 2 });
  });

  it("lists lots in closing with their value", () => {
    expect(closingLots(lots)).toEqual([{ title: "Lot", value: "$516,800" }]);
    expect(closingLots([lot({ trade_stage: "Closing", value: " " })])).toEqual([{ title: "Lot", value: null }]);
  });
});

describe("bids", () => {
  it("counts the last 30 days and every week since the first bid as all and firm", () => {
    const bids = bidSummary([
      { created_at: "2026-09-29T20:11:19Z", firmness: "firm" },
      { created_at: "2026-09-29T22:56:00Z", firmness: "indicative" },
      { created_at: "2026-10-02T06:30:54Z", firmness: "indicative" },
      { created_at: "2026-10-16T11:19:40Z", firmness: "indicative" },
      { created_at: "2026-09-01T00:00:00Z", firmness: "firm" },
    ], NOW);
    expect(bids.since).toBe("2026-09-01T00:00:00Z");
    expect(bids).toMatchObject({ total_30d: 4, firm_30d: 1 });
    expect(bids.weekly.map((w) => w.week_start)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(bids.weekly.find((w) => w.week_start === "2026-09-28")).toEqual({ week_start: "2026-09-28", all: 3, firm: 1 });
    expect(bids.weekly.at(-1)).toEqual({ week_start: "2026-10-19", all: 0, firm: 0 });
  });

  it("has no weeks before the first bid", () => {
    expect(bidSummary([], NOW)).toEqual({ since: null, total_30d: 0, firm_30d: 0, weekly: [] });
  });
});

describe("buyers on open lots", () => {
  it("counts each buyer at the furthest step reached, and the teaser pass-through", () => {
    const lots = [lot({ id: "open" }), lot({ id: "lost", trade_stage: "Lost" }), lot({ id: "hold", trade_stage: "On hold" })];
    const buyers = [
      ...Array(3).fill({ lot_id: "open", status: "To contact" }),
      ...Array(4).fill({ lot_id: "open", status: "Teaser sent" }),
      { lot_id: "open", status: "No reply" },
      { lot_id: "open", status: "NDA, specs sent" },
      { lot_id: "open", status: "Bid in" },
      { lot_id: "open", status: "Won" },
      { lot_id: "open", status: "Declined: logistics" },
      { lot_id: "lost", status: "Bid in" },
      { lot_id: "hold", status: "Teaser sent" },
    ];
    const steps = buyerSteps({ lots, buyers });
    expect(steps.steps.map((s) => [s.label, s.count, s.past])).toEqual([
      ["To contact", 3, false], ["Teaser sent", 5, false], ["NDA, specs", 1, true], ["Bid in", 1, true], ["LOI, deposit", 1, true],
    ]);
    expect(steps).toMatchObject({ teaser_passed: 3, teaser_total: 8 });
  });
});

describe("bulkHome", () => {
  it("puts the bulk numbers together", () => {
    const home = bulkHome({
      lots: [lot({ id: "c", trade_stage: "Closing", title: "Oklahoma Panasonic 2170 cells", value: "$516,800" }), lot({ id: "x", trade_stage: "Lost", updated_at: "2026-10-16T00:00:00Z" })],
      demand: [], bids: [], buyers: [],
    }, NOW);
    expect(home).toMatchObject({ closed_this_month: 0, lost_this_month: 1, closing: [{ title: "Oklahoma Panasonic 2170 cells", value: "$516,800" }] });
    expect(home.order_book.open).toBe(1);
  });
});
