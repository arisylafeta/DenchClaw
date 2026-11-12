import { describe, expect, it } from "vitest";
import { bulkHome, closingDeals, counterpartySteps, lostInMonth, offerSummary, orderBook, takeGoal, type BulkRows } from "./home-bulk";

const NOW = new Date("2026-10-22T15:00:00Z");

type Listing = BulkRows["listings"][number];
type Offer = BulkRows["offers"][number];
const listing = (over: Partial<Listing>): Listing => ({
  id: "l", kind: "supply", status: "open", title: "Lot", party: "Seller", value_eur: null, max_price: null, on_hold: false,
  deal_stage: null, latest_touch_at: "2026-10-21T09:00:00Z", ...over,
});
const offer = (over: Partial<Offer>): Offer => ({
  bulk_listing_id: "l", stage: "offered", created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z",
  firmness: null, paid_on: null, take_gbp: null, ...over,
});

describe("take against the one bulk target", () => {
  const offers = [
    offer({ stage: "paid", paid_on: "2026-12-03", take_gbp: "1200" }),
    offer({ stage: "complete", paid_on: "2027-01-10", take_gbp: 800 }),
    offer({ stage: "paid", paid_on: "2027-01-12", take_gbp: null }),
    // Outside the period, or not paid: not counted.
    offer({ stage: "paid", paid_on: "2026-11-30", take_gbp: 5000 }),
    offer({ stage: "paid", paid_on: "2027-03-01", take_gbp: 5000 }),
    offer({ stage: "negotiating", paid_on: "2026-12-05", take_gbp: 5000 }),
    offer({ stage: "paid", paid_on: null, take_gbp: 5000 }),
  ];

  it("is £15k for Dec 2026 to Feb 2027 and has not started in November", () => {
    expect(takeGoal([], NOW)).toEqual({ take_gbp: 0, target_gbp: 15_000, share: 0, pace_gbp: 0, started: false, without_take: 0, period_label: "Dec 2026 to Feb 2027" });
  });

  it("sums take on offers paid inside the period, and counts paid ones with no take", () => {
    const goal = takeGoal(offers, new Date("2027-01-15T00:00:00Z"));
    expect(goal).toMatchObject({ take_gbp: 2000, without_take: 1, started: true });
    expect(goal.share).toBeCloseTo(45 / 90, 2);
    expect(takeGoal(offers, new Date("2027-06-01T00:00:00Z"))).toMatchObject({ share: 1, pace_gbp: 15_000 });
  });
});

describe("closing and lost", () => {
  it("lists open deals at Agreed with their value", () => {
    const rows = [listing({ id: "a", deal_stage: "Agreed", value_eur: "48000", title: "40 Zoe packs" }), listing({ id: "b", deal_stage: "Negotiating" }),
      listing({ id: "c", deal_stage: "Agreed", status: "closed" }), listing({ id: "d", deal_stage: "Agreed", party: "", title: "Cells" })];
    expect(closingDeals(rows)).toEqual([{ title: "Seller: 40 Zoe packs", value: "€48,000" }, { title: "Cells", value: null }]);
  });
  it("counts offers declined or lost this month", () => {
    const offers = [offer({ stage: "declined", updated_at: "2026-10-03T00:00:00Z" }), offer({ stage: "lost", updated_at: "2026-10-21T00:00:00Z" }),
      offer({ stage: "lost", updated_at: "2026-09-30T23:00:00Z" }), offer({ stage: "offered", updated_at: "2026-10-21T00:00:00Z" })];
    expect(lostInMonth(offers, "2026-10")).toBe(2);
  });
});

describe("order book", () => {
  const rows = [
    listing({ id: "priced", value_eur: "55000" }),
    listing({ id: "blank", value_eur: null, latest_touch_at: "2026-10-10T00:00:00Z" }),
    listing({ id: "never", latest_touch_at: null }),
    listing({ id: "hold", value_eur: "1", on_hold: true, latest_touch_at: null }),
    listing({ id: "closed", value_eur: "1", status: "closed" }),
    listing({ id: "d1", kind: "demand", max_price: "120" }),
    listing({ id: "d2", kind: "demand", max_price: null }),
  ];
  it("counts open supply with a value, open requests with a max price, and quiet supply, leaving out holds and closed", () => {
    expect(orderBook(rows, NOW)).toEqual({ open: 3, priced: 1, quiet: 2, buy_boxes: 2, buy_boxes_priced: 1 });
  });
});

describe("offers made", () => {
  it("counts offers past candidate in the last 30 days and per week, firm ones apart", () => {
    const offers = [offer({ stage: "candidate", created_at: "2026-10-20T00:00:00Z" }),
      offer({ created_at: "2026-09-29T20:11:19Z", firmness: "firm" }), offer({ stage: "declined", created_at: "2026-10-13T00:00:00Z" }),
      offer({ stage: "paid", created_at: "2026-10-20T00:00:00Z", firmness: "firm" })];
    const out = offerSummary(offers, NOW);
    expect(out).toMatchObject({ since: "2026-09-29T20:11:19Z", total_30d: 3, firm_30d: 2 });
    expect(out.weekly.map((w) => [w.week_start, w.all, w.firm])).toEqual([["2026-09-28", 1, 1], ["2026-10-05", 0, 0], ["2026-10-12", 1, 0], ["2026-10-19", 1, 1]]);
    expect(offerSummary([], NOW)).toEqual({ since: null, total_30d: 0, firm_30d: 0, weekly: [] });
  });
});

describe("counterparties on open listings", () => {
  it("places each live offer at its step and counts who moved past Offered", () => {
    const rows: BulkRows = {
      listings: [listing({ id: "open" }), listing({ id: "shut", status: "closed" })],
      offers: [offer({ bulk_listing_id: "open", stage: "candidate" }), offer({ bulk_listing_id: "open", stage: "offered" }),
        offer({ bulk_listing_id: "open", stage: "signed" }), offer({ bulk_listing_id: "open", stage: "declined" }), offer({ bulk_listing_id: "shut", stage: "offered" })],
    };
    const out = counterpartySteps(rows);
    expect(out.steps.map((s) => [s.label, s.count])).toEqual([["Candidate", 1], ["Offered", 1], ["Negotiating", 0], ["Agreed", 1], ["Paid", 0]]);
    expect([out.offered_passed, out.offered_total]).toEqual([1, 2]);
    expect(bulkHome(rows, NOW)).toMatchObject({ lost_this_month: 1, order_book: { open: 1 } });
  });
});
