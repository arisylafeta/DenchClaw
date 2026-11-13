import { describe, expect, it } from "vitest";
import type { DemandLine } from "../demand-lines";
import type { MatchGroupView, MatchRow } from "../matches-types";
import { supplierView, type RowCandidates } from "./supplier-groups";

const LINES: DemandLine[] = [
  { id: "meb", label: "VW MEB 82 kWh", products: ["meb"], kwh: [82], qty_min: 10, qty_max: 20 },
  { id: "hyb", label: "Stellantis hybrid", products: ["stellantis"], kwh: [13.2], qty_min: 48, qty_max: null },
  { id: "zoe", label: "Renault Zoe 41 kWh", products: ["zoe"], kwh: [41], qty_min: 4, qty_max: null },
];

const row = (key: string, name: string, companyId: string | null, over: Partial<MatchRow> = {}): MatchRow => ({
  key, rank: 1, name, detail: null, tags: ["unlisted stock"], reason: "", checks: [], price: null, offer: null, companyId, personId: null, contact: null,
  stockId: key.replace("stock:", ""), holds: `${name} pack`, country: "Sweden", ...over,
});
const group = (pack: string, keys: string[], over: Partial<MatchGroupView> = {}): MatchGroupView => ({
  pack, count: keys.length, countWord: null, unsure: false, sameLabel: null, vehicles: [], meta: "EUR 4,000–4,400 per pack · Mönsterås · stock list, 30 Oct",
  why: null, priceVaries: false, lots: false, units: keys.map((key) => ({ key, stockId: key.replace("stock:", ""), vehicle: "", year: null, ref: null, soh: { state: "unstated", label: "?", source: null }, location: null, price: null, seen: null, link: null })),
  stockIds: keys.map((key) => key.replace("stock:", "")), ...over,
});

const candidates: RowCandidates = new Map([
  ...Array.from({ length: 12 }, (_, i) => [`stock:m${i}`, { make: "Volkswagen", model: "ID.4", title: "ID.4 pack", kwh: 82, units: 1 }] as const),
  ["stock:h1", { make: "Opel", model: "Grandland", title: "Grandland PHEV pack", kwh: 13.2, units: 3 }],
  ["stock:b1", { make: "Cupra", model: "Born", title: "Born pack", kwh: 62, units: 2 }],
  ["stock:e1", { make: "Skoda", model: "Enyaq", title: "Enyaq pack", kwh: null, units: 2 }],
  ["stock:x1", { make: "Nissan", model: "Leaf", title: "Leaf pack", kwh: 40, units: null }],
]);

const rows: MatchRow[] = [
  row("group:stock:m0", "North Parts (North AB)", "c1", { group: group("VW MEB 82 kWh pack", Array.from({ length: 12 }, (_, i) => `stock:m${i}`), { priceVaries: true }) }),
  row("stock:h1", "North Parts (North AB)", "c1", { price: "EUR 7,319" }),
  row("stock:b1", "North Parts (North AB)", "c1"),
  row("stock:e1", "South Salvage", "c2", { country: "Lithuania", offer: { id: "o1", stage: "offered", date: "2026-11-09" } }),
  row("stock:x1", "West Spares", null, { country: "Germany" }),
];

describe("supplierView", () => {
  const { lines, suppliers } = supplierView(rows, candidates, LINES);

  it("makes one row per supplier with every pack type they hold, on the buyer's types first", () => {
    expect(suppliers.map((s) => s.name)).toEqual(["North Parts (North AB)", "South Salvage", "West Spares"]);
    const north = suppliers[0];
    expect(north.stock.map((s) => [s.pack, s.count, s.line?.id ?? null, s.lineState])).toEqual([
      ["VW MEB 82 kWh pack", 12, "meb", "fits"],
      ["North Parts (North AB) pack", 3, "hyb", "fits"],
      ["North Parts (North AB) pack", 2, null, null],
    ]);
    expect(north.stock[0]).toMatchObject({ price: "EUR 4,000–4,400 per pack", priceVaries: true, units: 12 });
    expect(north.stock[1].price).toBe("EUR 7,319");
    expect(north).toMatchObject({ onLines: 15, other: 2, linesCovered: 2, needCovered: 15, otherOnly: false, rowKeys: ["group:stock:m0", "stock:h1", "stock:b1"] });
    expect(north.cover).toEqual([
      { id: "meb", label: "VW MEB 82 kWh", count: 12, state: "fits" },
      { id: "hyb", label: "Stellantis hybrid", count: 3, state: "fits" },
      { id: "zoe", label: "Renault Zoe 41 kWh", count: 0, state: "none" },
    ]);
  });

  it("marks a pack whose capacity is not stated as close, and keeps the offer", () => {
    expect(suppliers[1].stock[0]).toMatchObject({ line: { id: "meb" }, lineState: "close", why: "kWh not stated" });
    expect(suppliers[1].offer?.id).toBe("o1");
  });

  it("reads a capacity from the pack name when the units state none, and does not rank on maybes", () => {
    const named = supplierView([row("group:stock:n1", "Named Ltd", "n", { group: group("Cupra Born 63 kWh pack", ["stock:n1", "stock:n2"]) })],
      new Map([["stock:n1", { make: "Cupra", model: "Born", title: "Born", kwh: null, units: 1 }], ["stock:n2", { make: "Cupra", model: "Born", title: "Born", kwh: null, units: 1 }]]), LINES);
    // 63 kWh is not the 82 kWh MEB type: other stock, not a maybe.
    expect(named.suppliers[0].stock[0]).toMatchObject({ line: null, count: 2 });
    expect(suppliers[1]).toMatchObject({ name: "South Salvage", onLines: 2, needCovered: 0 });
  });

  it("puts a supplier with only other stock last, and counts no unstated quantity", () => {
    expect(suppliers[2]).toMatchObject({ otherOnly: true, onLines: 0, needCovered: 0, key: expect.stringMatching(/^name:/) });
    expect(suppliers[2].stock[0]).toMatchObject({ count: 0, stated: false, line: null });
  });

  it("counts each type up to its most when ranking", () => {
    const big = supplierView([row("stock:a", "A", "a"), row("stock:b", "B", "b")],
      new Map([["stock:a", { make: "VW", model: "ID.4", title: "", kwh: 82, units: 40 }], ["stock:b", { make: "Opel", model: "Grandland", title: "", kwh: 13.2, units: 30 }]]), LINES);
    // A's 40 MEB count as 20 (the most needed); B's 30 hybrids all count.
    expect(big.suppliers.map((s) => [s.name, s.needCovered])).toEqual([["B", 30], ["A", 20]]);
  });

  it("sums each pack type across suppliers against the need", () => {
    expect(lines).toEqual([
      { id: "meb", label: "VW MEB 82 kWh", need: "10–20", qtyMin: 10, qtyMax: 20, found: 14, close: 2, suppliers: 2, state: "fits" },
      { id: "hyb", label: "Stellantis hybrid", need: "48", qtyMin: 48, qtyMax: null, found: 3, close: 0, suppliers: 1, state: "close" },
      { id: "zoe", label: "Renault Zoe 41 kWh", need: "4", qtyMin: 4, qtyMax: null, found: 0, close: 0, suppliers: 0, state: "misses" },
    ]);
  });

  it("still groups by supplier when the request has no pack types", () => {
    const plain = supplierView(rows, candidates, []);
    expect(plain.lines).toBeNull();
    expect(plain.suppliers[0].name).toBe("North Parts (North AB)");
    expect(plain.suppliers[0].cover).toEqual([]);
  });
});
