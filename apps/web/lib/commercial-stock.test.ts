import { describe, expect, it } from "vitest";
import { aggregateStock, allocate, bySupplier, groupKeyFor, matchesFilters, type StockRow } from "./commercial-stock";

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
    expect(id3).toMatchObject({ units: 4, sources: 2, priceEurExVat: { min: 5000, median: 5000, max: 5000, priced: 1 }, priceEurIncVatOnly: 1 });
    const peugeot = groups.find((group) => group.make === "Peugeot")!;
    expect(peugeot).toMatchObject({ units: 2, countries: ["Lithuania", "Sweden"], years: { min: 2021, max: 2022 }, synced: 1 });
    const text = JSON.stringify(groups);
    for (const secret of ["Secret Breaker", "Other Dismantler", "co_a", "co_b", "p_a", "sto_1", "sto_4"]) expect(text).not.toContain(secret);
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
    expect(matchesFilters(row({ seen_on: "2026-08-01" }), { seenWithinDays: 30 }, today)).toBe(false);
    expect(matchesFilters(row({ make: null }), {}, today)).toBe(false);
  });
});

describe("allocate", () => {
  it("takes synced stock first, then cheaper, and records a shortfall", () => {
    const key = groupKeyFor(stock[0]);
    const [line] = allocate([{ groupKey: key, quantity: 3, targetPriceEur: 3800 }], stock);
    expect(line.rows.map((r) => r.row.id)).toEqual(["sto_1", "sto_2"]);
    expect(line).toMatchObject({ wanted: 3, allocated: 2, targetPriceEur: 3800 });
    expect(line.label).toContain("Peugeot");
  });

  it("splits a quantity across rows and suppliers and groups offers per supplier", () => {
    const key = groupKeyFor(stock[3]);
    const allocations = allocate([{ groupKey: key, quantity: 2 }], stock);
    expect(allocations[0].rows.map((r) => [r.row.id, r.units])).toEqual([["sto_4", 2]]);
    const both = allocate([{ groupKey: groupKeyFor(stock[0]), quantity: 2 }, { groupKey: key, quantity: 4 }], stock);
    const suppliers = bySupplier(both);
    expect(suppliers.map((s) => [s.company_id, s.lines.length])).toEqual([["co_a", 2], ["co_b", 2]]);
  });

  it("keeps an unknown group as an empty line with the buyer-side label", () => {
    const [line] = allocate([{ groupKey: "grp_0000000000000000", quantity: 5, label: "Tesla Model 3" }], stock);
    expect(line).toMatchObject({ allocated: 0, rows: [], label: "Tesla Model 3" });
  });
});
