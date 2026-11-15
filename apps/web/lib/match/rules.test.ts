import { describe, expect, it } from "vitest";
import { buildProductKey } from "./product-key";
import {
  filteredPastAsks, isLead, lineEvidence, priceKey, productTier, rankA1, rankBuyers, ruleOut,
  supplyFactsFromKey, type BuyerFacts, type BuyerLine, type SupplyFacts,
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

describe("buyer interest lines as evidence", () => {
  const AS_OF_LIVE = "2026-11-15";
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
  const lot = supplies[0];

  const line = (overrides: Partial<BuyerLine> = {}): BuyerLine => ({
    kind: "standing", productKey: "part:SU001B5189", make: null, model: null, format: "pack", chemistry: null,
    kwhMin: null, kwhMax: null, firstSeen: "2026-10-01", lastSeen: "2026-10-01", expiresOn: null, ...overrides,
  });
  const plain = (id: string, lines: BuyerLine[] | null = null, overrides: Partial<BuyerFacts> = {}) =>
    buyer({ id, name: id, profile: { chemistries: ["NMC"], formats: ["Packs"] }, lines, ...overrides });

  describe("line fit", () => {
    it("fits on the lot's own key and on every broader key it counts as", () => {
      const keys = (lines: BuyerLine[]) => lineEvidence(lot, plain("b", lines), AS_OF_LIVE).best?.line.productKey ?? null;
      expect(keys([line()])).toBe("part:SU001B5189");
      expect(keys([line({ kind: "saved_search", productKey: "broad:toyota-nmc-packs" })])).toBe("broad:toyota-nmc-packs");
      expect(keys([line({ kind: "saved_search", productKey: "broad:nmc-packs" })])).toBe("broad:nmc-packs");
      expect(keys([line({ productKey: "part:OTHER123" })])).toBeNull();
      expect(keys([line({ kind: "saved_search", productKey: "broad:lfp-packs" })])).toBeNull();
    });

    it("fits a mixed lot when it fits any lot line", () => {
      const mixed = [lot, { ...lot, partNumber: null, make: "Nissan", model: "Leaf", chemistry: "NMC", kwh: 40 }];
      const leaf = plain("b", [line({ kind: "ask", productKey: "model:nissan-leaf-40kwh" })]);
      expect(lineEvidence(lot, leaf, AS_OF_LIVE).best).toBeNull();
      expect(lineEvidence(mixed[1], leaf, AS_OF_LIVE).best?.tier).toBe(3);
      const ranked = rankBuyers(mixed, [leaf], { asOf: AS_OF_LIVE });
      expect(ranked.ranked[0].productTier).toBe(3);
      expect(ranked.ranked[0].fits).toMatch(/^Ask: /);
    });

    it("applies a kWh range to a broad line, with today's tolerance", () => {
      const range = (min: number, max: number) => lineEvidence(lot, plain("b", [line({ kind: "interest", productKey: "broad:nmc-packs", kwhMin: min, kwhMax: max })]), AS_OF_LIVE).best;
      expect(range(40, 60)).not.toBeNull();
      expect(range(52, 60)).not.toBeNull(); // 50 is within 15% of 52
      expect(range(70, 90)).toBeNull();
      expect(range(10, 40)).toBeNull();
    });

    it("ignores an expired line and a line that has not started", () => {
      expect(lineEvidence(lot, plain("b", [line({ expiresOn: "2026-11-14" })]), AS_OF_LIVE).best).toBeNull();
      expect(lineEvidence(lot, plain("b", [line({ expiresOn: "2026-11-15" })]), AS_OF_LIVE).best).not.toBeNull();
      expect(lineEvidence(lot, plain("b", [line({ firstSeen: "2026-12-01" })]), AS_OF_LIVE).best).toBeNull();
    });
  });

  describe("product tier", () => {
    it("lifts a buyer to the line's tier and keeps today's tier when it is higher", () => {
      const today = rankBuyers(supplies, [plain("b")], { asOf: AS_OF_LIVE, key }).ranked[0];
      expect(today.productTier).toBe(1);
      expect(rankBuyers(supplies, [plain("b", [line({ kind: "bought" })])], { asOf: AS_OF_LIVE, key }).ranked[0].productTier).toBe(4);
      const withModel = plain("m", [line({ kind: "saved_search", productKey: "broad:nmc-packs" })], { profile: { chemistries: ["NMC"], formats: ["Packs"], makes: ["Toyota"] } });
      expect(rankBuyers(supplies, [withModel], { asOf: AS_OF_LIVE, key }).ranked[0].productTier).toBe(2);
    });

    it("never lifts above today's tier on a broad inferred line", () => {
      const inferred = plain("b", [line({ kind: "inferred", productKey: "broad:toyota-nmc-packs" })]);
      const ranked = rankBuyers(supplies, [inferred], { asOf: AS_OF_LIVE, key }).ranked[0];
      expect(ranked.productTier).toBe(1);
      expect(ranked.fits).toBe(rankBuyers(supplies, [plain("b")], { asOf: AS_OF_LIVE, key }).ranked[0].fits);
    });

    it("brings a lines-only buyer into the list", () => {
      const only = buyer({ id: "x", name: "Lines only", profile: {}, lines: [line({ kind: "ask" })] });
      const ranked = rankBuyers(supplies, [only], { asOf: AS_OF_LIVE, key });
      expect(ranked.ranked.map((row) => [row.companyId, row.productTier])).toEqual([["x", 4]]);
    });

    it("never rules anyone out: the rules still decide", () => {
      const lfp = buyer({ id: "l", name: "LFP only", profile: { chemistries: ["LFP"], formats: ["Packs"] }, lines: [line({ kind: "bought" })] });
      const ranked = rankBuyers(supplies, [lfp], { asOf: AS_OF_LIVE, key });
      expect(ranked.ranked).toHaveLength(0);
      expect(ranked.ruledOut[0].code).toBe("chemistry");
    });
  });

  describe("ordering", () => {
    const order = (buyers: BuyerFacts[]) => rankBuyers(supplies, buyers, { asOf: AS_OF_LIVE, key }).ranked.map((row) => row.companyId);

    it("breaks a tier tie by line kind, then recency, ahead of price and stage", () => {
      const priced = { dossier: { frontmatter: { products: [], price: [{ eur_per_kwh: 99, basis: "paid", seen: "2026-01-01" }] }, body: "" } };
      const standing = plain("standing", [line({ kind: "standing" })], { stage: "Customer", ...priced });
      const bought = plain("bought", [line({ kind: "bought" })], { stage: "Contacted" });
      const askOld = plain("ask-old", [line({ kind: "ask", lastSeen: "2026-09-01" })]);
      const askNew = plain("ask-new", [line({ kind: "ask", lastSeen: "2026-11-01" })]);
      expect(order([standing, askOld, bought, askNew])).toEqual(["bought", "ask-new", "ask-old", "standing"]);
    });

    it("keeps today's order among buyers with no fitting line", () => {
      const a = plain("a", null, { stage: "Customer" });
      const b = plain("b", null, { stage: "Contacted" });
      const c = plain("c", [line({ productKey: "part:OTHER" })], { stage: "Qualified" });
      expect(order([b, c, a])).toEqual(order([b, c, a].map((entry) => ({ ...entry, lines: null }))));
      expect(order([b, c, a])).toEqual(["a", "c", "b"]);
    });
  });

  describe("row text and checks", () => {
    it("cites the best specific line with its date, quantity and price, and up to two more", () => {
      const rich = plain("r", [
        line({ kind: "bought", productKey: "part:SU001B5189", make: "Toyota", model: "Proace", kwhMin: 50, kwhMax: 50, lastSeen: "2026-06-16", quantity: 3, quantityUnit: "packs", price: 2950, priceCurrency: "GBP", priceUnit: "pack" }),
        line({ kind: "ask", productKey: "broad:toyota-nmc-packs", lastSeen: "2026-09-02" }),
        line({ kind: "saved_search", productKey: "broad:nmc-packs", firstSeen: "2026-10-03", lastSeen: "2026-11-01" }),
        line({ kind: "interest", productKey: "broad:nmc-packs", lastSeen: "2026-08-01" }),
      ]);
      const row = rankBuyers(supplies, [rich], { asOf: AS_OF_LIVE, key }).ranked[0];
      expect(row.fits).toBe("Bought: Toyota Proace, packs, 50 kWh, 16 Jun, 3 packs, GBP 2,950/pack. Also: Ask: packs, 2 Sep; Saved search: packs, active since 3 Oct");
    });

    it("keeps today's wording first when a line is weaker than today's tier", () => {
      const weak = plain("w", [line({ kind: "saved_search", productKey: "broad:nmc-packs" })], { profile: { chemistries: ["NMC"], formats: ["Packs"], makes: ["Toyota"] } });
      const row = rankBuyers(supplies, [weak], { asOf: AS_OF_LIVE, key }).ranked[0];
      expect(row.fits).toMatch(/^Same make: .*\. Also: Saved search: /);
    });

    it("adds a check when the buyer declined this product before", () => {
      const declined = plain("d", [
        line({ kind: "declined", productKey: "part:SU001B5189", lastSeen: "2026-08-20", declineReason: "price too high" }),
        line({ kind: "ask", productKey: "part:SU001B5189", lastSeen: "2026-10-01" }),
      ]);
      const row = rankBuyers(supplies, [declined], { asOf: AS_OF_LIVE, key }).ranked[0];
      expect(row.checks).toContain("Declined before: price too high, 20 Aug");
      // A decline never counts as evidence of interest, and a broad decline adds nothing.
      const onlyDeclined = plain("e", [line({ kind: "declined", productKey: "part:SU001B5189" }), line({ kind: "declined", productKey: "broad:nmc-packs" })]);
      expect(rankBuyers(supplies, [onlyDeclined], { asOf: AS_OF_LIVE, key }).ranked[0].productTier).toBe(1);
      expect(lineEvidence(lot, plain("f", [line({ kind: "declined", productKey: "broad:nmc-packs" })]), AS_OF_LIVE).declined).toBeNull();
    });
  });

  describe("without lines (flag off)", () => {
    it("is identical to a buyer that has no lines at all", () => {
      const buyers = [
        plain("a", null, { stage: "Customer" }),
        plain("b", null, { profile: { makes: ["Toyota"], formats: ["Packs"] } }),
        plain("c", null, { dossier: { frontmatter: { products: [{ part_number: "SU001B5189", format: "packs", chemistry: "NMC", kwh: [50], status: "asked" }] }, body: "" } }),
        plain("d", null, { profile: { chemistries: ["LFP"], formats: ["Packs"] } }),
      ];
      const off = rankBuyers(supplies, buyers, { asOf: AS_OF_LIVE, key });
      const empty = rankBuyers(supplies, buyers.map((entry) => ({ ...entry, lines: [] })), { asOf: AS_OF_LIVE, key });
      expect(empty).toEqual(off);
      expect(off.ranked.map((row) => [row.companyId, row.productTier, row.fits])).toEqual([
        ["c", 4, "Same part number: 50 kWh packs NMC"],
        ["b", 2, "Same make: 50 kWh packs NMC"],
        ["a", 1, "Chemistry and format only: 50 kWh packs NMC"],
      ]);
      expect(rankA1(lot, buyers, AS_OF_LIVE).map((row) => row.companyId)).toEqual(["c", "b", "a"]);
    });
  });
});
