import { describe, expect, it } from "vitest";
import { aggregateStock, groupKeyFor, matchesFilters, normalModel, supplierToken, type StockRow } from "./commercial-stock";

const row = (over: Partial<StockRow>): StockRow => ({
  id: "sto_1", company_id: "co_a", person_id: "p_a", supplier: "Secret Breaker AB", status: "opportunity",
  make: "Peugeot", model: "208/E 208", format: "pack", capacity_kwh: 50, chemistry: "NMC622", powertrain: "BEV",
  year: 2022, country: "Sweden", quantity: 1, price_eur_ex_vat: 4000, price_eur: 5000, seen_on: "2026-10-27",
  sync_class: "synced", ...over,
});

const stock = [
  row({ id: "sto_1" }),
  row({ id: "sto_2", company_id: "co_b", person_id: "p_b", supplier: "Other Dismantler UAB", country: "Lithuania", price_eur_ex_vat: 3500, sync_class: "syncable", year: 2021 }),
  row({ id: "sto_3", make: "VW", model: "ID.3", capacity_kwh: 58, chemistry: "NMC", price_eur_ex_vat: null, price_eur: 6000 }),
  row({ id: "sto_4", make: "Volkswagen", model: "ID.3", capacity_kwh: 58.0, chemistry: "nmc", quantity: 3, price_eur_ex_vat: 5000, company_id: "co_b", person_id: "p_b" }),
];

describe("aggregateStock", () => {
  it("groups by spec and never exposes supplier identity", () => {
    const groups = aggregateStock(stock);
    expect(groups).toHaveLength(2);
    const id3 = groups.find((group) => group.make === "Volkswagen")!;
    expect(id3).toMatchObject({ units: 4, priceEurIncVatOnly: 1 });
    const peugeot = groups.find((group) => group.make === "Peugeot")!;
    expect(peugeot).toMatchObject({ units: 2, years: { min: 2021, max: 2022 } });
    const text = JSON.stringify(groups);
    for (const secret of ["Secret Breaker", "Other Dismantler", "co_a", "co_b", "p_a", "sto_1", "sto_4"]) expect(text).not.toContain(secret);
  });

  it("bands prices below three suppliers but always shows supplier count and countries", () => {
    const [few] = aggregateStock([row({ id: "a", price_eur_ex_vat: 4180 }), row({ id: "b", company_id: "co_b", price_eur_ex_vat: 4777 })]);
    expect(few).toMatchObject({ sources: 2, countries: ["Sweden"], synced: null, priceEurExVat: { min: 4000, median: null, max: 5000, priced: 2 } });
    const [crowd] = aggregateStock([row({ id: "a" }), row({ id: "b", company_id: "co_b", country: "Lithuania", price_eur_ex_vat: 3500 }),
      row({ id: "c", company_id: "co_c", country: "Norway", price_eur_ex_vat: 4500, sync_class: "static" })]);
    expect(crowd).toMatchObject({ sources: 3, countries: ["Lithuania", "Norway", "Sweden"], synced: 2, priceEurExVat: { min: 3500, median: 4000, max: 4500, priced: 3 } });
  });

  it("uses an opaque key that depends only on the spec", () => {
    expect(groupKeyFor(stock[0])).toBe(groupKeyFor(stock[1]));
    expect(groupKeyFor(stock[2])).toBe(groupKeyFor(stock[3]));
    expect(groupKeyFor(stock[0])).toMatch(/^grp_[0-9a-f]{16}$/);
  });
});

describe("matchesFilters", () => {
  const today = new Date("2026-10-27T12:00:00Z");
  it("filters by make alias, kWh, price ex VAT and freshness", () => {
    expect(stock.filter((r) => matchesFilters(r, { make: "vw" }, today)).map((r) => r.id)).toEqual(["sto_3", "sto_4"]);
    expect(stock.filter((r) => matchesFilters(r, { kwhMin: 55 }, today)).map((r) => r.id)).toEqual(["sto_3", "sto_4"]);
    expect(stock.filter((r) => matchesFilters(r, { maxPriceEurExVat: 3800 }, today)).map((r) => r.id)).toEqual(["sto_2"]);
    expect(matchesFilters(row({ powertrain: "PHEV" }), { powertrain: "HEV" }, today)).toBe(false);
    expect(matchesFilters(row({ powertrain: "HEV" }), { powertrain: "hev" }, today)).toBe(true);
    expect(matchesFilters(row({ seen_on: "2026-08-01" }), { seenWithinDays: 30 }, today)).toBe(false);
    expect(matchesFilters(row({ make: null }), {}, today)).toBe(false);
  });

  it("strips a repeated make from the model so both spellings group together", () => {
    expect(normalModel("Hyundai", "Hyundai Ioniq 5")).toBe("Ioniq 5");
    expect(normalModel("VW", "Volkswagen ID.4")).toBe("ID.4");
    expect(normalModel("Kia", "Kiaxx")).toBe("Kiaxx");
    expect(groupKeyFor(row({ make: "Hyundai", model: "Hyundai Ioniq 5" }))).toBe(groupKeyFor(row({ make: "Hyundai", model: "Ioniq 5" })));
    expect(aggregateStock([row({ make: "Hyundai", model: "Hyundai Ioniq 5" })])[0].label).toBe("Hyundai Ioniq 5 50 kWh NMC622 pack");
  });

  it("gives per-supplier units under scoped opaque tokens", () => {
    const rows = [row({ id: "a", company_id: "c1", quantity: 2 }), row({ id: "b", company_id: "c1", quantity: 1 }), row({ id: "c", company_id: "c2", person_id: "p_c", quantity: 1 })];
    const [group] = aggregateStock(rows, (id) => supplierToken(id, "conv-1234", "k".repeat(32)));
    expect(group.sources).toBe(2);
    expect(group.suppliers.map((entry) => entry.units)).toEqual([3, 1]);
    expect(group.suppliers[0].supplier).toMatch(/^S[0-9a-f]{6}$/);
    expect(JSON.stringify(group)).not.toMatch(/"c1"|"c2"|Secret Breaker/);
    expect(supplierToken("c1", "conv-1234", "k".repeat(32))).toBe(group.suppliers[0].supplier);
    expect(supplierToken("c1", "conv-9999", "k".repeat(32))).not.toBe(group.suppliers[0].supplier);
  });
});
