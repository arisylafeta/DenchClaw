import { describe, expect, it } from "vitest";
import { requirementFor, scoreCandidate, type Requirement } from "../demand-match";
import { fitMarks } from "./fit-marks";
import { groupMarks, groupStock, groupSummary, packIdentities, sohMark, clusterByKwh, vehicleName, type GraphMatch, type GroupInput, type IdentityInput } from "./stock-groups";
import { identityInput, listingIdentityInput, stockCandidate, stockExtra, type StockRow } from "../crm-postgres/demand-matches-v2";
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
    expect(row.group).toMatchObject({ pack: "Stellantis 50 kWh NMC pack", count: 5, unsure: false, sameLabel: "Same pack in", lots: false });
    expect(row.group!.vehicles).toEqual([{ name: "Vauxhall Vivaro-e", n: 3 }, { name: "Peugeot Rifter Allure Premium EV", n: 2 }]);
    expect(row.group!.meta).toBe("EUR 2,020–2,150 per pack · Leeds, Warrington · salvage listings, 7 Nov");
    expect(row.group!.why!.title).toBe("Why these count as the same pack");
    expect(row.group!.why!.text).toContain("carry the Stellantis 50 kWh NMC pack (CATL), e-CMP / EMP2: NMC, 46 kWh usable, 50 kWh gross, 400 V");
    expect(row.group!.why!.source).toBe("Battery graph · matched on part number · high confidence · looked up 24 Oct");
    expect(row.group!.priceVaries).toBe(false);
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
    const other = line({ make: "Citroen", model: "e-Berlingo", title: "Citroen e-Berlingo battery", graph: { ...STELLANTIS, confidence: "low" } });
    const identities = packIdentities([teacher, pupil, unsure, other].map(identityInput));
    expect(identities.get(pupil.id)).toMatchObject({ key: "pack|fam:stellantis-50-nmc", confirmed: true, how: "part number", part: "98328172-80" });
    expect(identities.get(unsure.id)).toMatchObject({ confirmed: false });
    const { rows } = build([teacher, pupil, unsure, other]);
    // The unconfirmed e-208 joins the confirmed one as the same vehicle; the low-key Berlingo joins nothing.
    expect(rows).toHaveLength(2);
    expect(rows[0].group!.vehicles).toEqual([{ name: "Peugeot e-208 GT", n: 2 }, { name: "Vauxhall Vivaro-e", n: 1 }]);
    expect(rows[0].group!.why!.source).toContain("1 of 3 through their part number (98328172-80)");
    expect(rows[0].group!.why!.text).toContain("One line has no confirmed pack of its own and joins by vehicle and capacity as listed (50 kWh).");
    expect(rows[1].key).toBe(`stock:${other.id}`);
    expect(rows[1].group).toBeUndefined();
  });

  it("groups lines with no confirmed pack by vehicle only, tagged Pack type not confirmed", () => {
    const berlingo = [1950, 1950, 1990].map((price) => line({ make: "Citroen", model: "e-Berlingo Flair", capacity_kwh: null, title: "Citroen e-Berlingo battery", price_eur: price, location: "Bristol", company_id: "comp_fenwick", person_id: "p_fenwick", supplier: "Fenwick Auto" }));
    const rifter = line({ make: "Peugeot", model: "Rifter", capacity_kwh: null, title: "Peugeot Rifter battery", location: "Bristol", company_id: "comp_fenwick", person_id: "p_fenwick", supplier: "Fenwick Auto" });
    const { rows, inputs } = build([...berlingo, rifter]);
    expect(rows).toHaveLength(2);
    const [group, single] = rows;
    expect(group.group).toMatchObject({ pack: "Citroen e-Berlingo Flair · EV pack", count: 3, unsure: true, sameLabel: null });
    expect(group.group!.vehicles).toEqual([{ name: "Citroen e-Berlingo Flair", n: 3 }]);
    expect(group.group!.why!.title).toBe("Why these are one row");
    expect(group.group!.why!.text).toBe("Grouped by vehicle and capacity as listed (Citroen e-Berlingo Flair), not by a confirmed pack. No part number is listed, and the battery graph has no confident match.");
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
      line({ graph: STELLANTIS, price_eur: 2210, soh_percent: 88, capacity_kwh: 51 }),
    ];
    const { rows } = build(lines, req);
    const marks = Object.fromEntries(rows[0].fit!.map((mark) => [mark.key, { label: mark.label, state: mark.state }]));
    expect(marks.condition).toEqual({ label: "SoH: 2 of 3 stated", state: "close" });
    expect(marks.price).toEqual({ label: "EUR 2,020–2,210", state: "close" });
    expect(marks.capacity).toEqual({ label: "50–51 kWh", state: "fits" });
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
    expect(rows.map((row) => row.group?.pack)).toEqual(["MG4 · 64 kWh pack", "MG4 · 77 kWh pack"]);
    expect(rows.map((row) => row.group?.unsure)).toEqual([false, false]);
    expect(rows[0].group!.why!.text).toContain("Every unit states part number 11578836");
  });
});

describe("marketplace listings", () => {
  /** A stock line re-keyed as a marketplace listing row, as demandMatchesV2 builds it (no stock id, no CRM identity). */
  function listingInputs(lines: StockRow[], req: Requirement = ask(), stock: StockRow[] = []): GroupInput[] {
    const candidates = lines.map((row) => {
      const c = stockCandidate(row);
      return { ...c, key: `listing:${row.id}`, source: "marketplace" as const };
    });
    // As demandMatchesV2: listings learn identity alongside every stock line, so a listed part number can inherit a pack.
    const packs = packIdentities([...stock.map(identityInput), ...candidates.map(listingIdentityInput)]);
    return candidates.map((c, index) => {
      const match = scoreCandidate(req, c);
      if (!match) throw new Error(`${c.title} does not match`);
      const row: MatchRow = {
        key: c.key, rank: index + 1, name: c.seller ?? "?", detail: null, tags: ["marketplace"], reason: c.title, checks: [], price: null,
        offer: null, companyId: null, personId: null, contact: null, stockId: null, fit: fitMarks(req, match, { price: null }),
        link: null, sourceKind: "marketplace", askFor: [],
      };
      return { row, match, extra: { identity: packs.get(c.key) ?? null, damage: [], sohBasis: null, sohText: null } };
    });
  }

  it("groups one seller's listings that share a part number (Ari, 8 Nov: Autohandel DIDIER's Audi Q4 packs)", () => {
    const rows = groupStock(listingInputs([line({ part_numbers: ["9868397180"] }), line({ part_numbers: ["9868397180"] }), line({ part_numbers: ["9868397180"] })]), ask(), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].group!.units).toHaveLength(3);
    expect(rows[0].group!.stockIds).toEqual([]);
  });

  it("never puts a marketplace listing and an unlisted stock line in one row", () => {
    const stockSide = build([line({ part_numbers: ["9868397180"] }), line({ part_numbers: ["9868397180"] })]).inputs;
    const listingSide = listingInputs([line({ part_numbers: ["9868397180"] }), line({ part_numbers: ["9868397180"] })]);
    const rows = groupStock([...stockSide, ...listingSide], ask(), NOW);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.group!.units[0].key.split(":")[0]).sort()).toEqual(["listing", "stock"]);
  });

  describe("one seller's Audi Q4 packs (Ari, 8 Nov: Autohandel DIDIER showed four rows)", () => {
    const MEB: GraphMatch = {
      pack_key: "fam:audi-bev-eu-v1-07", confidence: "high", pack: "VW MEB 82 kWh gross / 77 kWh usable pack (ID.4, Q4 e-tron top battery)",
      usable_kwh: 77, gross_kwh: 82, chemistry: "NMC", voltage: null, kind: "part number", input: "0Z1915910CE", looked_up_on: "2026-10-30",
    };
    const meb = (o: Partial<Demand> = {}) => requirementFor(demand({
      wants: "VW MEB 82 kWh packs: Audi Q4, Skoda Enyaq, VW ID.4", quantity: "10-20 packs", volume: 10, volume_unit: "packs", spec: { formats: ["Packs"] }, ...o,
    }), new Set(["audi", "q4", "skoda", "enyaq", "volkswagen", "id.4", "vw"]));
    const didier = (o: Partial<StockRow>) => line({
      make: "Audi", model: "Q4", capacity_kwh: 82, title: "Audi Q4 82kWh", company_id: null, person_id: "", supplier: "Autohandel DIDIER NV",
      location: "Belgium", country: "BE", price_eur: 4200, supplier_ref: null, source: null, ...o,
    });
    // A stock line elsewhere teaches the graph's MEB pack to part number 0Z1915910CE.
    const teacher = line({ make: "Audi", model: "Q4 e-tron 40", capacity_kwh: 82, graph: MEB, part_numbers: ["0Z1915910CE"], supplier: "LKQ", company_id: "comp_lkq" });
    const listings = [
      didier({ capacity_kwh: 77, title: "Audi Q4 77kWh", part_numbers: ["0Z1915910AJ"], price_eur: 4400 }),
      ...[1, 2, 3].map(() => didier({ part_numbers: ["0Z1915910CD"] })),
      didier({ capacity_kwh: 77, title: "Audi Q4 77kWh", part_numbers: ["0Z1915910CD"], price_eur: null }),
      didier({ part_numbers: ["0Z1915910CE"], price_eur: 4100 }),
      didier({ part_numbers: null }),
    ];

    it("are one row × N, titled by vehicle and the graph's pack, with the kWh the capacity mark shows", () => {
      const rows = groupStock(listingInputs(listings, meb(), [teacher]), meb(), NOW);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.group).toMatchObject({ pack: "Audi Q4 · VW MEB 77–82 kWh pack", count: 7, unsure: false, sameLabel: null });
      expect(row.holds).toBe("Audi Q4 · VW MEB 77–82 kWh pack × 7");
      expect(row.fit!.find((mark) => mark.key === "capacity")!.label).toBe("77–82 kWh");
      expect(row.group!.pack).not.toMatch(/part/i);
      expect(row.group!.why!.text).toContain("All 7 carry the VW MEB 82 kWh gross / 77 kWh usable pack");
      expect(row.group!.why!.text).toContain("6 lines have no confirmed pack of their own and join by vehicle and capacity as listed (77–82 kWh).");
      expect(row.group!.why!.text).toContain("Part numbers listed: 0Z1915910CD (4), 0Z1915910AJ, 0Z1915910CE.");
      // Part numbers stay in the units table.
      expect(row.group!.units.map((unit) => unit.ref).filter(Boolean)).toContain("0Z1915910AJ");
    });

    it("without a graph line, 77 and 82 kWh stay two rows, each grouped by vehicle and capacity and tagged", () => {
      const rows = groupStock(listingInputs(listings.filter((row) => !row.part_numbers?.includes("0Z1915910CE")), meb(), [teacher]), meb(), NOW);
      expect(rows.map((row) => [row.group?.pack, row.group?.count, row.group?.unsure])).toEqual([
        ["Audi Q4 · 77 kWh pack", 2, true], ["Audi Q4 · 82 kWh pack", 4, true],
      ]);
      expect(rows[0].group!.why).toEqual({
        title: "Why these are one row",
        text: "Grouped by vehicle and capacity as listed (Audi Q4, 77 kWh), not by a confirmed pack. Part numbers listed: 0Z1915910AJ, 0Z1915910CD; the battery graph has no confident match for them.",
        source: "Ask the seller for the pack label photo or part number",
      });
    });

    it("never join another vehicle from the same seller without a confident shared identity", () => {
      const enyaq = didier({ make: "Skoda", model: "Enyaq IV", title: "Skoda Enyaq IV 82kWh", part_numbers: null });
      const rows = groupStock(listingInputs([...listings, enyaq], meb(), [teacher]), meb(), NOW);
      expect(rows.map((row) => row.group?.count ?? 1)).toEqual([7, 1]);
      // A second Enyaq stating the taught part number joins the Q4s through the high-confidence key, as "Same pack in".
      const taught = didier({ make: "Skoda", model: "Enyaq IV", title: "Skoda Enyaq IV 82kWh", part_numbers: ["0Z1915910CE"] });
      const joined = groupStock(listingInputs([...listings, enyaq, taught], meb(), [teacher]), meb(), NOW);
      expect(joined).toHaveLength(1);
      expect(joined[0].group).toMatchObject({ pack: "VW MEB 77–82 kWh pack", count: 9, sameLabel: "Same pack in" });
      expect(joined[0].group!.vehicles).toEqual([{ name: "Audi Q4", n: 7 }, { name: "Skoda Enyaq IV", n: 2 }]);
    });
  });
});

describe("merge safety", () => {
  const MEDIUM: GraphMatch = { ...STELLANTIS, confidence: "medium" };
  const vivaro = (o: Partial<StockRow> & { graph?: GraphMatch | null } = {}) => line(o);
  const rifter = (o: Partial<StockRow> & { graph?: GraphMatch | null } = {}) => line({ make: "Peugeot", model: "Rifter", title: "Peugeot Rifter battery", ...o });

  it("merges different makes only on a high-confidence key; a medium key merges within one make", () => {
    const high = build([vivaro({ graph: STELLANTIS }), rifter({ graph: STELLANTIS })]).rows;
    expect(high).toHaveLength(1);
    const medium = build([vivaro({ graph: MEDIUM }), vivaro({ graph: MEDIUM }), rifter({ graph: MEDIUM })]).rows;
    expect(medium.map((row) => row.group?.vehicles ?? null)).toEqual([[{ name: "Vauxhall Vivaro-e", n: 2 }], null]);
  });

  it("merges different makes on one identical listed part number", () => {
    const { rows } = build([line({ part_numbers: ["9868397180"] }), rifter({ part_numbers: ["9868397180"] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].group).toMatchObject({ pack: "50 kWh pack", sameLabel: "Same pack in", unsure: false });
    expect(rows[0].group!.why!.text).toContain("Every unit states part number 9868397180, across the Peugeot Rifter and Vauxhall Vivaro-e");
  });

  it("splits any merge where stated kWh differ by more than 10%, or the format differs", () => {
    const kwh = build([vivaro({ graph: STELLANTIS }), vivaro({ graph: STELLANTIS }), vivaro({ graph: STELLANTIS, capacity_kwh: 75, title: "Vauxhall Vivaro-e 75 kWh battery" })]).rows;
    expect(kwh.map((row) => row.group?.count ?? 1)).toEqual([2, 1]);
    const req = requirementFor(demand({ wants: "2-13 Vauxhall Vivaro-e packs or modules", quantity: "2-13", volume: 2, volume_unit: "units", spec: { formats: ["Packs", "Modules"] } }), new Set(["vauxhall", "vivaro-e"]));
    const format = build([vivaro({ graph: STELLANTIS }), vivaro({ graph: STELLANTIS }), vivaro({ graph: STELLANTIS, format: "module", capacity_kwh: null })], req).rows;
    expect(format.map((row) => row.group?.count ?? 1)).toEqual([2, 1]);
  });

  it("never joins a Kona to a Niro without a high key; a medium key or no identity keeps them apart", () => {
    const req = requirementFor(demand({ wants: "2-13 Hyundai Kona or Kia e-Niro 64 kWh packs", quantity: "2-13 packs", volume: 2, volume_unit: "packs", spec: { formats: ["Packs"] } }),
      new Set(["hyundai", "kona", "kia", "e-niro", "niro"]));
    const KONA_NIRO: GraphMatch = { ...STELLANTIS, pack_key: "fam:hmg-64-nmc", pack: "Hyundai/Kia 64 kWh pack", usable_kwh: 64, gross_kwh: 67.5, confidence: "medium" };
    const kona = (o: Partial<StockRow> & { graph?: GraphMatch | null } = {}) => line({ make: "Hyundai", model: "Kona Electric", capacity_kwh: 64, title: "Hyundai Kona 64 kWh battery", ...o });
    const niro = (o: Partial<StockRow> & { graph?: GraphMatch | null } = {}) => line({ make: "Kia", model: "e-Niro", capacity_kwh: 64, title: "Kia e-Niro 64 kWh battery", ...o });
    const medium = build([kona({ graph: KONA_NIRO }), kona({ graph: KONA_NIRO }), niro({ graph: KONA_NIRO }), niro()], req).rows;
    expect(medium.map((row) => row.group?.vehicles.map((v) => v.name) ?? null)).toEqual([["Hyundai Kona Electric"], ["Kia e-Niro"]]);
    const none = build([kona(), kona(), niro(), niro()], req).rows;
    expect(none.map((row) => [row.group?.pack, row.group?.unsure])).toEqual([["Hyundai Kona Electric · 64 kWh pack", true], ["Kia e-Niro · 64 kWh pack", true]]);
    const high = build([kona({ graph: { ...KONA_NIRO, confidence: "high" } }), niro({ graph: { ...KONA_NIRO, confidence: "high" } }), niro()], req).rows;
    expect(high).toHaveLength(1);
    expect(high[0].group!.vehicles).toEqual([{ name: "Kia e-Niro", n: 2 }, { name: "Hyundai Kona Electric", n: 1 }]);
  });

  it("splits one vehicle's lines more than 3% apart: a 42 kWh and a 49 kWh 2008 are two rows", () => {
    const req = requirementFor(demand({ wants: "2-13 Peugeot e-2008 packs", quantity: "2-13 packs", volume: 2, volume_unit: "packs", spec: { formats: ["Packs"] } }), new Set(["peugeot", "2008", "e-2008"]));
    const p2008 = (kwh: number) => line({ make: "Peugeot", model: "e-2008", capacity_kwh: kwh, title: `Peugeot e-2008 ${kwh} kWh battery` });
    const { rows } = build([p2008(42), p2008(42), p2008(49), p2008(49)], req);
    expect(rows.map((row) => row.group?.pack)).toEqual(["Peugeot e-2008 · 42 kWh pack", "Peugeot e-2008 · 49 kWh pack"]);
  });

  it("splits Ioniq 5 72.6 from 77.4 kWh, and a Stellantis van at 49.2/50 from 54 kWh, with no graph pack naming both", () => {
    const req = requirementFor(demand({ wants: "2-13 Hyundai Ioniq 5 packs", quantity: "2-13 packs", volume: 2, volume_unit: "packs", spec: { formats: ["Packs"] } }),
      new Set(["hyundai", "ioniq", "ioniq 5"]));
    const ioniq = (kwh: number) => line({ make: "Hyundai", model: "Ioniq 5", capacity_kwh: kwh, title: `Hyundai Ioniq 5 ${kwh} kWh battery` });
    expect(build([ioniq(72.6), ioniq(72.6), ioniq(77.4), ioniq(77.4)], req).rows.map((row) => row.group?.pack))
      .toEqual(["Hyundai Ioniq 5 · 72.6 kWh pack", "Hyundai Ioniq 5 · 77.4 kWh pack"]);
    // The Proace City case on the request's own vans (Stellantis 50 kWh and 54 kWh packs).
    const van = (kwh: number) => line({ capacity_kwh: kwh, title: `Vauxhall Vivaro-e ${kwh} kWh battery` });
    expect(build([van(49.2), van(50), van(54), van(54)]).rows.map((row) => row.group?.pack))
      .toEqual(["Vauxhall Vivaro-e · 49.2–50 kWh pack", "Vauxhall Vivaro-e · 54 kWh pack"]);
  });

  it("joins usable and gross figures through a confident graph line, chaining by union-find", () => {
    const MEB: GraphMatch = { ...STELLANTIS, pack_key: "fam:audi-bev-eu-v1-07", pack: "VW MEB 82 kWh gross / 77 kWh usable pack", usable_kwh: 77, gross_kwh: 82 };
    const req = requirementFor(demand({ wants: "2-13 Audi Q4 packs", quantity: "2-13 packs", volume: 2, volume_unit: "packs", spec: { formats: ["Packs"] } }), new Set(["audi", "q4"]));
    const q4 = (kwh: number, graph?: GraphMatch) => line({ make: "Audi", model: "Q4", capacity_kwh: kwh, title: `Audi Q4 ${kwh} kWh battery`, graph });
    expect(build([q4(77), q4(82), q4(82, MEB)], req).rows.map((row) => row.group?.count ?? 1)).toEqual([3]);
    expect(build([q4(77), q4(82), q4(82)], req).rows.map((row) => row.group?.count ?? 1)).toEqual([1, 2]);
    // A graph line whose own stated kWh is neither figure bridges nothing.
    expect(build([q4(77), q4(82), q4(60, MEB)], req).rows).toHaveLength(3);
  });

  it("does not title a group with a graph pack its stated kWh contradict", () => {
    const req = requirementFor(demand({ wants: "2-13 Renault Zoe packs", quantity: "2-13 packs", volume: 2, volume_unit: "packs", spec: { formats: ["Packs"] } }), new Set(["renault", "zoe"]));
    const ZE40: GraphMatch = { ...STELLANTIS, pack_key: "fam:renault-ze40", pack: "Renault Zoe ZE40 traction pack, 41 kWh", usable_kwh: 41, gross_kwh: 45.3 };
    const zoe = (o: Partial<StockRow> & { graph?: GraphMatch | null } = {}) => line({ make: "Renault", model: "Zoe", capacity_kwh: 22, title: "Renault Zoe 22 kWh battery", ...o });
    const { rows } = build([zoe({ graph: ZE40 }), zoe()], req);
    expect(rows[0].group).toMatchObject({ pack: "Renault Zoe · 22 kWh pack", unsure: true });
    expect(rows[0].group!.why!.text).toContain("as the Renault Zoe ZE40 traction pack, 41 kWh (41 / 45.3 kWh), which does not agree with the listed kWh.");
  });

  it("keeps a group whose prices spread over 2.5×, and flags it", () => {
    const { rows } = build([vivaro({ graph: STELLANTIS, price_eur: 1439 }), vivaro({ graph: STELLANTIS, price_eur: 13698 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].group!.priceVaries).toBe(true);
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
    expect(clusterByKwh([member(50), member(null), member(51)]).map((set) => set.length)).toEqual([3]);
    expect(clusterByKwh([member(64), member(77), member(null)]).map((set) => set.length)).toEqual([1, 1, 1]);
  });
});

it("reads identity inputs from a stock line's graph fields", () => {
  const input: IdentityInput = identityInput(line({ graph: STELLANTIS, part_numbers: ["9832817280"] }));
  expect(input.graph).toMatchObject({ pack_key: "fam:stellantis-50-nmc", confidence: "high", input: "9832817280" });
  expect(identityInput(line()).graph).toBeNull();
});
