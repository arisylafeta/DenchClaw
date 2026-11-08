import { describe, expect, it } from "vitest";
import { buildProductKey } from "./product-key";
import {
  filteredPastAsks, isLead, priceKey, productTier, rankA1, rankBuyers, ruleOut,
  supplyFactsFromKey, type BuyerFacts, type SupplyFacts,
} from "./rules";

// The cases below are the ones pinned by scripts/rebattery/match_replay/test_match_replay.py, so the
// TypeScript port and the Python original answer the same questions the same way.

const listing = (overrides: Partial<SupplyFacts> = {}): SupplyFacts => ({
  title: "80 kWh NMC packs", make: "Test", model: "Model T", format: "packs", chemistry: "NMC", kwh: 80, units: 10,
  wholeBatch: false, ...overrides,
});

const buyer = (overrides: Partial<BuyerFacts> = {}): BuyerFacts => ({
  id: "b1", name: "Buyer One", stage: "Qualified", tier: "B", basis: "stated",
  lastTouch: "2026-01-01T00:00:00+00:00",
  profile: { chemistries: ["NMC"], formats: ["Packs"] },
  dossier: null,
  ...overrides,
});

const AS_OF = "2026-03-01";

describe("rule_out", () => {
  it("rules out a stated, different chemistry", () => {
    expect(ruleOut(listing(), buyer({ profile: { chemistries: ["LFP"], formats: ["Packs"] } }))?.code).toBe("chemistry");
  });

  it("never rules out on a missing chemistry", () => {
    expect(ruleOut(listing(), buyer({ profile: { formats: ["Packs"] } }))).toBeNull();
    expect(ruleOut(listing({ chemistry: null }), buyer())).toBeNull();
  });

  it("obeys a dated rules_out entry", () => {
    const dated = buyer({
      dossier: { frontmatter: {
        products: [{ format: "packs", chemistry: "NMC", status: "asked" }],
        rules_out: { chemistries: [{ value: "NMC", seen: "2026-05-01", src: "gmail_msg_test" }] },
      } },
    });
    expect(ruleOut(listing(), dated)?.code).toBe("chemistry");
  });

  it("rules out a buyer who will not take a whole batch", () => {
    const whole = buyer({ dossier: { frontmatter: { quantity: { whole_batch_ok: false } }, body: "" } });
    expect(ruleOut(listing({ wholeBatch: true }), whole)?.code).toBe("whole_batch");
    expect(ruleOut(listing({ wholeBatch: false }), whole)).toBeNull();
  });

  it("rules out the seller's own company", () => {
    expect(ruleOut(listing({ seller: "Test Traders Ltd" }), buyer({ name: "Test Traders Ltd" }))?.code).toBe("seller");
  });

  it("rules out a stated format that is not this one", () => {
    // Their buy box says packs; this lot is a containerised system.
    expect(ruleOut(listing({ format: "systems" }), buyer())?.code).toBe("format");
  });

  it("rules out a buyer whose dossier refuses containerised systems", () => {
    const refuses = buyer({ profile: {}, dossier: { frontmatter: { products: [{ format: "packs", chemistry: "NMC", status: "asked" }], rules_out: { bess_systems: true } }, body: "" } });
    expect(ruleOut(listing({ format: "systems", chemistry: "NMC" }), refuses)?.code).toBe("bess");
  });

  it("does not rule out a capacity difference on the same platform", () => {
    const samePlatform = buyer({
      dossier: { frontmatter: { products: [{ platform: "MEB", format: "packs", chemistry: "NMC", kwh: [62], status: "asked" }] }, body: "" },
    });
    expect(ruleOut(listing({ platform: "MEB", kwh: 82 }), samePlatform)).toBeNull();
  });

  it("rules out a capacity far off a stated product on the same format", () => {
    const far = buyer({
      dossier: { frontmatter: { products: [{ format: "packs", chemistry: "NMC", kwh: [30], status: "asked" }] }, body: "" },
    });
    expect(ruleOut(listing({ kwh: 80 }), far)?.code).toBe("kwh");
  });

  it("accepts a capacity inside an open dossier range", () => {
    const open = buyer({
      dossier: { frontmatter: { products: [{ format: "packs", chemistry: "NMC", kwh_min: 30, status: "asked" }] }, body: "" },
    });
    expect(ruleOut(listing({ kwh: 80 }), open)).toBeNull();
  });

  it("compares capacity per format, not across formats", () => {
    // Their packs are 30 kWh; this lot is modules, so the pack figure is not a conflict.
    const modules = buyer({
      dossier: { frontmatter: { products: [{ format: "packs", chemistry: "NMC", kwh: [30], status: "asked" }] }, body: "" },
    });
    expect(ruleOut(listing({ format: "modules", kwh: 2.7 }), modules)).toBeNull();
  });

  it("does not rule out when a stated range covers their capacity", () => {
    const mods = buyer({
      dossier: { frontmatter: { products: [{ format: "packs", chemistry: "NMC", kwh: [40], status: "asked" }] }, body: "" },
    });
    expect(ruleOut(listing({ kwh: null, kwhMin: 35, kwhMax: 84 }), mods)).toBeNull();
    expect(ruleOut(listing({ kwh: null, kwhMin: 55, kwhMax: 84 }), mods)?.code).toBe("kwh");
  });
});

describe("product_tier", () => {
  it("puts a part number above chemistry alone", () => {
    const partBuyer = buyer({ dossier: { frontmatter: { products: [{ part_number: "PN-1", format: "packs" }] }, body: "" } });
    const chemBuyer = buyer({ id: "b2", name: "Buyer Two" });
    const lot = listing({ partNumber: "PN-1" });
    expect(productTier(lot, partBuyer, AS_OF)).toBe(4);
    expect(productTier(lot, chemBuyer, AS_OF)).toBe(1);
    expect(rankA1(lot, [chemBuyer, partBuyer], AS_OF)[0].companyId).toBe("b1");
  });

  it("strict mode ignores body keywords", () => {
    const bodyOnly = buyer({
      profile: {},
      dossier: { frontmatter: { products: [] }, body: "## Asked for\n- 2026-01-05: wanted PN-9 modules.\n" },
    });
    const lot = listing({ partNumber: "PN-9", format: "modules" });
    expect(productTier(lot, bodyOnly, AS_OF, false)).toBe(0);
    expect(productTier(lot, bodyOnly, AS_OF, true)).toBe(4);
  });

  it("ignores an undated past ask", () => {
    expect(filteredPastAsks({ past_asks: [{ wants: "PN-9" }] }, AS_OF)).toEqual([]);
    expect(filteredPastAsks({ past_asks: [{ date: "2026-01-01", wants: "PN-9" }] }, AS_OF)).toEqual(["PN-9"]);
    expect(filteredPastAsks({ past_asks: [{ date: "2026-03-01", wants: "PN-9" }] }, AS_OF)).toEqual([]);
  });
});

describe("price and ordering", () => {
  it("only orders on price when both sides are firm", () => {
    const priced = buyer({ dossier: { frontmatter: { products: [{ format: "packs", chemistry: "NMC", status: "asked" }], price: [{ eur_per_kwh: 30, basis: "paid", seen: "2026-01-05" }] }, body: "" } });
    expect(priceKey(listing({ sellerPriceEurPerKwh: 25 }), priced)).toEqual([3, 3, 0.2]);
    expect(priceKey(listing(), priced)).toEqual([2, 3, 0]);
    expect(priceKey(listing({ sellerPriceEurPerKwh: 35 }), priced)?.[0]).toBe(1);
  });

  it("marks a researched lead", () => {
    expect(isLead(buyer({ basis: "researched", stage: "Contacted" }))).toBe(false);
    expect(isLead(buyer({ basis: "researched", stage: "Identified" }))).toBe(true);
    expect(isLead(buyer({ basis: "stated", stage: null }))).toBe(false);
  });
});

describe("rank_buyers", () => {
  const key = buildProductKey({
    fields: [
      { field_key: "model", value: "Toyota Proace SU001B5189", status: "confirmed" },
      { field_key: "capacity", value: "50 kWh per pack", status: "confirmed" },
      { field_key: "chemistry", value: "NMC", status: "confirmed" },
      { field_key: "format", value: "Packs", status: "confirmed" },
      { field_key: "quantity", value: "40 packs", status: "confirmed" },
    ],
    title: "40 Toyota Proace packs",
  });
  const supplies = supplyFactsFromKey(key, { title: "40 Toyota Proace packs" });

  it("builds supply facts a buyer can be compared against", () => {
    expect(supplies).toHaveLength(1);
    expect(supplies[0]).toMatchObject({ format: "packs", chemistry: "NMC", kwh: 50, partNumber: "SU001B5189", make: "Toyota" });
  });

  it("orders a shortlist first and returns each ruled-out reason", () => {
    const strong = buyer({ id: "b1", name: "Part buyer", dossier: { frontmatter: { products: [{ part_number: "SU001B5189", format: "packs", chemistry: "NMC", kwh: [50], status: "asked" }] }, body: "" } });
    const sameMake = buyer({ id: "b2", name: "Make buyer", profile: { makes: ["Toyota"], formats: ["Packs"] } });
    const ruledOut = buyer({ id: "b3", name: "LFP buyer", profile: { chemistries: ["LFP"], formats: ["Packs"] } });
    const notAFit = buyer({ id: "b4", name: "Mismatch", profile: { chemistries: ["NMC"], formats: ["Packs"] } });
    const result = rankBuyers(supplies, [sameMake, strong, ruledOut, notAFit], {
      asOf: "2026-11-08", key, verdicts: new Map([["b2", "shortlist" as const], ["b4", "not_a_fit" as const]]),
    });
    expect(result.ranked.map((row) => row.companyId)).toEqual(["b2", "b1"]);
    expect(result.ranked[0].userVerdict).toBe("shortlist");
    expect(result.ranked[1].fits).toMatch(/part number/i);
    expect(result.ruledOut.map((row) => [row.companyId, row.code, row.kind])).toEqual([
      ["b3", "chemistry", "rule"], ["b4", "not_a_fit", "verdict"],
    ]);
    expect(result.ranked[0].checks).toContain("No firm seller price");
  });

  it("shows the product key's gaps as things to check", () => {
    const thin = buildProductKey({
      fields: [
        { field_key: "capacity", value: "75 kWh on the pack label (system records 100 kWh)", status: "conflict" },
        { field_key: "format", value: "Packs", status: "unverified" },
        { field_key: "chemistry", value: "", status: "missing" },
      ],
      title: "Lot",
    });
    const result = rankBuyers(supplyFactsFromKey(thin, { title: "Lot" }), [buyer({ id: "b1", name: "Any packs buyer", profile: { formats: ["Packs"] } })], { asOf: "2026-11-08", key: thin });
    const checks = result.ranked[0].checks.join(" | ");
    expect(checks).toMatch(/Capacity per unit is unconfirmed/);
    expect(checks).toMatch(/Chemistry is not stated/);
  });
});
