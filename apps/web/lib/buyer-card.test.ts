import { describe, expect, it } from "vitest";
import type { BuyerProfile } from "./buyer-profile";
import { buyerCard, monthYear, pricesFor, productTokens } from "./buyer-card";

const dossier = {
  products: [
    { platform: "MEB", make: "VW Group", format: "packs", chemistry: "NMC", kwh: [82], status: "bought", seen: "2025-10-22" },
    { make: "Renault", model: "Zoe 41 kWh", format: "packs", kwh: [41], status: "asked", seen: "2026-09-30" },
    { platform: "STLA-M", make: "Stellantis", format: "packs", kwh: [81.6, 105], status: "asked", seen: "2026-07-01" },
    { format: "packs", status: "said_interested", seen: "2026-09-30" },
  ],
  price: [
    { basis: "stated_target", eur_per_kwh: 20, seen: "2026-08-21", currency_original: "EUR 20-25/kWh target, 10-20 MEB packs" },
    { basis: "stated_target", eur_per_kwh: 10, seen: "2026-07-14", currency_original: "EUR 10-12/kWh target, STLA-M" },
    { basis: "paid", eur_per_kwh: 34, seen: "2026-05-05", currency_original: "GBP 2,400 per 82 kWh pack" },
    { basis: "paid", eur_per_kwh: 26.5, seen: "2025-10-24", currency_original: "EUR 26.5/kWh per 82 kWh MEB pack" },
    { basis: "quoted_by_buyer", eur_per_kwh: 30.2, seen: "2026-01-26", currency_original: "GBP 2,132 per 82 kWh MEB pack" },
  ],
  quantity: { min_units: 3, typical_units: 20 },
  logistics: { collects: "own_haulier" },
  evidence_required: ["tested_soh", "label_photos", "pack_photos"],
  intent: ["reuse"],
  decision_speed: "fast",
  last_verified: "2026-11-05",
};
const profile = (box: Record<string, unknown>, extra: Partial<BuyerProfile> = {}) => ({ buyer_profile: box, past_issues: null, ...extra }) as unknown as BuyerProfile;
const market = [
  { eur_per_kwh: 30, seen: "2026-06-01", text: "EUR 30/kWh, MEB 82 kWh" },
  { eur_per_kwh: 33, seen: "2026-08-01", text: "GBP 2,300 per 82 kWh pack" },
  { eur_per_kwh: 12, seen: "2026-08-01", text: "EUR 12/kWh" },
];

describe("buyerCard", () => {
  it("scopes the price block to the request's product, from the dossier", () => {
    const card = buyerCard({ profile: profile({ dossier }), request: { product_family: "MEB 82 kWh packs", wants: null }, market });
    expect(card.basis).toBe("dossier");
    expect(card.priceTopic).toBe("MEB 82 kWh packs");
    expect(card.target).toEqual({ low: 20, high: 25, seen: "2026-08-21" });
    expect(card.paid).toMatchObject({ low: 26.5, high: 34, count: 2, last: "2026-05-05" });
    expect(card.others).toEqual({ low: 30, high: 33, count: 2 });
  });

  it("falls back to all products without comparing other buyers when no price names the request", () => {
    const card = buyerCard({ profile: profile({ dossier }), request: { product_family: "Nissan Leaf 40 kWh", wants: null }, market });
    expect(card.priceTopic).toBe("All products");
    expect(card.paid?.count).toBe(2);
    expect(card.target?.seen).toBe("2026-08-21");
    expect(card.others).toBeNull();
  });

  it("puts bought products first, then newest, and skips a product that names nothing", () => {
    const card = buyerCard({ profile: profile({ dossier }), request: { product_family: null, wants: null } });
    expect(card.chips.map((c) => [c.label, c.bought])).toEqual([["MEB 82 kWh", true], ["Renault Zoe 41 kWh", false], ["STLA-M 81.6–105 kWh", false]]);
  });

  it("states only the facts on record", () => {
    const card = buyerCard({ profile: profile({ dossier }, { past_issues: "2025-11-11: customs dispute" }), request: { product_family: null, wants: null } });
    expect(card.facts).toEqual([
      { label: "Format", value: "Packs" }, { label: "Chemistry", value: "NMC" }, { label: "Typical order", value: "20 packs" },
      { label: "Minimum", value: "3 packs" }, { label: "Collects", value: "Own haulier" }, { label: "Needs", value: "SoH, Photos" },
      { label: "Uses", value: "Reuse" }, { label: "Deals with us", value: "2" },
    ]);
    expect(card.pastIssue).toBe("2025-11-11: customs dispute");
    expect(card.decides).toBe("Decides fast");
    expect(card.verified).toBe("2026-11-05");
  });

  it("reads a stated buy box without a dossier and shows no invented price", () => {
    const card = buyerCard({ profile: profile({ formats: ["Packs"], chemistries: ["LFP"], kwh_min: 50, kwh_max: 80, wants: "Tesla LFP packs (asked 2026-10-02)\nBYD Blade packs (asked 2026-10-02)" }, { buyer_profile_basis: "stated" }), request: { product_family: "LFP packs", wants: null }, market });
    expect(card.basis).toBe("stated");
    expect(card.target).toBeNull();
    expect(card.paid).toBeNull();
    expect(card.others).toBeNull();
    expect(card.chips.map((c) => c.label)).toEqual(["Tesla LFP", "BYD Blade"]);
    expect(card.facts).toEqual([{ label: "Format", value: "Packs" }, { label: "Chemistry", value: "LFP" }, { label: "Size", value: "50–80 kWh" }]);
  });

  it("marks a researched buy box as likely, with no price", () => {
    const card = buyerCard({ profile: profile({ chemistries: ["NMC"], formats: ["Modules"] }, { buyer_profile_basis: "researched" }), request: { product_family: null, wants: null } });
    expect(card.basis).toBe("researched");
    expect(card.chips.map((c) => c.label)).toEqual(["NMC", "Modules"]);
  });

  it("copes with no profile at all", () => {
    expect(buyerCard({ profile: undefined, request: { product_family: null, wants: null } })).toMatchObject({ basis: "none", chips: [], facts: [], target: null });
  });
});

describe("helpers", () => {
  it("tokenises a product and matches price notes on model words or kWh", () => {
    expect(productTokens("MEB 82 kWh packs")).toEqual(["82 kwh", "meb"]);
    expect(pricesFor(market, ["82 kwh"]).length).toBe(2);
    expect(pricesFor(market, [])).toEqual([]);
  });
  it("writes months unambiguously", () => {
    expect(monthYear("2026-05-05")).toBe("May 2026");
    expect(monthYear(null)).toBeNull();
  });
});
