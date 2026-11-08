import { describe, expect, it } from "vitest";
import { requirementFor, scoreCandidate, type Requirement } from "../demand-match";
import { fitMarks } from "./fit-marks";
import { groupMarks, groupStock, groupSummary, packIdentities, sohMark, splitByKwh, vehicleName, type GraphMatch, type GroupInput, type IdentityInput } from "./stock-groups";
import { identityInput, stockCandidate, stockExtra, type StockRow } from "../crm-postgres/demand-matches-v2";
import type { Demand } from "../bulk-demand";
import type { MatchRow } from "../matches-types";

const NOW = new Date("2026-11-08T12:00:00Z");

const demand = (o: Partial<Demand>): Demand => ({
  id: "btd_t", kind: "request", basis: null, buyer: "Stanton", company_id: null, person_id: null, contact: null, email: null,
  wants: "", quantity: null, location: null, note: null, needed_by: null, volume: null, volume_unit: null, max_price: null,
  price_currency: null, price_unit: null, spec: {}, source_kind: null, source_label: null, source_url: null, source_quote: null,
  observed_on: null, status: "open", product_family: null, fee_eur: null, price_basis: null, reputation: null, qualify_question: null,
  qualify_asked_on: null, qualify_entered_on: null, activity_count: 0, last_activity_at: null, moved_to: null, asked_on: null,
  score: null, expected_fee: null, has_stock: false, closed_reason: null, confirmed_on: null, updated_at: "", fits: [], trades: [],
  tier: null, waiting: null, priority: false, missing: [], context_notes: [], inventory_matches: [], context: {}, ...o,
});

const STELLANTIS: GraphMatch = {
  pack_key: "fam:stellantis-50-nmc", confidence: "high", pack: "Stellantis 50 kWh NMC pack (CATL), e-CMP / EMP2", usable_kwh: 46, gross_kwh: 50,
  chemistry: "NMC", voltage: "400", kind: "part number", input: "9832817280", looked_up_on: "2026-10-24",
};

let seq = 0;
/** A stock line as the request query returns it: a pack from a UK salvage seller unless told otherwise. */
const line = (o: Partial<StockRow> & { graph?: GraphMatch | null } = {}): StockRow => {
  const { graph, ...rest } = o;
  seq += 1;
  return {
    id: `sto_${seq}`, company_id: "comp_northway", person_id: "p_northway", supplier: "Northway Parts", make: "Vauxhall", model: "Vivaro-e",
    format: "pack", chemistry: null, capacity_kwh: 50, quantity: 1, price_eur: 2020, location: "Leeds", country: "GB", seen_on: "2026-11-07",
    title: "Vauxhall Vivaro-e 50 kWh battery", quantity_available: 1, quantity_stated: null, soh_percent: null, year: 2022, part_numbers: null,
    supplier_ref: `NW-${4400 + seq}`, description: null, source: "website", evidence_source: null, observed_on: "2026-11-07",
    source_url: `https://northway.example/stock/${seq}`,
    ...(graph ? {
      graph_pack_key: graph.pack_key, graph_confidence: graph.confidence, graph_pack: graph.pack, graph_usable_kwh: graph.usable_kwh,
      graph_gross_kwh: graph.gross_kwh, graph_chemistry: graph.chemistry, graph_voltage: graph.voltage, graph_kind: graph.kind,
      graph_looked_up_on: graph.looked_up_on, graph_input: graph.input,
    } : {}),
    ...rest,
  };
};

const ask = (o: Partial<Demand> = {}): Requirement => requirementFor(demand({
  wants: "2-13 Vauxhall Vivaro-e, Peugeot Rifter, Peugeot e-208 or Citroen e-Berlingo packs", quantity: "2-13 packs", volume: 2, volume_unit: "packs",
  location: "United Kingdom", spec: { formats: ["Packs"], min_soh: 80 }, ...o,
}), new Set(["vauxhall", "vivaro-e", "peugeot", "rifter", "e-208", "citroen", "e-berlingo"]));

/** Scores the lines and builds the rows the request tab would get, then groups them (as demandMatchesV2 does). */
function build(lines: StockRow[], req: Requirement = ask(), all: StockRow[] = lines): { rows: MatchRow[]; inputs: GroupInput[] } {
  const packs = packIdentities(all.map(identityInput));
  const inputs: GroupInput[] = lines.map((row, index) => {
    const match = scoreCandidate(req, stockCandidate(row));
    if (!match) throw new Error(`${row.title} does not match`);
    const c = match.candidate;
    const price = c.price != null ? `EUR ${c.price.toLocaleString("en-GB")}` : null;
    const out: MatchRow = {
      key: c.key, rank: index + 1, name: c.seller ?? "?", detail: null, tags: ["unlisted stock"], reason: c.title, checks: [], price,
      offer: null, companyId: row.company_id, personId: row.person_id, contact: null, stockId: row.id, fit: fitMarks(req, match, { price }),
      link: row.source_url ? { href: row.source_url, label: "Open source" } : null, sourceKind: c.sourceKind ?? null, askFor: [],
    };
    return { row: out, match, extra: stockExtra(row, packs) };
  });
  return { rows: groupStock(inputs, req, NOW), inputs };
}

describe("grouping a request's stock by seller and pack identity", () => {
  it("groups a Vivaro-e and a Rifter that share a pack key from one seller, with Same pack in counts", () => {
    const lines = [
      ...[2020, 2075, 2140].map((price) => line({ price_eur: price, graph: STELLANTIS })),
      ...[2060, 2150].map((price) => line({ make: "Peugeot", model: "Rifter Allure Premium EV", title: "Peugeot Rifter battery", price_eur: price, location: "Warrington", graph: STELLANTIS })),
    ];
    const { rows, inputs } = build(lines);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.group).toMatchObject({ pack: "Stellantis 46 kWh NMC pack", count: 5, unsure: false, sameLabel: "Same pack in", lots: false });
    expect(row.group!.vehicles).toEqual([{ name: "Vauxhall Vivaro-e", n: 3 }, { name: "Peugeot Rifter Allure Premium EV", n: 2 }]);
    expect(row.group!.meta).toBe("EUR 2,020–2,150 per pack · Leeds, Warrington · salvage listings, 7 Nov");
    expect(row.group!.why!.title).toBe("Why these count as the same pack");
    expect(row.group!.why!.text).toContain("carry the Stellantis 50 kWh NMC pack (CATL), e-CMP / EMP2: NMC, 46 kWh usable, 50 kWh gross, 400 V");
    expect(row.group!.why!.text).toContain("Battery graph: matched on part number, high confidence, looked up 24 Oct.");
    // Cheapest first; the offer's stock line is the cheapest unit, and every unit's line is kept.
    expect(row.group!.units.map((unit) => unit.price)).toEqual(["EUR 2,020", "EUR 2,060", "EUR 2,075", "EUR 2,140", "EUR 2,150"]);
    expect(row.stockId).toBe(lines[0].id);
    expect(row.group!.stockIds).toEqual([lines[0].id, lines[3].id, lines[1].id, lines[2].id, lines[4].id]);
    expect(row.group!.units[0]).toMatchObject({ vehicle: "Vauxhall Vivaro-e", year: 2022, ref: lines[0].supplier_ref, location: "Leeds", seen: "7 Nov", link: { label: "Listing" } });
    expect(groupSummary(rows, inputs, ask())).toEqual({ count: { suppliers: 1, units: 5, word: "packs" }, packTypes: { types: 1, unconfirmed: 0 }, grouped: true });
  });

  it("confirms a pack through a part number the graph links to it, but not through a low-confidence key", () => {
    const teacher = line({ graph: STELLANTIS, part_numbers: ["9832817280"] });
    const pupil = line({ make: "Peugeot", model: "e-208 GT", title: "Peugeot e-208 battery", part_numbers: ["98328172-80"] });
    const unsure = line({ make: "Peugeot", model: "e-208 GT", title: "Peugeot e-208 battery", graph: { ...STELLANTIS, confidence: "low" } });
    const identities = packIdentities([teacher, pupil, unsure].map(identityInput));
    expect(identities.get(pupil.id)).toMatchObject({ key: "pack|fam:stellantis-50-nmc", confirmed: true, how: "part number", part: "98328172-80" });
    expect(identities.get(unsure.id)).toMatchObject({ confirmed: false });
    const { rows } = build([teacher, pupil, unsure]);
    expect(rows).toHaveLength(2);
    expect(rows[0].group!.vehicles.map((v) => v.name)).toEqual(["Peugeot e-208 GT", "Vauxhall Vivaro-e"]);
    expect(rows[0].group!.why!.text).toContain("1 of 2 matched through their part number (98328172-80)");
    expect(rows[1].group).toBeUndefined();
  });

  it("keeps lines with no confirmed pack apart per vehicle, tagged Pack type not confirmed", () => {
    const berlingo = [1950, 1950, 1990].map((price) => line({ make: "Citroen", model: "e-Berlingo Flair", capacity_kwh: null, title: "Citroen e-Berlingo battery", price_eur: price, location: "Bristol", company_id: "comp_fenwick", person_id: "p_fenwick", supplier: "Fenwick Auto" }));
    const rifter = line({ make: "Peugeot", model: "Rifter", capacity_kwh: null, title: "Peugeot Rifter battery", location: "Bristol", company_id: "comp_fenwick", person_id: "p_fenwick", supplier: "Fenwick Auto" });
    const { rows, inputs } = build([...berlingo, rifter]);
    expect(rows).toHaveLength(2);
    const [group, single] = rows;
    expect(group.group).toMatchObject({ pack: "Pack from Citroen e-Berlingo Flair", count: 3, unsure: true, sameLabel: "Listed as" });
    expect(group.group!.vehicles).toEqual([{ name: "Citroen e-Berlingo Flair", n: 3 }]);
    expect(group.group!.why!.title).toBe("Why this is kept apart");
    expect(group.group!.why!.text).toContain("give no part number, and the battery graph has no confident match");
    expect(group.group!.meta).toBe("EUR 1,950–1,990 per pack · Bristol · salvage listings, 7 Nov");
    // A different vehicle with no confirmed pack never joins: it stays a plain row.
    expect(single.key).toBe(`stock:${rifter.id}`);
    expect(single.group).toBeUndefined();
    expect(groupSummary(rows, inputs, ask()).packTypes).toEqual({ types: 2, unconfirmed: 2 });
  });

  it("never merges two sellers, even with the same pack and a name bySeller folds together", () => {
    const northway = [line({ graph: STELLANTIS }), line({ graph: STELLANTIS })];
    const other = [
      line({ graph: STELLANTIS, company_id: "comp_northway_breakers", person_id: "p_nb", supplier: "Northway Breakers" }),
      line({ graph: STELLANTIS, company_id: "comp_carden", person_id: "p_carden", supplier: "Carden Breakers" }),
    ];
    const { rows, inputs } = build([...northway, ...other]);
    expect(rows.map((row) => [row.name, row.group?.count ?? 1])).toEqual([["Northway Parts", 2], ["Northway Breakers", 1], ["Carden Breakers", 1]]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(groupSummary(rows, inputs, ask()).count).toEqual({ suppliers: 3, units: 4, word: "packs" });
  });

  it("groups cells by seller and cell model, as lots", () => {
    const cells = requirementFor(demand({
      product_family: "Samsung 21700 cells", wants: "500,000 Samsung 21700 cells", volume: 500_000, volume_unit: "cells",
      spec: { formats: ["Cells"], cell_makers: ["Samsung SDI"] },
    }));
    const cell = (o: Partial<StockRow>) => line({
      make: "Samsung", model: "INR21700-50E", format: "cell", capacity_kwh: 0.018, quantity: 1, quantity_available: null, quantity_stated: false,
      price_eur: null, title: "Samsung INR21700-50E cells", company_id: "comp_cells", person_id: "p_cells", supplier: "Cell Co", source: "supplier list", ...o,
    });
    const lots = [cell({ quantity_available: 12_000, quantity_stated: null, price_eur: 2.1 }), cell({ quantity_available: 4_000, quantity_stated: null, price_eur: 1.95 }), cell({ model: "INR21700-40T", title: "Samsung INR21700-40T cells" })];
    const { rows, inputs } = build(lots, cells);
    expect(rows).toHaveLength(2);
    expect(rows[0].group).toMatchObject({ pack: "Samsung INR21700-50E cells", count: 2, countWord: "lots", lots: true, sameLabel: null, vehicles: [] });
    expect(rows[0].group!.units.map((unit) => unit.vehicle)).toEqual(["Samsung INR21700-50E cells · 4,000 cells", "Samsung INR21700-50E cells · 12,000 cells"]);
    expect(rows[0].group!.meta).toMatch(/^EUR 1\.95–2\.1 per cell · Leeds · stock list, 7 Nov$/);
    expect(rows[1].group).toBeUndefined();
    expect(groupSummary(rows, inputs, cells).count).toEqual({ suppliers: 1, units: 3, word: "lots" });
  });

  it("reads a line with no format on a cell request as a lot, by its code: a 50E and a 35E never merge", () => {
    const cells = requirementFor(demand({ wants: "100,000 18650 or 21700 cells for repair", volume: 100_000, volume_unit: "cells", spec: { formats: ["Cells"] } }));
    const email = (code: string) => line({
      make: null, model: null, format: null, capacity_kwh: null, quantity: 1, quantity_available: null, quantity_stated: null, price_eur: null,
      supplier: "AATGNR (US cell seller)", company_id: "comp_aat", person_id: "p_aat", supplier_ref: code, source: "supplier email",
      title: "Seller email 22 Oct 2026: loose cells from e-bike packs, shipping from Florida, USA", description: `Loose ${code} cells`,
    });
    const { rows } = build([email("INR21700-50E"), email("INR18650-35E")], cells);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.group)).toBe(true);
    const { rows: same } = build([email("INR21700-50E"), email("INR21700-50E")], cells);
    expect(same[0].group).toMatchObject({ lots: true, unsure: false, count: 2, countWord: "lots" });
  });

  it("gives the group ranges where units differ, and counts SoH stated", () => {
    const req = ask({ wants: "2-13 Vauxhall Vivaro-e 50 kWh packs", max_price: 2100, price_currency: "EUR", price_unit: "pack" });
    const lines = [
      line({ graph: STELLANTIS, price_eur: 2020, soh_percent: 92 }),
      line({ graph: STELLANTIS, price_eur: 2075 }),
      line({ graph: STELLANTIS, price_eur: 2210, soh_percent: 88, capacity_kwh: 52 }),
    ];
    const { rows } = build(lines, req);
    const marks = Object.fromEntries(rows[0].fit!.map((mark) => [mark.key, { label: mark.label, state: mark.state }]));
    expect(marks.condition).toEqual({ label: "SoH: 2 of 3 stated", state: "close" });
    expect(marks.price).toEqual({ label: "EUR 2,020–2,210", state: "close" });
    expect(marks.capacity).toEqual({ label: "50–52 kWh", state: "fits" });
    expect(marks.quantity).toEqual({ label: "3 available · need 2–13", state: "fits" });
    expect(marks.location).toEqual({ label: "In GB", state: "fits" });
    // Every SoH stated and at the minimum: one range, fits.
    const stated = groupMarks(req, [92, 86].map((soh) => ({ candidate: { ...stockCandidate(line()), soh }, marks: [{ key: "condition", label: "SoH", state: "fits" as const }] })), null);
    expect(stated).toEqual([{ key: "condition", label: "SoH 86–92%", state: "fits", name: undefined }]);
  });

  it("splits lines under one listing part number where their stated kWh differ", () => {
    const mg = (kwh: number) => line({ make: "MG", model: "MG4", capacity_kwh: kwh, title: `MG MG4 ${kwh} kWh battery pack`, part_numbers: ["11578836"] });
    const req = requirementFor(demand({ wants: "2-13 MG MG4 packs", quantity: "2-13 packs", volume: 2, volume_unit: "packs", spec: { formats: ["Packs"] } }), new Set(["mg", "mg4"]));
    const { rows } = build([mg(64), mg(64), mg(77), mg(77)], req);
    expect(rows.map((row) => row.group?.pack)).toEqual(["64 kWh pack, part 11578836", "77 kWh pack, part 11578836"]);
    expect(rows[0].group!.why!.text).toContain("Every unit states part number 11578836");
  });
});

describe("the units table", () => {
  it("marks SoH against the request's minimum: ✓ at or above, ≈ within 5 points, ✗ further below or damaged, ? not stated", () => {
    const none = { damage: [], sohBasis: null, sohText: null };
    expect(sohMark({ soh: 92 }, { ...none, sohBasis: "supplier_test" }, 80)).toEqual({ state: "fits", label: "SoH 92%", source: "supplier test" });
    expect(sohMark({ soh: 77 }, none, 80)).toMatchObject({ state: "close", label: "SoH 77%" });
    expect(sohMark({ soh: 74 }, none, 80)).toMatchObject({ state: "misses", label: "SoH 74%" });
    expect(sohMark({ soh: 95 }, { ...none, damage: ["casing"] }, 80)).toEqual({ state: "misses", label: "Casing damaged", source: null });
    expect(sohMark({ soh: null }, { ...none, damage: ["damaged"] }, 80)).toMatchObject({ state: "misses", label: "Damaged" });
    expect(sohMark({ soh: null }, { ...none, sohText: "SOH OK" }, 80)).toEqual({ state: "unstated", label: "Not stated", source: "“SOH OK”" });
    expect(sohMark({ soh: 70 }, none, null)).toMatchObject({ state: "fits" });
  });

  it("names vehicles without trims, years, arrows or body codes", () => {
    expect(vehicleName({ make: "Citroen", model: "Citroen Berlingo Electric (half pack front/rear) 2018", title: "" })).toBe("Citroen Berlingo Electric");
    expect(vehicleName({ make: "Peugeot", model: "208/E-208 >", title: "" })).toBe("Peugeot 208/E-208");
    expect(vehicleName({ make: "Peugeot", model: "208 II UB, UP, UW, UJ", title: "" })).toBe("Peugeot 208 II");
    expect(vehicleName({ make: null, model: null, title: "EV battery" })).toBe("EV battery");
  });

  it("keeps unknown-kWh lines with a single capacity, and alone when capacities split", () => {
    const member = (kwh: number | null) => ({ row: { key: `k${kwh}` }, match: { candidate: { kwh } }, extra: null }) as unknown as GroupInput;
    expect(splitByKwh([member(50), member(null), member(52)]).map((set) => set.length)).toEqual([3]);
    expect(splitByKwh([member(64), member(77), member(null)]).map((set) => set.length)).toEqual([1, 1, 1]);
  });
});

it("reads identity inputs from a stock line's graph fields", () => {
  const input: IdentityInput = identityInput(line({ graph: STELLANTIS, part_numbers: ["9832817280"] }));
  expect(input.graph).toMatchObject({ pack_key: "fam:stellantis-50-nmc", confidence: "high", input: "9832817280" });
  expect(identityInput(line()).graph).toBeNull();
});
