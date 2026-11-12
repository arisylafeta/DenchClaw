import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  autoDealUpdateOn, BULK_MIN_KWH, BULK_OVER_USD, CHECK_FIELD, chooseRoute, docTooOld, opensDeal, parsePrice, POINTERS, QUALIFY_KEYS, qualifyView,
  routeLead, sizeLead, toUsd, totalKwh, unitCount, USD_PER, type CheckState,
} from "./relay-front-door";

const facts = (f: Record<string, string>) => Object.entries(f).map(([key, value]) => ({ key, value }));

describe("bulk line", () => {
  it("is bulk at 300 kWh or more, from the total or from count x size", () => {
    expect(sizeLead(facts({ how_many: "300 kWh" })).size).toBe("bulk");
    expect(sizeLead(facts({ how_many: "2 MWh" })).kwh).toEqual({ min: 2000, max: 2000 });
    expect(sizeLead(facts({ how_many: "8 packs", what: "Nissan Leaf 40kWh" })).size).toBe("bulk");
    expect(sizeLead(facts({ how_many: "8 packs", what: "Nissan Leaf 40kWh" })).why).toMatch(/320 kWh/);
  });

  it("is bulk over USD 20,000 even when the kWh is unknown", () => {
    expect(sizeLead(facts({ how_many: "20 packs", price: "$1,200 per pack" })).size).toBe("bulk");
    expect(sizeLead(facts({ how_many: "1 lot", price: "€25,000 for the lot" })).size).toBe("bulk");
  });

  it("exactly USD 20,000 is not over the line", () => {
    const at = sizeLead(facts({ how_many: "2 packs", what: "Leaf 40kWh", price: "$10,000 per pack" }));
    expect(at.usd).toEqual({ min: BULK_OVER_USD, max: BULK_OVER_USD });
    expect(at.size).toBe("medium");
  });

  it("is under the line only when both kWh and value are known and under", () => {
    expect(sizeLead(facts({ how_many: "1 pack", what: "Leaf 40kWh", price: "£3,000 per pack" })).size).toBe("small");
    expect(sizeLead(facts({ how_many: "4 packs", what: "Leaf 40kWh", price: "£3,000 per pack" })).size).toBe("medium");
  });

  it("says unknown: ask when the facts do not settle it, never a guess", () => {
    const noPrice = sizeLead(facts({ how_many: "2 packs", what: "Leaf 40kWh" }));
    expect(noPrice.size).toBe("unknown");
    expect(noPrice.why).toMatch(/^Size unknown: ask for a price with its unit/);
    expect(sizeLead(facts({ how_many: "50 packs", what: "Nissan Leaf" })).size).toBe("unknown");
    expect(sizeLead(facts({ what: "LFP cells" })).size).toBe("unknown");
    expect(sizeLead(facts({ how_many: "20 packs", price: "make us an offer" })).size).toBe("unknown");
    // a price with no unit is no price
    expect(sizeLead(facts({ how_many: "20 packs", what: "Leaf 40kWh", price: "€5,000" })).size).toBe("bulk");
    expect(sizeLead(facts({ how_many: "2 packs", what: "Leaf 40kWh", price: "€5,000" })).size).toBe("unknown");
  });

  it("reads ranges and floors from the lowest reading for bulk and the highest for under", () => {
    expect(sizeLead(facts({ how_many: "200-400 kWh" })).size).toBe("unknown");
    expect(sizeLead(facts({ how_many: "300-400 kWh" })).size).toBe("bulk");
    expect(unitCount("10+ packs")).toEqual({ min: 10, max: Infinity });
    expect(unitCount("over 10 packs")).toEqual({ min: 10, max: Infinity });
    expect(unitCount("1,000 modules")).toEqual({ min: 1000, max: 1000 });
    expect(unitCount("1.000 modules")).toEqual({ min: 1000, max: 1000 });
    expect(unitCount("one pack")).toEqual({ min: 1, max: 1 });
    expect(unitCount("20 tonnes")).toBeNull();
    expect(totalKwh("1.5 MWh")).toEqual({ min: 1500, max: 1500 });
    expect(BULK_MIN_KWH).toBe(300);
  });
});

describe("currency", () => {
  it("converts EUR and GBP to USD at the fixed rates", () => {
    expect(USD_PER).toEqual({ USD: 1, EUR: 1.16, GBP: 1.34 });
    expect(toUsd(100, "EUR")).toBe(116);
    expect(toUsd(100, "GBP")).toBe(134);
    expect(toUsd(100, "USD")).toBe(100);
  });

  it("reads the price, its currency and what it is per", () => {
    expect(parsePrice("€35/kWh")).toEqual({ amount: { min: 35, max: 35 }, currency: "EUR", per: "kwh" });
    expect(parsePrice("EUR 40 per usable kWh")).toMatchObject({ currency: "EUR", per: "kwh" });
    expect(parsePrice("£1,200 per pack")).toEqual({ amount: { min: 1200, max: 1200 }, currency: "GBP", per: "unit" });
    expect(parsePrice("$1.2k each")).toEqual({ amount: { min: 1200, max: 1200 }, currency: "USD", per: "unit" });
    expect(parsePrice("€30-35/kWh")?.amount).toEqual({ min: 30, max: 35 });
    expect(parsePrice("€40,000 per MWh")).toMatchObject({ amount: { min: 40, max: 40 }, per: "kwh" });
    expect(parsePrice("make us an offer")).toBeNull();
    expect(parsePrice("1,200 per pack")).toBeNull();
  });

  it("puts a euro value over the line by its dollar worth", () => {
    // €18,000 is USD 20,880: over the line although under 20,000 in euros
    expect(sizeLead(facts({ how_many: "1 lot", price: "€18,000 for the lot" })).size).toBe("bulk");
    expect(sizeLead(facts({ how_many: "1 pack", what: "40kWh", price: "€17,000 for the lot" })).size).toBe("small");
  });
});

describe("routes", () => {
  it("gives every lead exactly one route", () => {
    expect(routeLead({ facts: facts({ how_many: "500 kWh" }), recycling: null })).toMatchObject({ route: "bulk", size: "bulk" });
    expect(routeLead({ facts: facts({ how_many: "2 packs" }), recycling: null })).toMatchObject({ route: "bulk", size: "unknown" });
    expect(routeLead({ facts: facts({ how_many: "1 pack", what: "Leaf 40kWh", price: "£3,000 per pack" }), recycling: null })).toMatchObject({ route: "marketplace", size: "small" });
    expect(routeLead({ facts: facts({ how_many: "3 packs", what: "Leaf 40kWh", price: "£3,000 per pack" }), recycling: null })).toMatchObject({ route: "jules", size: "medium" });
    const recycling = routeLead({ facts: facts({ how_many: "3 packs" }), recycling: "damaged packs for recycling" });
    expect(recycling.route).toBe("recycling");
    expect(recycling.reason).toMatch(/^Recycling: "damaged packs for recycling"/);
  });

  it("lets Alex pick another route on the card, saying what Relay suggested", () => {
    const suggested = routeLead({ facts: facts({ how_many: "3 packs", what: "Leaf 40kWh", price: "£3,000 per pack" }), recycling: null });
    expect(chooseRoute(suggested, "jules")).toBe(suggested);
    expect(chooseRoute(suggested, "nonsense")).toBe(suggested);
    const picked = chooseRoute(suggested, "bulk");
    expect(picked).toMatchObject({ route: "bulk", chosen: true });
    expect(picked.reason).toMatch(/^Bulk deal, chosen on the card \(Relay suggested Jules/);
  });

  it("opens a deal on send only for a bulk or recycling lead with what and how many", () => {
    const have = { what: true, how_many: true };
    expect(opensDeal({ route: "bulk", size: "bulk", reason: "" }, have)).toBe(true);
    expect(opensDeal({ route: "bulk", size: "unknown", reason: "" }, have)).toBe(true);
    expect(opensDeal({ route: "bulk", size: "bulk", reason: "" }, { what: true, how_many: false })).toBe(false);
    expect(opensDeal({ route: "marketplace", size: "small", reason: "" }, have)).toBe(false);
    expect(opensDeal({ route: "jules", size: "medium", reason: "" }, have)).toBe(false);
    expect(opensDeal({ route: "recycling", size: "medium", reason: "" }, have)).toBe(false);
    expect(opensDeal({ route: "recycling", size: "medium", reason: "", chosen: true }, have)).toBe(true);
    expect(opensDeal({ route: "bulk", size: "medium", reason: "", chosen: true }, have)).toBe(true);
  });

  it("keeps the pointer wording free of figures, prices and made-up links", () => {
    for (const side of Object.values(POINTERS)) for (const line of Object.values(side)) {
      expect(line).not.toMatch(/[\d€£$]/);
      expect(line.match(/\b[\w-]+\.(?:io|com|co\.uk)\b/g) ?? []).toEqual(["rebattery.io"]);
      expect(line).not.toMatch(/—/);
    }
  });
});

describe("qualified", () => {
  const done: CheckState = { answered: true, cannot: false, checked: true, asked: 1 };
  const all = (over: Record<string, CheckState | undefined> = {}) => ({ what: done, how_many: done, where: done, health: done, price: done, when: done, ...over });

  it("needs every item answered or cannot-provide, checked, and the person's tick", () => {
    expect(qualifyView("supply", "resale", all(), true)).toMatchObject({ qualified: true, ready: true, missing: [] });
    expect(qualifyView("supply", "resale", all(), false)).toMatchObject({ qualified: false, ready: true });
    expect(qualifyView("supply", "resale", all({ health: { ...done, checked: false } }), true).missing).toEqual(["health (not checked)"]);
    expect(qualifyView("supply", "resale", all({ health: { answered: false, cannot: true, checked: true, asked: 2 } }), true).qualified).toBe(true);
    expect(qualifyView("supply", "resale", all({ where: undefined }), true).missing).toEqual(["where (not answered)"]);
  });

  it("is Qualified with no price and no date, and says so", () => {
    const view = qualifyView("supply", "resale", all({ price: undefined, when: { answered: false, cannot: false, checked: false, asked: 1 } }), true);
    expect(view).toMatchObject({ qualified: true, noPrice: true, noDate: true });
  });

  it("uses the recycling checklist on a recycling deal", () => {
    expect(qualifyView("supply", "recycling", all(), true).missing).toEqual(["condition (not answered)"]);
    expect(qualifyView("supply", "recycling", all({ condition: done, health: undefined }), true).qualified).toBe(true);
  });

  it("proposes parking after two asks with a tier 1 gap", () => {
    expect(qualifyView("demand", "resale", all({ how_many: { answered: false, cannot: false, checked: false, asked: 2 } }), false).park).toMatch(/^Two asks and still no how many/);
    expect(qualifyView("demand", "resale", all({ how_many: { answered: false, cannot: false, checked: false, asked: 1 } }), false).park).toBeNull();
  });

  it("flags test documents more than 12 months old", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    expect(docTooOld("2025-11-01", now)).toBe(true);
    expect(docTooOld("2025-11-20", now)).toBe(false);
    expect(docTooOld(null, now)).toBe(false);
  });

  it("matches the SQL in migration 117", () => {
    const sql = readFileSync(join(__dirname, "crm-postgres/migrations/117_relay_front_door.sql"), "utf8");
    for (const route of ["resale", "recycling"] as const) for (const kind of ["supply", "demand"] as const) {
      expect(sql).toContain(`-- keys ${route} ${kind}: array[${QUALIFY_KEYS[route][kind].map((k) => `'${k}'`).join(", ")}]`);
    }
    for (const kind of ["supply", "demand"] as const) for (const [key, field] of Object.entries(CHECK_FIELD[kind])) {
      expect(sql).toContain(`when '${kind}:${key}' then '${field}'`);
    }
  });
});

describe("auto update setting", () => {
  it("is on unless set off", () => {
    expect(autoDealUpdateOn({})).toBe(true);
    expect(autoDealUpdateOn({ RELAY_AUTO_DEAL_UPDATE: "on" })).toBe(true);
    expect(autoDealUpdateOn({ RELAY_AUTO_DEAL_UPDATE: "off" })).toBe(false);
    expect(autoDealUpdateOn({ RELAY_AUTO_DEAL_UPDATE: "0" })).toBe(false);
  });
});
