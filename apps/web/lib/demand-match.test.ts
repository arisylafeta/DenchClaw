import { describe, expect, it, vi } from "vitest";
import type { Demand } from "./bulk-demand";
import { bestLine, bySeller, fewestSellers, foldDuplicateSupply, kwhFromText, matchDemand, requirementFor, scoreCandidate, sellerKey, type Candidate } from "./demand-match";

vi.mock("server-only", () => ({}));

function demand(overrides: Partial<Demand>): Demand {
  return {
    id: "btd_t", kind: "request", basis: null, buyer: "Test buyer", company_id: null, person_id: null, contact: null, email: null,
    wants: "", quantity: null, location: null, note: null, needed_by: null, volume: null, volume_unit: null, max_price: null,
    price_currency: null, price_unit: null, spec: {}, source_kind: null, source_label: null, source_url: null, source_quote: null,
    observed_on: null, status: "open", product_family: null, fee_eur: null, price_basis: null, reputation: null, qualify_question: null,
    qualify_asked_on: null, qualify_entered_on: null, activity_count: 0, last_activity_at: null, moved_to: null, asked_on: null,
    score: null, expected_fee: null, has_stock: false, closed_reason: null, confirmed_on: null, updated_at: "", fits: [], trades: [],
    tier: null, waiting: null, priority: false, missing: [], context_notes: [], inventory_matches: [], context: {},
    ...overrides,
  };
}

let n = 0;
function unit(overrides: Partial<Candidate>): Candidate {
  n += 1;
  return {
    key: `listing:${n}`, source: "marketplace", title: "", seller: `Seller ${n}`, make: null, model: null, format: "Packs",
    chemistry: null, cellFormat: null, kwh: null, kwhEstimated: false, units: 1, price: null, currency: "EUR", currencyAssumed: false,
    country: "GB", location: null, soh: null, year: null, partNumber: null, photos: 0, tested: false, verified: false, seen: null,
    href: "https://example.test", ai: null, alsoIn: [],
    ...overrides,
  };
}

const kona = (o: Partial<Candidate> = {}) => unit({ make: "Hyundai", model: "Kona Electric", title: "Hyundai Kona Electric 64kWh", kwh: 64, ...o });

describe("kwhFromText", () => {
  it("reads ranges, options and minimums", () => {
    expect(kwhFromText("Complete HV pack 60–80kWh")).toEqual({ min: 60, max: 80 });
    expect(kwhFromText("STLA-M 81.6/105 kWh packs")).toEqual({ options: [81.6, 105] });
    expect(kwhFromText("MEB packs, 55, 62 and 82 kWh")).toEqual({ options: [55, 62, 82] });
    expect(kwhFromText("Reusable EV packs 50kWh+ usable")).toEqual({ min: 50, max: 10_000 });
    expect(kwhFromText("no capacity here")).toBeNull();
  });
});

describe("requirementFor", () => {
  it("keeps only words sellers use as products and expands platform names", () => {
    const vocab = new Set(["hyundai", "kona", "electric", "id.3", "enyaq"]);
    const kona64 = requirementFor(demand({ product_family: "Hyundai Kona 64kWh pack", wants: "Kona packs, homogeneous lots" }), vocab);
    expect(kona64.products.map((p) => p.phrase)).toEqual(["kona"]);
    expect(kona64.kwh).toEqual({ options: [64] });
    const meb = requirementFor(demand({ wants: "VW Group MEB packs" }), vocab);
    expect(meb.products[0].anyOf).toContain("id.3");
  });

  it("reads units, buyer price in EUR per kWh and the delivery country", () => {
    const req = requirementFor(demand({ wants: "Zoe packs", quantity: "1 test pack, then 10 packs", max_price: 30, price_currency: "GBP", price_unit: "kWh", location: "Poland" }));
    expect(req.unitsNeeded).toBe(10);
    expect(req.buyerEurPerKwh).toBeCloseTo(34.8);
    expect(req.country).toBe("PL");
  });
});

describe("scoreCandidate", () => {
  const req = (o: Partial<Demand>) => requirementFor(demand(o), new Set(["hyundai", "kona", "electric", "proace", "city", "toyota", "zoe", "renault"]));

  it("drops a different model, capacity or chemistry, and keeps the right one", () => {
    const r = req({ product_family: "Hyundai Kona 64kWh pack", wants: "Kona 64 kWh", spec: { chemistries: ["NMC"] } });
    expect(scoreCandidate(r, kona())).not.toBeNull();
    expect(scoreCandidate(r, kona({ kwh: 39.2 }))).toBeNull();
    expect(scoreCandidate(r, kona({ chemistry: "LFP" }))).toBeNull();
    expect(scoreCandidate(r, unit({ make: "Renault", model: "Zoe", title: "Renault Zoe", kwh: 52 }))).toBeNull();
  });

  it("treats Proace City as a different van from the Proace", () => {
    const r = req({ wants: "Toyota Proace 50 kWh packs" });
    expect(scoreCandidate(r, unit({ make: "Toyota", model: "Proace City", title: "Toyota Proace City", kwh: 50 }))).toBeNull();
    expect(scoreCandidate(r, unit({ make: "Toyota", model: "Proace", title: "Toyota Proace", kwh: 50 }))).not.toBeNull();
  });

  it("compares prices across currencies and flags units over the buyer's budget", () => {
    const r = req({ wants: "Kona 64 kWh", max_price: 40, price_currency: "EUR", price_unit: "kWh" });
    const cheap = scoreCandidate(r, kona({ price: 1600, currency: "GBP" }))!; // ≈ €29/kWh
    expect(cheap.economics.sellerEurPerKwh).toBeCloseTo(29, 0);
    expect(cheap.economics.marginPct).toBeGreaterThan(0.2);
    const dear = scoreCandidate(r, kona({ price: 3500, currency: "EUR" }))!; // ≈ €55/kWh
    expect(dear.checks.find((c) => c.key === "price")?.state).toBe("fail");
    expect(cheap.verdict).toBe("exact");
  });

  it("ignores placeholder prices", () => {
    const r = req({ wants: "Kona 64 kWh" });
    expect(scoreCandidate(r, kona({ price: 0 }))!.economics.sellerEurPerKwh).toBeNull();
    expect(scoreCandidate(r, kona({ price: 90_000 }))!.economics.sellerEurPerKwh).toBeNull();
    expect(scoreCandidate(r, kona({ price: 10, currency: "NOK" }))!.economics.sellerEurPerKwh).toBeNull();
  });

  it("matches cells by size and rejects a different stated size", () => {
    const r = requirementFor(demand({ wants: "500,000 Samsung 50E (21700) cells", spec: { formats: ["Cells"] } }));
    expect(scoreCandidate(r, unit({ format: "Cells", title: "Samsung INR21700-50E", make: "Samsung" }))).not.toBeNull();
    expect(scoreCandidate(r, unit({ format: "Cells", title: "CBAK 26650 cells" }))).toBeNull();
    expect(scoreCandidate(r, unit({ format: "Packs", title: "21700 pack" }))).toBeNull();
  });

  it("keeps containerised storage out of an EV pack ask", () => {
    const r = requirementFor(demand({ wants: "Complete, reusable EV traction-battery packs 50kWh+", spec: { formats: ["Packs"] } }), new Set(["mg", "mg4", "byd"]));
    expect(scoreCandidate(r, unit({ title: "BYD containerised BESS", kwh: 1577 }))).toBeNull();
    expect(scoreCandidate(r, unit({ make: "MG", model: "MG4", title: "MG4", kwh: 64 }))).not.toBeNull();
  });
});

describe("matchDemand", () => {
  it("groups the same pack across sellers so a bulk ask sees total units", () => {
    const result = matchDemand(demand({ product_family: "Hyundai Kona 64kWh pack", wants: "Kona packs", quantity: "10 packs" }), [
      ...Array.from({ length: 6 }, () => kona({ price: 3000 })),
      ...Array.from({ length: 5 }, () => kona({ source: "marketplace", price: null, model: "Kona" })),
      unit({ make: "Renault", model: "Zoe", title: "Renault Zoe", kwh: 52 }),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].units).toBe(11);
    expect(result.groups[0].covers).toEqual({ have: 11, need: 10 });
    expect(bestLine(result)?.text).toContain("10/10");
  });

  it("refuses to rank everything for an ask that pins nothing down", () => {
    const result = matchDemand(demand({ wants: "Batteries please" }), [kona()]);
    expect(result.blocked).toMatch(/nothing to match on/);
    expect(result.groups).toEqual([]);
  });

  it("leaves out units marked Not a fit", () => {
    const hidden = kona();
    const result = matchDemand(demand({ wants: "Kona 64 kWh" }), [hidden, kona()], new Set([hidden.key]));
    expect(result.groups[0].matches.map((m) => m.candidate.key)).not.toContain(hidden.key);
  });

  it("uses the inbox check's judgement for trades that name no make or model", () => {
    const trade = unit({ key: "trade:t1", source: "trade", title: "Oklahoma Panasonic 2170 cells", format: "Cells", ai: { strength: "strong", reason: "Same cell size" } });
    const result = matchDemand(demand({ wants: "21700 cells", spec: { formats: ["Cells"] } }), [trade]);
    expect(result.groups[0]?.matches[0].candidate.key).toBe("trade:t1");
  });

  it("ranks Exact before Check even when the unclear unit is cheaper", () => {
    const req = { product_family: "Hyundai Kona 64kWh pack", wants: "Kona packs", quantity: "2 packs", max_price: 50, price_currency: "EUR", price_unit: "kWh" };
    const confirmed = kona({ chemistry: "NMC", soh: 90, price: 2900, model: "Kona" });
    const cheapButUnclear = unit({ make: "Hyundai", model: "Kona", title: "Hyundai Kona", kwh: null, price: 900, source: "marketplace" });
    const result = matchDemand(demand({ ...req, spec: { chemistries: ["NMC"] } }), [cheapButUnclear, confirmed]);
    expect(result.groups[0].verdict).toBe("exact");
    expect(result.groups[0].matches[0].candidate.key).toBe(confirmed.key);
    expect(result.groups[1].verdict).toBe("check");
  });

  it("sorts Exact groups cheapest first and marks an AI-only trade as Check", () => {
    const cheap = kona({ price: 1600, chemistry: "NMC" });
    const dear = unit({ make: "Hyundai", model: "Kona", title: "Hyundai Kona", kwh: 64, price: 3200, chemistry: "NMC", seller: "Other" });
    dear.model = "Kona Electric 2019"; // different group key word stays "kona"; force a separate group via kWh
    dear.kwh = 64.5;
    const trade = unit({ key: "trade:t9", source: "trade", title: "Kona packs ex-fleet", ai: { strength: "strong", reason: "Same pack" } });
    const result = matchDemand(demand({ wants: "Hyundai Kona 64 kWh", spec: { chemistries: ["NMC"] } }), [dear, trade, cheap]);
    const exact = result.groups.filter((g) => g.verdict === "exact");
    expect(exact[0].eurPerKwh!.min).toBeLessThanOrEqual(exact[exact.length - 1].eurPerKwh!.min);
    expect(result.groups.find((g) => g.key === "trade:trade:t9")?.verdict).toBe("check");
  });

  it("splits a group by seller, merging one company across sources, and finds the fewest sellers", () => {
    expect(sellerKey("LKQ SYNETIQ")).toBe(sellerKey("Synetiq"));
    expect(sellerKey("Autohandel DIDIER NV")).toBe(sellerKey("Didier"));
    const result = matchDemand(demand({ wants: "Hyundai Kona 64 kWh", quantity: "10 packs" }), [
      ...Array.from({ length: 6 }, () => kona({ seller: "LKQ SYNETIQ", price: 2000 })),
      ...Array.from({ length: 2 }, () => kona({ seller: "Synetiq", source: "marketplace", price: null })),
      ...Array.from({ length: 3 }, () => kona({ seller: "Autohandel DIDIER NV", country: "BE", price: 1800 })),
      kona({ seller: "Small Breaker", price: 1500 }),
    ]);
    const sellers = bySeller(result.groups[0].matches);
    expect(sellers.map((x) => x.units).sort()).toEqual([1, 3, 8]);
    const plan = fewestSellers(sellers, 10)!;
    expect(plan.sellers.map((x) => x.units)).toEqual([8, 2]);
    expect(plan.units).toBe(10);
  });

  it("rejects other cell sizes wherever the name states them, and cells whose energy cannot be that size", () => {
    const ask = demand({ wants: "500,000 Samsung 50E (21700) cylindrical cells", quantity: "500,000 cells", spec: { formats: ["Cells"], cell_formats: ["Cylindrical"] } });
    const cell = (o: Partial<Candidate>) => unit({ format: "Cells", units: 100_000, ...o });
    const result = matchDemand(ask, [
      cell({ title: "Samsung INR21700-50E", kwh: 0.018 }),
      cell({ title: "Voltaplex INR18650-26E", kwh: 0.0096 }),
      cell({ title: "Dalian CBAK 26650FS3 cells" }),
      cell({ title: "BMW 340Wh 93Ah 3,65V", kwh: 0.34 }),
      cell({ title: "EVE LF105 cells" }),
      cell({ title: "SK On E603 61.2ah cells" }),
      unit({ key: "trade:x", source: "trade", format: null, title: "Armex BESS decommissioning tender", ai: { strength: "partial", reason: "storage" } }),
    ]);
    expect(result.groups.flatMap((g) => g.matches.map((m) => m.candidate.title))).toEqual(["Samsung INR21700-50E"]);
  });

  it("hides lots under 1% of a bulk ask and keeps them out of the best line", () => {
    const ask = demand({ wants: "21700 cells", quantity: "500,000 cells", spec: { formats: ["Cells"] } });
    const result = matchDemand(ask, [
      unit({ format: "Cells", title: "LISHEN LR21700LH", units: 1, kwh: 0.011 }),
      unit({ format: "Cells", title: "Panasonic 2170 lot", units: 680_000, seller: "Big lot" }),
    ]);
    expect(result.groups.map((g) => g.small)).toEqual([false, true]);
    expect(bestLine(result)?.text).toContain("Panasonic");
  });
});

describe("missing quantity and price", () => {
  const cells = (o: Partial<Candidate> = {}) => unit({ format: "Cells", model: "INR18650-26E", make: "Voltaplex", title: "Voltaplex INR18650-26E 2600mAh Cells", kwh: 0.0095, units: 600, price: 0.5, currency: "USD", ...o });
  const ask = () => demand({ wants: "18650 cells", volume: 100_000, volume_unit: "cells", max_price: 1, price_currency: "EUR", price_unit: "cell" });

  it("reads a per-cell buyer price as a unit price and compares the seller per cell", () => {
    const r = requirementFor(ask(), new Set());
    expect(r.priceUnit).toBe("cell");
    const m = scoreCandidate(r, cells())!;
    expect(m.economics.sellerEurPerUnit).toBeCloseTo(0.43, 2);
    expect(m.economics.marginPct).toBeCloseTo(0.57, 2);
    expect(m.verdict).toBe("exact");
  });

  it("does not turn an unstated quantity into one unit, and never calls it Exact", () => {
    const m = scoreCandidate(requirementFor(ask(), new Set()), cells({ units: null, price: null }))!;
    expect(m.verdict).toBe("check");
    expect(m.checks.find((c) => c.key === "quantity")).toMatchObject({ state: "unknown", detail: "Quantity not stated" });
    expect(m.economics.spreadEur).toBeNull();
    const result = matchDemand(ask(), [cells({ units: null, price: null })]);
    expect(result.groups[0].units).toBe(0);
    expect(result.groups[0].unitsKnown).toBe(false);
    expect(result.groups[0].small).toBe(false); // visible, not hidden as a small lot
    expect(bestLine(result)!.text).not.toMatch(/\/100000|1 units/);
  });

  it("keeps a row with a quantity but no seller price as Check", () => {
    const m = scoreCandidate(requirementFor(ask(), new Set()), cells({ price: null }))!;
    expect(m.verdict).toBe("check");
  });

  it("keeps a cents-per-cell price instead of dropping it as a token price", () => {
    const m = scoreCandidate(requirementFor(ask(), new Set()), cells({ price: 0.05, currency: "EUR" }))!;
    expect(m.economics.sellerEurPerUnit).toBeCloseTo(0.05, 3);
  });
});

describe("foldDuplicateSupply", () => {
  const listing = unit({ key: "listing:v", seller: "Luis Diaz", make: "Voltaplex", model: "INR18650-26E", title: "Voltaplex INR18650-26E 0.01kWh", format: "Cells", units: 600 });
  const shell = (o: Partial<Candidate> = {}) => unit({ key: "supply:s", source: "supply", seller: "Luis Diaz", title: "Voltaplex INR18650-26E 2600mAh Cells", format: "Cells", units: null, ...o });

  it("folds a quantity-less supply row into the marketplace listing of the same seller and model", () => {
    const out = foldDuplicateSupply([shell()], [listing]);
    expect(out.feed).toHaveLength(0);
    expect(out.listings[0].alsoIn).toEqual(["supply"]);
    expect(listing.alsoIn).toEqual([]); // input untouched
  });

  it("keeps a supply row that states a quantity, another seller, or another model", () => {
    expect(foldDuplicateSupply([shell({ units: 50 })], [listing]).feed).toHaveLength(1);
    expect(foldDuplicateSupply([shell({ seller: "Other Co" })], [listing]).feed).toHaveLength(1);
    expect(foldDuplicateSupply([shell({ title: "Samsung 30Q cells" })], [listing]).feed).toHaveLength(1);
  });
});
