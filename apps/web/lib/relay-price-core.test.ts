import { describe, expect, it } from "vitest";
import {
  alexFill, applyFills, askKwh, askSentences, fillValue, fitLabel, lineTier, MARGIN, mergeFills, missingFill, parseFills, pennyCardFor,
  priceFor, priceGapMarker, priceGapRef, priceGaps, rankFits, readAsk, sameFills, shellOnly, tidyModel, unfilledGaps, yearFrom,
  type Fx, type PennyCard, type RankedFit,
} from "./relay-price-core";
import type { PriceFill, StockFit } from "./relay-price-types";

const FX: Fx = { gbpPerEur: 0.83595, gbpPerUsd: 0.7472, date: "2026-11-12", source: "ECB reference" };
const NOW = new Date("2026-11-20T12:00:00Z");
const OPTS = { penny: null, fx: FX, now: NOW, askedDelivered: false };

const fit = (o: Partial<StockFit> = {}): StockFit => ({
  key: "stock:sto_1", label: "Volkswagen ID.3 62 kWh, 2020", kind: "supplier",
  supplier: { name: "Parts Roberto", country: "Lithuania", email: "sales@example.com" },
  kwh: 62, year: 2020, soh: null, cost: { amount: 4500, currency: "GBP" }, listed: null, href: "/trades/stock/sto_1", ...o,
});

const ID3_CARD: PennyCard = {
  battery_key: "vw-id3-58kwh-pack", battery: "VW ID.3 / Cupra Born / Skoda Enyaq 58 kWh MEB pack", segment: "ev_pack", kwh_usable: 58,
  quick_gbp_kwh: 26.43, expected_gbp_kwh: 27.59, patient_gbp_kwh: 34.48, confidence: "Low", created_at: "2026-10-25 09:00:00+00",
};

describe("priceFor", () => {
  it("adds 12% to a supplier's price in pounds and rounds to £10", () => {
    const p = priceFor(fit(), OPTS);
    expect(p).toMatchObject({ key: "stock:sto_1", value: 5040, basis: "collected", needsDeliveryQuote: false, by: "relay", floor: 4500 });
    expect(p.working).toEqual([
      "The supplier wants £4,500.",
      "Plus margin £540 (12% of cost, at least £300): £5,040 to the nearest £10.",
      "No Penny price yet.",
    ]);
    expect(p.warnings).toEqual([]);
  });

  it("takes the £300 minimum on small costs", () => {
    expect(priceFor(fit({ cost: { amount: 1000, currency: "GBP" } }), OPTS).value).toBe(1300);
    expect(MARGIN).toEqual({ share: 0.12, minimumGbp: 300, roundToGbp: 10 });
  });

  it("converts a euro cost and shows the rate", () => {
    const p = priceFor(fit({ cost: { amount: 4000, currency: "EUR" } }), OPTS);
    // €4,000 × 0.83595 = £3,343.80; + 12% (£401) = £3,745 → £3,750.
    expect(p.value).toBe(3750);
    expect(p.floor).toBe(3344);
    expect(p.working[0]).toBe("The supplier wants €4,000.");
    expect(p.working[1]).toBe("At €1 = £0.83595 (ECB reference, 12 Nov 2026): £3,343.80.");
    expect(p.warnings).toEqual([]);
  });

  it("warns on an old exchange rate, and has no price without one", () => {
    const old = priceFor(fit({ cost: { amount: 4000, currency: "EUR" } }), { ...OPTS, now: new Date("2026-12-20T12:00:00Z") });
    expect(old.warnings).toEqual(["The exchange rate is 38 days old (2026-11-12)."]);
    const usd = priceFor(fit({ cost: { amount: 4000, currency: "USD" } }), { ...OPTS, fx: { ...FX, gbpPerUsd: null } });
    expect(usd.value).toBeNull();
    expect(usd.working).toContain("No exchange rate for USD, so Relay can't put it in pounds.");
  });

  it("never prices below cost", () => {
    for (const amount of [1, 299, 2496, 2505, 9999.99, 12_345]) {
      const p = priceFor(fit({ cost: { amount, currency: "GBP" } }), OPTS);
      expect(p.value!).toBeGreaterThanOrEqual(amount + 300 - 5);
      expect(p.value! % 10).toBe(0);
    }
  });

  it("takes a marketplace listing's price as it is, rounded up to the pound", () => {
    const p = priceFor(fit({ kind: "marketplace", key: "market:abc", cost: null, listed: { amount: 3329.99, currency: "GBP" } }), OPTS);
    expect(p.value).toBe(3330);
    expect(p.working[0]).toBe("Listed on the marketplace at £3,329.99, which already includes our commission.");
    expect(p.working.some((w) => /margin/i.test(w))).toBe(false);
    const eur = priceFor(fit({ kind: "marketplace", key: "market:abc", cost: null, listed: { amount: 3400, currency: "EUR" } }), OPTS);
    expect(eur.value).toBe(2843);
  });

  it("leaves the value empty with nothing to work from", () => {
    expect(priceFor(fit({ cost: null }), OPTS)).toMatchObject({ value: null, floor: null, working: ["The supplier hasn't given a price, so Relay has nothing to work from.", "No Penny price yet."] });
    expect(priceFor(fit({ kind: "marketplace", cost: null, listed: null }), OPTS).value).toBeNull();
  });

  it("is always collected, and says a delivered price needs a transport quote", () => {
    const p = priceFor(fit(), { ...OPTS, askedDelivered: true });
    expect(p).toMatchObject({ basis: "collected", needsDeliveryQuote: true });
    expect(p.working).toContain("Delivery isn't included: it needs a quote from the transport partner.");
  });

  it("checks against Penny's quick to patient range", () => {
    const p = priceFor(fit(), { ...OPTS, penny: ID3_CARD });
    expect(p.pennyRange).toEqual({ low: 1530, high: 2000 });
    expect(p.working.at(-1)).toBe("Penny: £1,530 quick, £1,600 expected, £2,000 patient (VW ID.3 / Cupra Born / Skoda Enyaq 58 kWh MEB pack, low confidence, 25 Oct 2026).");
    expect(p.warnings).toEqual(["£5,040 is above Penny's patient price (£2,000)."]);
    const blank = priceFor(fit(), { ...OPTS, penny: { ...ID3_CARD, quick_gbp_kwh: null, patient_gbp_kwh: null } });
    expect(blank.working.at(-1)).toBe("Penny has a card for VW ID.3 / Cupra Born / Skoda Enyaq 58 kWh MEB pack but no price yet.");
  });
});

describe("Alex's fills", () => {
  const relay = priceFor(fit(), { ...OPTS, penny: ID3_CARD });

  it("marks his value and checks it again against cost and Penny", () => {
    const below = alexFill(relay, 4000);
    expect(below).toMatchObject({ value: 4000, by: "alex" });
    expect(below.warnings).toEqual(["£4,000 is below cost (£4,500).", "£4,000 is above Penny's patient price (£2,000)."]);
    expect(alexFill(relay, null)).toMatchObject({ value: null, warnings: [] });
  });

  it("keeps his fills through a re-price", () => {
    const mine = alexFill(relay, 4800);
    const fresh = [{ ...relay, value: 5100 }, missingFill("market:x", "Volkswagen ID.3 58 kWh", false)];
    expect(mergeFills([mine], fresh).map((f) => [f.key, f.value, f.by])).toEqual([["stock:sto_1", 4800, "alex"], ["market:x", null, "relay"]]);
    expect(mergeFills([alexFill(missingFill("stock:gone", "x", false), 900)], []).map((f) => f.key)).toEqual(["stock:gone"]);
  });

  it("reads stored fills and drops what is malformed", () => {
    expect(parseFills([relay, { key: "nope" }, { ...relay }, "x", { key: "market:a", value: 12.4, by: "alex" }])).toEqual([
      relay, { key: "market:a", label: "", value: 12, basis: "collected", working: [], warnings: [], needsDeliveryQuote: false, by: "alex", floor: null, pennyRange: null },
    ]);
    expect(parseFills(null)).toEqual([]);
  });

  it("takes whole pounds only", () => {
    expect(fillValue(4500)).toEqual({ value: 4500 });
    expect(fillValue("£4,500")).toEqual({ value: 4500 });
    expect(fillValue(null)).toEqual({ value: null });
    for (const bad of [0, -5, 12.5, "abc", 20_000_000, undefined]) expect(fillValue(bad)).toHaveProperty("error");
  });
});

describe("price gaps", () => {
  const marker = priceGapMarker({ key: "stock:sto_9b1f-4a", label: "Volkswagen ID.3 62 kWh, 2020" });
  const body = `Hi Ben,\n\nWe have an ID.3 pack at ${marker}, collected. A newer one is ${priceGapMarker({ key: "market:e3ff", label: "VW ID.3 (58 kWh)" })}.\nCan you do [BLANK: which day]?\n\nAlex`;
  const fill = (key: string, value: number | null): PriceFill => ({ ...missingFill(key, "", false), value });

  it("writes the marker the gap guard already reads, and gets its key back", () => {
    expect(marker).toBe("[BLANK: price for Volkswagen ID.3 62 kWh, 2020 (ref stock:sto_9b1f-4a)]");
    expect(priceGapRef(marker)).toBe("stock:sto_9b1f-4a");
    expect(priceGapRef("[BLANK: your price per kWh]")).toBeNull();
    expect(priceGaps(body)).toEqual([{ key: "stock:sto_9b1f-4a", label: "Volkswagen ID.3 62 kWh, 2020" }, { key: "market:e3ff", label: "VW ID.3 58 kWh" }]);
  });

  it("fills price gaps that have a value and leaves the rest", () => {
    const fills = [fill("stock:sto_9b1f-4a", 5040), fill("market:e3ff", null)];
    expect(applyFills(body, fills)).toBe(body.replace(marker, "£5,040"));
    expect(unfilledGaps(body, fills)).toEqual(["price for VW ID.3 58 kWh (ref market:e3ff)", "which day"]);
    expect(unfilledGaps(applyFills(body, [...fills, fill("market:e3ff", 3330)]), [])).toEqual(["which day"]);
  });

  it("knows when the page saw other prices", () => {
    const stored = [fill("stock:sto_9b1f-4a", 5040)];
    expect(sameFills(body, stored, [{ key: "stock:sto_9b1f-4a", value: 5040 }])).toBe(true);
    expect(sameFills(body, stored, [{ key: "stock:sto_9b1f-4a", value: 4900 }])).toBe(false);
    expect(sameFills(body, stored, [])).toBe(false);
  });
});

describe("reading the ask", () => {
  const VOCAB = new Set(["id.3", "id.4", "enyaq", "born", "volkswagen", "skoda", "model", "as", "is", "listed", "long", "zs", "leaf"]);

  it("reads every capacity named", () => {
    expect(askKwh("a reasonably new 55kWh or 62kWh battery")).toEqual({ options: [55, 62] });
    expect(askKwh("55/62kWh MEB")).toEqual({ options: [55, 62] });
    expect(askKwh("anything 60-80 kWh")).toEqual({ min: 60, max: 80 });
    expect(askKwh("a battery please")).toBeNull();
  });

  it("reads the sentences that ask, and lists", () => {
    const text = "Unfortunately I couldn't fit in all the modules from an 82kWh pack.\nWhat are the current prices of 55kWh MEB packs?\n----------\nCould you quote the following\n-20 mg zs 72 kWh packs\n* 10 leaf motors";
    expect(askSentences(text)).toBe("What are the current prices of 55kWh MEB packs? Could you quote the following 20 mg zs 72 kWh packs 10 leaf motors");
  });

  it("reads Ben's email the way Matcha reads a request", () => {
    const ask = readAsk(["Hi,\n\nWhat's the current price for a reasonably new 55kWh or 62kWh VW/Skoda MEB style battery? Delivery to BA2 0BS or BA12 6LA.\n\nRegards,\n\nBen"], VOCAB);
    expect(ask.requirement.products.map((p) => p.phrase)).toEqual(["MEB"]);
    expect(ask.requirement.makeWords).toEqual(expect.arrayContaining(["vw", "volkswagen", "skoda"]));
    expect(ask.requirement.kwh).toEqual({ options: [55, 62] });
    expect(ask.requirement.pinned).toEqual(["MEB", "55 / 62 kWh"]);
    expect(ask.lines).toHaveLength(1);
    expect(ask.lines[0]).toMatchObject({ products: expect.arrayContaining(["meb", "vw", "skoda"]), kwh: [55, 62] });
    expect(ask).toMatchObject({ delivered: true, recent: true, listings: [] });
  });

  it("keeps English words out of the products, reads Model S, and finds linked listings", () => {
    const ask = readAsk(["Could you confirm your best price for these listings, as listed?\n  * 100 kWh Tesla Model S battery in Belgium: https://www.rebattery.io/marketplace/tesla-model-s-100kwh-nca-94cc"], VOCAB);
    expect(ask.requirement.products.map((p) => p.phrase)).toEqual(["model s"]);
    expect(ask.requirement.pinned[0]).toBe("Model S");
    expect(ask.listings).toEqual(["tesla-model-s-100kwh-nca-94cc"]);
    expect(ask.delivered).toBe(false);
  });

  it("does not take an enclosure for a battery", () => {
    expect(shellOnly("Tesla Model S 85 battery enclosure (no cells)", { text: "Model S 85 battery" })).toBe(true);
    expect(shellOnly("Tesla Model S 85 battery enclosure (no cells)", { text: "an empty Model S enclosure" })).toBe(false);
    expect(shellOnly("VW ID.3 62 kWh battery pack", { text: "ID.3" })).toBe(false);
  });
});

describe("ranking", () => {
  const lines = readAsk(["What's the price of a 55kWh or 62kWh VW MEB battery?"], new Set(["id.3"])).lines;

  it("counts an ID.3 sold as 58 kWh as the 62 kWh pack", () => {
    expect(lineTier(lines, { make: "Volkswagen", model: "ID.3", title: "Volkswagen ID.3 58kWh", kwh: 58 })).toBe(0);
    expect(lineTier(lines, { make: "Volkswagen", model: "ID.3", title: "VW ID.3", kwh: null })).toBe(1);
    expect(lineTier(lines, { make: "Kia", model: "EV6", title: "Kia EV6 58 kWh", kwh: 58 })).toBe(2);
  });

  const row = (key: string, supplier: string, o: Partial<RankedFit> & { year?: number | null; soh?: number | null } = {}): RankedFit => ({
    fit: fit({ key, supplier: { name: supplier, country: null, email: null }, year: o.year ?? 2020, soh: o.soh ?? null }),
    named: o.named ?? false, tier: o.tier ?? 0, exact: o.exact ?? true, roughGbp: o.roughGbp === undefined ? 4000 : o.roughGbp,
  });

  it("puts the best per supplier first, then fills up", () => {
    const rows = [row("stock:a1", "A", { roughGbp: 3000 }), row("stock:a2", "A", { roughGbp: 3100 }), row("stock:b", "B", { roughGbp: 5000 }), row("stock:c", "C", { tier: 2, roughGbp: 100 })];
    expect(rankFits(rows, false, 3).map((f) => f.key)).toEqual(["stock:a1", "stock:b", "stock:c"]);
    expect(rankFits(rows, false, 4).map((f) => f.key)).toEqual(["stock:a1", "stock:a2", "stock:b", "stock:c"]);
  });

  it("puts a linked listing first, priced before unpriced, worn packs after, newer first when asked", () => {
    const rows = [
      row("stock:old", "A", { year: 2019, roughGbp: 1000 }), row("stock:new", "B", { year: 2023, roughGbp: 5000 }), row("stock:none", "C", { roughGbp: null }),
      row("stock:worn", "D", { year: 2024, soh: 55, roughGbp: 900 }), row("market:linked", "E", { named: true, tier: 2, exact: false }),
    ];
    expect(rankFits(rows, true).map((f) => f.key)).toEqual(["market:linked", "stock:new", "stock:old", "stock:worn", "stock:none"]);
    expect(rankFits(rows, false).map((f) => f.key)).toEqual(["market:linked", "stock:old", "stock:new", "stock:worn", "stock:none"]);
  });
});

describe("labels and Penny cards", () => {
  it("reads a year from the title when none is stated", () => {
    expect(yearFrom(null, "VW ID.3 E11 Battery 0Z1915911M 2020 37805019")).toBe(2020);
    expect(yearFrom(null, "VOLKSWAGEN ID.3 MK1 (E1) 2017 On (2022)")).toBe(2022);
    expect(yearFrom(null, "HYUNDAI KONA EV/Hybrid High Voltage Battery 2017-2023 37501K4054")).toBeNull();
    expect(yearFrom(2021, "2020")).toBe(2021);
  });

  it("names the stock the way a buyer reads it", () => {
    expect(tidyModel("ID.3 E11")).toBe("ID.3");
    expect(tidyModel("BORN K11")).toBe("Born");
    expect(tidyModel("ENYAQ iV SUV 5AC, 5AZ")).toBe("Enyaq iV SUV");
    expect(tidyModel("Model S 85")).toBe("Model S 85");
    expect(fitLabel("Volkswagen", "ID.3 E11", 62, 2020, "")).toBe("Volkswagen ID.3 62 kWh, 2020");
    expect(fitLabel(null, null, null, null, "Battery [lot] 7")).toBe("Battery lot 7");
  });

  it("finds Penny's card for the pack, through its family", () => {
    const ioniq: PennyCard = { ...ID3_CARD, battery_key: "hyundai-ioniq5-77kwh-pack", battery: "Hyundai Ioniq 5 / Genesis GV60 77.4 kWh pack", kwh_usable: 77.4 };
    const tesla: PennyCard = { ...ID3_CARD, battery_key: "tesla-model-s-85kwh-pack", battery: "Tesla Model S 85 kWh pack", kwh_usable: 85 };
    const cards = [ioniq, ID3_CARD, tesla];
    expect(pennyCardFor({ label: "Volkswagen ID.3 62 kWh, 2020", kwh: 62 }, cards)?.battery_key).toBe("vw-id3-58kwh-pack");
    expect(pennyCardFor({ label: "Volkswagen ID.3 77 kWh, 2023", kwh: 77 }, cards)).toBeNull();
    expect(pennyCardFor({ label: "Volkswagen ID.4 62 kWh, 2023", kwh: 62 }, cards)).toBeNull();
    expect(pennyCardFor({ label: "Tesla Model S 85 kWh, 2014", kwh: 85 }, cards)?.battery_key).toBe("tesla-model-s-85kwh-pack");
    expect(pennyCardFor({ label: "Tesla Model 3 85 kWh", kwh: 85 }, cards)).toBeNull();
    expect(pennyCardFor({ label: "Volkswagen ID.3, 2020", kwh: null }, cards)).toBeNull();
  });
});
