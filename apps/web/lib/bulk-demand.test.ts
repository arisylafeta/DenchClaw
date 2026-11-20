import { describe, expect, it } from "vitest";
import { TEST_REGISTRY } from "./bulk-registry.fixture";
import { checkReason, cleanSpec, demandRank, floorAboveCeiling, parseDemandInput, parseSpec, priceLabel, specLines, volumeLabel } from "./bulk-demand";

const TODAY = "2026-09-30";
const open = { status: "open" as const, needed_by: null, confirmed_on: null, observed_on: null };

describe("parseDemandInput", () => {
  it("defaults a new row to a stated standing buy-box", () => {
    expect(parseDemandInput({ buyer: "STN", wants: "Tested packs, 7 to 8 a month" }, true, TEST_REGISTRY))
      .toEqual({ value: { buyer: "STN", wants: "Tested packs, 7 to 8 a month", kind: "standing", basis: "stated", needed_by: null } });
  });
  it("validates ranking and qualification fields, preserving zero and unknown fees", () => {
    const fields = { product_family: "VW MEB", fee_eur: 0, price_basis: "buyer", reputation: "paid",
      status: "qualifying", qualify_question: "How many?" };
    expect(parseDemandInput(fields, false, TEST_REGISTRY)).toEqual({ value: fields });
    expect(parseDemandInput({ fee_eur: null, price_basis: null, reputation: null }, false, TEST_REGISTRY))
      .toEqual({ value: { fee_eur: null, price_basis: null, reputation: null } });
    expect(parseDemandInput({ fee_eur: -1 }, false, TEST_REGISTRY)).toHaveProperty("error");
    expect(parseDemandInput({ fee_eur: Number.NaN }, false, TEST_REGISTRY)).toHaveProperty("error");
    expect(parseDemandInput({ reputation: "great" }, false, TEST_REGISTRY)).toHaveProperty("error");
    expect(parseDemandInput({ status: "pending" }, false, TEST_REGISTRY)).toHaveProperty("error");
  });

  it("keeps a needed-by date on requests only, and a basis on standing buy-boxes only", () => {
    expect(parseDemandInput({ buyer: "B", wants: "W", kind: "request", needed_by: "2026-10-20" }, true, TEST_REGISTRY))
      .toMatchObject({ value: { kind: "request", basis: null, needed_by: "2026-10-20" } });
    expect(parseDemandInput({ buyer: "B", wants: "W", kind: "standing", needed_by: "2026-10-20" }, true, TEST_REGISTRY))
      .toEqual({ error: "A standing buy-box has no needed-by date; make it a request instead." });
    expect(parseDemandInput({ buyer: "B", wants: "W", kind: "request", basis: "agreed" }, true, TEST_REGISTRY))
      .toEqual({ error: "A request has no basis; only standing buy-boxes do." });
  });

  it("checks volume, price and spec", () => {
    expect(parseDemandInput({ volume: 200, volume_unit: "packs", max_price: 20, price_currency: "EUR", price_unit: "kWh" }, false, TEST_REGISTRY))
      .toEqual({ value: { volume: 200, volume_unit: "packs", max_price: 20, price_currency: "EUR", price_unit: "kWh" } });
    expect(parseDemandInput({ volume: 200, volume_unit: null }, false, TEST_REGISTRY)).toEqual({ error: "Give both a volume and its unit, or neither." });
    expect(parseDemandInput({ max_price: 20 }, false, TEST_REGISTRY)).toEqual({ error: "A max price needs a currency and a unit; clear all three together." });
    // Pairs go together, so a create or an edit can never leave half a pair for the database to refuse.
    expect(parseDemandInput({ buyer: "Acme", wants: "Packs", volume: 100 }, true, TEST_REGISTRY)).toEqual({ error: "Give both a volume and its unit, or neither." });
    expect(parseDemandInput({ max_price: null }, false, TEST_REGISTRY)).toMatchObject({ error: expect.stringContaining("clear all three together") });
    expect(parseDemandInput({ max_price: null, price_currency: null, price_unit: null }, false, TEST_REGISTRY))
      .toEqual({ value: { max_price: null, price_currency: null, price_unit: null } });
    expect(parseDemandInput({ volume: -1 }, false, TEST_REGISTRY)).toEqual({ error: "volume must be a positive number." });
    expect(parseDemandInput({ volume_unit: "barrels" }, false, TEST_REGISTRY)).toMatchObject({ error: expect.stringContaining("volume_unit must be one of") });
    expect(parseDemandInput({ spec: { chemistries: ["Graphene"] } }, false, TEST_REGISTRY)).toMatchObject({ error: expect.stringContaining("spec.chemistries") });
  });
});

describe("parseSpec and cleanSpec", () => {
  it("accepts list values from the shared lists and in-range numbers", () => {
    expect(parseSpec({ chemistries: ["LFP", "LFP", "NMC"], min_soh: 70, kwh_min: 30, kwh_max: 60, mixed_ok: false, formats: [] }, TEST_REGISTRY))
      .toEqual({ value: { chemistries: ["LFP", "NMC"], min_soh: 70, kwh_min: 30, kwh_max: 60, mixed_ok: false } });
    expect(parseSpec({ min_soh: 150 }, TEST_REGISTRY)).toMatchObject({ error: expect.stringContaining("spec.min_soh") });
    expect(parseSpec({ kwh_min: 60, kwh_max: 30 }, TEST_REGISTRY)).toEqual({ error: "spec.kwh_min is above spec.kwh_max." });
    expect(parseSpec({ colour: ["red"] }, TEST_REGISTRY)).toEqual({ error: "Unknown spec field: colour" });
  });

  it("keeps the valid parts of a model-written spec", () => {
    expect(cleanSpec({ chemistries: ["LFP", "Graphene"], formats: ["Packs"], colour: ["red"] }, TEST_REGISTRY)).toEqual({ chemistries: ["LFP"], formats: ["Packs"] });
    expect(cleanSpec({ chemistries: ["LFP"], min_soh: 150 }, TEST_REGISTRY)).toEqual({ chemistries: ["LFP"] });
    expect(cleanSpec("LFP", TEST_REGISTRY)).toEqual({});
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
    expect(specLines({ chemistries: ["LFP"], min_soh: 70, mixed_ok: false }, TEST_REGISTRY)).toEqual(["Chemistry: LFP", "Min SOH %: 70", "One make and model per batch"]);
    expect([demandRank({ kind: "standing", basis: "estimated" }), demandRank({ kind: "request", basis: null }),
      demandRank({ kind: "standing", basis: "agreed" })]).toEqual([3, 0, 1]);
  });
});

describe("criteria spec keys", () => {
  const registry = {
    specLists: { supplier_countries: ["Poland"], supplier_regions: ["Europe"], delivery_country: ["Poland", "Ukraine"] }, specLabels: {}, specGroups: {},
    specNumbers: { min_lot_kwh: { label: "Min lot size (kWh)", min: 0, max: 100000000 } },
    currencies: ["EUR", "USD", "GBP"], priceUnits: ["kWh", "pack", "cell"],
  } as unknown as Parameters<typeof parseSpec>[1];

  it("accepts our own filters and a whole price floor", () => {
    const parsed = parseSpec({ min_lot_kwh: 500, supplier_countries: ["Poland"], price_floor: { amount: 20, currency: "EUR", unit: "kWh" } }, registry);
    expect(parsed).toEqual({ value: { min_lot_kwh: 500, supplier_countries: ["Poland"], price_floor: { amount: 20, currency: "EUR", unit: "kWh" } } });
  });

  it("rejects an incomplete or invalid price floor", () => {
    expect(parseSpec({ price_floor: { amount: 20, currency: "EUR" } }, registry)).toHaveProperty("error");
    expect(parseSpec({ price_floor: { amount: -1, currency: "EUR", unit: "kWh" } }, registry)).toHaveProperty("error");
    expect(parseSpec({ price_floor: { amount: 5, currency: "XXX", unit: "kWh" } }, registry)).toHaveProperty("error");
    expect(parseSpec({ supplier_countries: ["Atlantis"] }, registry)).toHaveProperty("error");
  });

  it("keeps delivery_country to one country", () => {
    expect(parseSpec({ delivery_country: ["Ukraine"] }, registry)).toEqual({ value: { delivery_country: ["Ukraine"] } });
    expect(parseSpec({ delivery_country: ["Ukraine", "Poland"] }, registry)).toHaveProperty("error");
  });

  it("refuses a price floor above the ceiling in the same currency and unit, server side", () => {
    const floor = (amount: number, currency = "EUR") => ({ amount, currency, unit: "kWh" });
    expect(floorAboveCeiling({ price_floor: floor(50) }, { max_price: 40, price_currency: "EUR", price_unit: "kWh" })).toMatch(/above the ceiling/);
    expect(floorAboveCeiling({ price_floor: floor(30) }, { max_price: 40, price_currency: "EUR", price_unit: "kWh" })).toBeNull();
    expect(floorAboveCeiling({ price_floor: floor(50, "USD") }, { max_price: 40, price_currency: "EUR", price_unit: "kWh" })).toBeNull();
    expect(floorAboveCeiling({ price_floor: floor(50) }, { max_price: null, price_currency: null, price_unit: null })).toBeNull();
    // A body carrying both halves is refused by the parser.
    const body = { spec: { price_floor: floor(50) }, max_price: 40, price_currency: "EUR", price_unit: "kWh" };
    expect(parseDemandInput(body, false, TEST_REGISTRY)).toHaveProperty("error");
    expect(parseDemandInput({ ...body, spec: { price_floor: floor(30) } }, false, TEST_REGISTRY)).not.toHaveProperty("error");
  });
});
