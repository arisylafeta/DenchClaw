import { describe, expect, it } from "vitest";
import {
  BULK_TAKE_TARGET_GBP, baselineAverage, baselineRange, bulkWeekly, buildOkr, cumulative, drawnWeeks, krStatus,
  offerValueGbp, periodPosition, type BulkRows,
} from "./okr";

const NOW = new Date("2026-11-09T16:00:00Z");

describe("quarter", () => {
  it("draws 8 lead weeks and the 13 quarter weeks, Monday 30 Nov to Monday 22 Feb", () => {
    const { weeks, period_index } = drawnWeeks();
    expect(weeks).toHaveLength(21);
    expect(weeks[period_index]).toBe("2026-11-30");
    expect(weeks.at(-1)).toBe("2027-02-22");
    expect(weeks[0]).toBe("2026-10-05");
  });

  it("is not started before 1 Dec and runs 90 days", () => {
    const before = periodPosition(NOW);
    expect(before).toMatchObject({ started: false, ended: false, days: 90, day: 0 });
    expect(periodPosition(new Date("2027-01-15T12:00:00Z"))).toMatchObject({ started: true, day: 46 });
    expect(periodPosition(new Date("2027-03-01T00:00:00Z"))).toMatchObject({ ended: true, day: 90 });
  });

  it("baselines on the four complete weeks before now while the quarter is ahead", () => {
    const { weeks, period_index } = drawnWeeks();
    // 9 Nov is in week 5 (index 5): complete weeks are 1..4.
    expect(baselineRange(weeks, period_index, NOW)).toEqual({ from: 1, to: 4 });
    // Once the quarter has started it is the four weeks before the quarter.
    expect(baselineRange(weeks, period_index, new Date("2027-01-20T00:00:00Z"))).toEqual({ from: 4, to: 7 });
  });

  it("averages only the weeks that have a number", () => {
    expect(baselineAverage({ values: [null, 2, 4, null] }, { from: 0, to: 3 })).toBe(3);
    expect(baselineAverage({ values: [null, null] }, { from: 0, to: 1 })).toBeNull();
  });
});

describe("offerValueGbp", () => {
  it("multiplies price by quantity and converts currency", () => {
    expect(offerValueGbp({ amount: 30.8, unit: "cell", quantity: 13104, currency: "EUR" })).toBeCloseTo(30.8 * 13104 * 0.86, 1);
    expect(offerValueGbp({ amount: "0.75", unit: "cell", quantity: "677000", currency: "USD" })).toBeCloseTo(0.75 * 677000 * 0.79, 1);
  });
  it("takes the price as the total for a single pack or an unlabelled amount", () => {
    expect(offerValueGbp({ amount: 2200, unit: "pack", quantity: null, currency: "EUR" })).toBeCloseTo(1892, 5);
    expect(offerValueGbp({ amount: 2450, unit: "", quantity: null, currency: "GBP" })).toBe(2450);
  });
  it("has no value for a per-cell or per-kWh price without a quantity, or an unknown currency", () => {
    expect(offerValueGbp({ amount: 5.5, unit: "cell", quantity: null, currency: "EUR" })).toBeNull();
    expect(offerValueGbp({ amount: 11.5, unit: "kWh", quantity: null, currency: "EUR" })).toBeNull();
    expect(offerValueGbp({ amount: 100, unit: "pack", quantity: null, currency: "JPY" })).toBeNull();
    expect(offerValueGbp({ amount: null, unit: "pack", quantity: null, currency: "GBP" })).toBeNull();
  });
});

const offer = (over: Partial<BulkRows["offers"][number]>): BulkRows["offers"][number] => ({
  id: "o", bulk_listing_id: "l1", stage: "offered", created_at: "2026-10-14T10:00:00Z", updated_at: "2026-10-14T10:00:00Z",
  last_touch_on: null, amount: null, unit: null, quantity: null, currency: null, take_gbp: null, ...over,
});

describe("bulkWeekly", () => {
  const { weeks } = drawnWeeks();
  const rows: BulkRows = {
    listings: [
      { id: "l1", kind: "supply", status: "open", closed_reason: null, created_at: "2026-10-13T09:00:00Z" },
      { id: "l2", kind: "demand", status: "closed", closed_reason: "research_profile", created_at: "2026-10-13T09:00:00Z" },
      { id: "l3", kind: "demand", status: "closed", closed_reason: "sold", created_at: "2026-10-20T09:00:00Z" },
    ],
    offers: [
      offer({ id: "a", amount: 1000, unit: "pack", currency: "GBP" }),
      offer({ id: "b", bulk_listing_id: "l3", stage: "paid", created_at: "2026-10-14T10:00:00Z", updated_at: "2026-10-28T10:00:00Z", amount: 2450, currency: "GBP", take_gbp: 300 }),
      offer({ id: "c", bulk_listing_id: "l3", stage: "paid", updated_at: "2026-10-28T11:00:00Z", amount: 1500, currency: "GBP" }),
      offer({ id: "d", stage: "declined", updated_at: "2026-11-03T10:00:00Z" }),
      offer({ id: "e", stage: "candidate" }),
      offer({ id: "f", stage: "offered", created_at: "2026-09-10T10:00:00Z", updated_at: "2026-09-10T10:00:00Z" }),
    ],
    touches: [
      { bulk_listing_id: "l1", occurred_at: "2026-10-15T10:00:00Z" },
      { bulk_listing_id: "l1", occurred_at: "2026-10-16T10:00:00Z" },
      { bulk_listing_id: "l2", occurred_at: "2026-10-16T10:00:00Z" },
    ],
  };
  const out = bulkWeekly(rows, weeks, NOW);
  const w = (iso: string) => weeks.indexOf(iso);

  it("counts new deals without research profiles", () => {
    expect(out.new_deals[w("2026-10-12")]).toBe(1);
    expect(out.new_deals[w("2026-10-19")]).toBe(1);
    expect(out.new_deals_value[w("2026-10-12")]).toBe(1000);
  });
  it("counts a deal active once per week however often it was touched, and ignores non-deals", () => {
    expect(out.active_deals[w("2026-10-12")]).toBe(1);
  });
  it("counts offers made but not candidates, with value only where it is known", () => {
    expect(out.offers[w("2026-10-12")]).toBe(4);
    expect(out.offers_value[w("2026-10-12")]).toBe(1000 + 2450 + 1500);
    expect(out.valued).toMatchObject({ offers: 3, offers_total: 4 });
  });
  it("counts paid offers in the week they were last updated, with take and the ones missing it", () => {
    expect(out.closed[w("2026-10-26")]).toBe(2);
    expect(out.closed_value[w("2026-10-26")]).toBe(3950);
    expect(out.take_gbp[w("2026-10-26")]).toBe(300);
    expect(out.closed_without_take).toBe(1);
  });
  it("counts declined offers by update week and offers quiet for 21 days", () => {
    expect(out.abandoned[w("2026-11-02")]).toBe(1);
    expect(out.quiet_offers).toBeGreaterThanOrEqual(1);
  });
  it("leaves weeks before the first bulk records unknown", () => {
    expect(out.new_deals[w("2026-10-05")]).toBe(0);
    expect(out.offers[0]).toBe(0);
    const early = bulkWeekly(rows, ["2026-08-31", "2026-09-07"], NOW);
    expect(early.offers).toEqual([null, 1]);
  });
});

describe("key results", () => {
  const position = (iso: string) => periodPosition(new Date(iso));
  it("reads status against an even run to target", () => {
    expect(krStatus(0, 100, position("2026-11-09T00:00:00Z"))).toBe("not_started");
    expect(krStatus(null, 100, position("2027-01-15T00:00:00Z"))).toBe("no_data");
    expect(krStatus(100, 100, position("2027-01-15T00:00:00Z"))).toBe("met");
    expect(krStatus(50, 100, position("2027-01-15T12:00:00Z"))).toBe("on_track");
    expect(krStatus(20, 100, position("2027-01-15T12:00:00Z"))).toBe("behind");
  });
  it("accumulates the quarter's weeks up to the week in progress", () => {
    const values = Array.from({ length: 21 }, (_, i) => (i >= 8 ? 1 : 0));
    const cum = cumulative(values, 8, 10);
    expect(cum.slice(0, 4)).toEqual([1, 2, 3, null]);
    expect(cumulative(values, 8, null).at(-1)).toBe(13);
  });
});

describe("buildOkr", () => {
  it("builds with no sources, showing nothing as zero and explaining why", () => {
    const data = buildOkr({ now: NOW, platform: null, pulse: [], pulseCollectedAt: null, bulk: null, progress: {}, errors: { platform: true, crm: true } });
    expect(data.krs.find((k) => k.key === "mkt_paid")).toMatchObject({ actual: null, status: "no_data" });
    expect(data.krs.find((k) => k.key === "bulk_take")).toMatchObject({ actual: null, target: BULK_TAKE_TARGET_GBP });
    expect(data.groups.flatMap((g) => g.kpis).every((k) => k.values.every((v) => v === null))).toBe(true);
    expect(data.health.filter((h) => h.warn).length).toBeGreaterThanOrEqual(2);
    expect(data.current_index).toBe(5);
  });
  it("reads the SOP milestone from hand-kept progress", () => {
    const data = buildOkr({
      now: new Date("2027-01-10T00:00:00Z"), platform: null, pulse: [], pulseCollectedAt: null, bulk: null,
      progress: { bulk_sop: { percent: 40, note: "Draft outline agreed", updated_at: "2027-01-09T10:00:00Z" } },
      errors: { platform: false, crm: false },
    });
    expect(data.krs.find((k) => k.key === "bulk_sop")).toMatchObject({ actual: 40, status: "on_track", note: "Draft outline agreed" });
  });
});
