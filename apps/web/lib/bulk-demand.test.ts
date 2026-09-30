import { describe, expect, it } from "vitest";
import { checkReason, cleanSpec, demandRank, parseDemandInput, parseSpec, priceLabel, specLines, volumeLabel } from "./bulk-demand";

const TODAY = "2026-09-30";
const open = { status: "open" as const, needed_by: null, confirmed_on: null, observed_on: null };

describe("parseDemandInput", () => {
  it("defaults a new row to a stated standing buy-box", () => {
    expect(parseDemandInput({ buyer: "STN", wants: "Tested packs, 7 to 8 a month" }, true))
      .toEqual({ value: { buyer: "STN", wants: "Tested packs, 7 to 8 a month", kind: "standing", basis: "stated", needed_by: null } });
  });

  it("keeps a needed-by date on requests only, and a basis on standing buy-boxes only", () => {
    expect(parseDemandInput({ buyer: "B", wants: "W", kind: "request", needed_by: "2026-10-20" }, true))
      .toMatchObject({ value: { kind: "request", basis: null, needed_by: "2026-10-20" } });
    expect(parseDemandInput({ buyer: "B", wants: "W", kind: "standing", needed_by: "2026-10-20" }, true))
      .toEqual({ error: "A standing buy-box has no needed-by date; make it a request instead." });
    expect(parseDemandInput({ buyer: "B", wants: "W", kind: "request", basis: "agreed" }, true))
      .toEqual({ error: "A request has no basis; only standing buy-boxes do." });
  });

  it("checks volume, price and spec", () => {
    expect(parseDemandInput({ volume: 200, volume_unit: "packs", max_price: 20, price_currency: "EUR", price_unit: "kWh" }, false))
      .toEqual({ value: { volume: 200, volume_unit: "packs", max_price: 20, price_currency: "EUR", price_unit: "kWh" } });
    expect(parseDemandInput({ volume: 200, volume_unit: null }, false)).toEqual({ error: "Give both a volume and its unit, or neither." });
    expect(parseDemandInput({ max_price: 20 }, false)).toEqual({ error: "A max price needs a currency and a unit; clear all three together." });
    // Pairs go together, so a create or an edit can never leave half a pair for the database to refuse.
    expect(parseDemandInput({ buyer: "Acme", wants: "Packs", volume: 100 }, true)).toEqual({ error: "Give both a volume and its unit, or neither." });
    expect(parseDemandInput({ max_price: null }, false)).toMatchObject({ error: expect.stringContaining("clear all three together") });
    expect(parseDemandInput({ max_price: null, price_currency: null, price_unit: null }, false))
      .toEqual({ value: { max_price: null, price_currency: null, price_unit: null } });
    expect(parseDemandInput({ volume: -1 }, false)).toEqual({ error: "volume must be a positive number." });
    expect(parseDemandInput({ volume_unit: "barrels" }, false)).toMatchObject({ error: expect.stringContaining("volume_unit must be one of") });
    expect(parseDemandInput({ spec: { chemistries: ["Graphene"] } }, false)).toMatchObject({ error: expect.stringContaining("spec.chemistries") });
  });
});

describe("parseSpec and cleanSpec", () => {
  it("accepts list values from the shared lists and in-range numbers", () => {
    expect(parseSpec({ chemistries: ["LFP", "LFP", "NMC"], min_soh: 70, kwh_min: 30, kwh_max: 60, mixed_ok: false, formats: [] }))
      .toEqual({ value: { chemistries: ["LFP", "NMC"], min_soh: 70, kwh_min: 30, kwh_max: 60, mixed_ok: false } });
    expect(parseSpec({ min_soh: 150 })).toMatchObject({ error: expect.stringContaining("spec.min_soh") });
    expect(parseSpec({ kwh_min: 60, kwh_max: 30 })).toEqual({ error: "spec.kwh_min is above spec.kwh_max." });
    expect(parseSpec({ colour: ["red"] })).toEqual({ error: "Unknown spec field: colour" });
  });

  it("keeps the valid parts of a model-written spec", () => {
    expect(cleanSpec({ chemistries: ["LFP", "Graphene"], formats: ["Packs"], colour: ["red"] })).toEqual({ chemistries: ["LFP"], formats: ["Packs"] });
    expect(cleanSpec({ chemistries: ["LFP"], min_soh: 150 })).toEqual({ chemistries: ["LFP"] });
    expect(cleanSpec("LFP")).toEqual({});
  });
});

describe("checkReason", () => {
  it("flags a request past its date, a stale stated or agreed buy-box, and an old estimate", () => {
    expect(checkReason({ ...open, kind: "request", basis: null, needed_by: "2026-09-29" }, TODAY)).toBe("past_needed_by");
    expect(checkReason({ ...open, kind: "request", basis: null, needed_by: "2026-10-20" }, TODAY)).toBeNull();
    expect(checkReason({ ...open, kind: "request", basis: null }, TODAY)).toBeNull();
    expect(checkReason({ ...open, kind: "standing", basis: "agreed", confirmed_on: "2026-07-01" }, TODAY)).toBe("still_wanted");
    expect(checkReason({ ...open, kind: "standing", basis: "stated", confirmed_on: "2026-09-01" }, TODAY)).toBeNull();
    expect(checkReason({ ...open, kind: "standing", basis: "estimated", observed_on: "2026-07-01" }, TODAY)).toBeNull();
    expect(checkReason({ ...open, kind: "standing", basis: "estimated", observed_on: "2026-02-01" }, TODAY)).toBe("re_research");
    expect(checkReason({ ...open, status: "closed", kind: "request", basis: null, needed_by: "2026-01-01" }, TODAY)).toBeNull();
  });
});

describe("labels", () => {
  it("describes volume, price, spec and rank", () => {
    expect(volumeLabel({ kind: "standing", volume: 200, volume_unit: "packs", quantity: "200 a month" })).toBe("200 packs a month");
    expect(volumeLabel({ kind: "request", volume: 10000, volume_unit: "cells", quantity: null })).toBe("10,000 cells");
    expect(volumeLabel({ kind: "request", volume: null, volume_unit: null, quantity: "Large" })).toBe("Large");
    expect(priceLabel({ max_price: 20, price_currency: "EUR", price_unit: "kWh" })).toBe("EUR 20/kWh");
    expect(specLines({ chemistries: ["LFP"], min_soh: 70, mixed_ok: false })).toEqual(["Chemistry: LFP", "Min SOH %: 70", "One make and model per batch"]);
    expect([demandRank({ kind: "standing", basis: "estimated" }), demandRank({ kind: "request", basis: null }),
      demandRank({ kind: "standing", basis: "agreed" })]).toEqual([3, 0, 1]);
  });
});
