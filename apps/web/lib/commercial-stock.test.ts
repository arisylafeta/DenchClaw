import { describe, expect, it } from "vitest";
import {
  aggregateStock, chemistryFamilies, cleanModel, effectiveFormat, groupKeyFor, matchesFilters, normalCountry, normalModel, normalPowertrain,
  lotKeyFor, packLabel, partKey, searchRows, suggestModels, supplierToken, withPackIdentity, type StockRow,
} from "./commercial-stock";

const row = (over: Partial<StockRow>): StockRow => ({
  id: "sto_1", company_id: "co_a", person_id: "p_a", supplier: "Secret Breaker AB", status: "opportunity",
  make: "Peugeot", model: "208/E 208", format: "pack", capacity_kwh: 50, chemistry: "NMC622", powertrain: "BEV",
  year: 2022, country: "Sweden", quantity: 1, price_eur_ex_vat: 4000, price_eur: 5000, seen_on: "2026-10-27",
  sync_class: "synced", ...over,
});

const anon = (id: string) => supplierToken(id, "test-scope", "k".repeat(32));
const lotKeys = (id: string, group: string, part: string) => lotKeyFor(id, group, part, "test-scope", "k".repeat(32));
const aggregate = (rows: StockRow[]) => aggregateStock(rows, anon, lotKeys);

const stock = [
  row({ id: "sto_1" }),
  row({ id: "sto_2", company_id: "co_b", person_id: "p_b", supplier: "Other Dismantler UAB", country: "Lithuania", price_eur_ex_vat: 3500, sync_class: "syncable", year: 2021 }),
  row({ id: "sto_3", make: "VW", model: "ID.3", capacity_kwh: 58, chemistry: "NMC", price_eur_ex_vat: null, price_eur: 6000 }),
  row({ id: "sto_4", make: "Volkswagen", model: "ID.3", capacity_kwh: 58.0, chemistry: "nmc", quantity: 3, price_eur_ex_vat: 5000, company_id: "co_b", person_id: "p_b" }),
];

describe("stock lots", () => {
  const lotRows = [
    row({ id: "n1", make: "Kia", model: "Niro II", capacity_kwh: 64.8, price_eur_ex_vat: 4171, part_numbers: ["37501-AO050"], tested: true, soh_percent: 94, country: "Newbridge, Edinburgh, United Kingdom" }),
    row({ id: "n2", make: "Kia", model: "Niro II", capacity_kwh: 64.8, price_eur_ex_vat: 4489, part_numbers: ["37501AO050"], year: 2023, country: "United Kingdom" }),
    row({ id: "n5", make: "Kia", model: "Niro II", capacity_kwh: 64.8, price_eur_ex_vat: 2000, part_numbers: ["37501AO050"], damaged: true, country: "United Kingdom" }),
    row({ id: "n3", make: "Kia", model: "e-Niro", capacity_kwh: 64.8, price_eur_ex_vat: 5000, part_numbers: ["37501-Q4052"], country: "United Kingdom" }),
    row({ id: "n4", company_id: "co_b", person_id: "p_b", make: "Kia", model: "Niro Mk2", capacity_kwh: 64.8, quantity: 3, price_eur_ex_vat: null, price_eur: 6000, country: "Lithuania" }),
  ];
  const scoped = (scope: string) => aggregateStock(lotRows, (id) => supplierToken(id, scope, "k".repeat(32)), (id, group, part) => lotKeyFor(id, group, part, scope, "k".repeat(32)));

  it("splits a group by supplier and part number with rounded asks and condition counts", () => {
    const [group] = scoped("conv-1234");
    expect(group).toMatchObject({ units: 6, lotCount: 3 });
    const [lithuania, ao050, q4052] = group.lots;
    expect(lithuania).toMatchObject({ units: 3, countries: ["Lithuania"], askEurExVat: null, priced: 0, vatUnknown: 3, partNumbers: [], condition: { notStated: 3 } });
    expect(ao050).toMatchObject({ units: 2, countries: ["United Kingdom"], partNumbers: ["37501-AO050"], priced: 2,
      askEurExVat: { min: 4150, max: 4500 }, askEurPerKwh: { min: 64, max: 70 }, years: { min: 2022, max: 2023 },
      condition: { tested: 1, untested: 0, notStated: 1, sohMin: 94, sohMax: 94, damaged: 0 } });
    for (const lot of group.lots) expect(lot.condition.tested + lot.condition.untested + lot.condition.notStated).toBe(lot.units);
    expect(q4052).toMatchObject({ units: 1, partNumbers: ["37501-Q4052"], askEurExVat: { min: 5000, max: 5000 } });
    expect(ao050.supplier).toBe(q4052.supplier);
    expect(ao050.lotKey).toMatch(/^lot_[0-9a-f]{16}$/);
  });

  it("keeps lot keys stable within a scope, unlinkable across scopes, and free of identity", () => {
    const keys = (scope: string) => scoped(scope)[0].lots.map((lot) => lot.lotKey);
    expect(keys("conv-1234")).toEqual(keys("conv-1234"));
    expect(keys("conv-5678").some((key) => keys("conv-1234").includes(key))).toBe(false);
    const text = JSON.stringify(scoped("conv-1234"));
    for (const secret of ["Secret Breaker", "co_a", "co_b", "p_b", "n1", "Newbridge", "Edinburgh", "4171", "4489"]) expect(text).not.toContain(secret);
  });

  it("counts supplier-stated untested units, keeps two suppliers of one part apart, and never shows a town", () => {
    const [group] = aggregateStock([
      row({ id: "u1", tested: false, damaged: false, quantity: 4, part_numbers: ["0Z1915910FB"], country: "Sariai" }),
      row({ id: "u2", company_id: "co_c", person_id: "p_c", quantity: 2, part_numbers: ["0Z1915910FB"], country: "Kolin, Czechia" }),
      row({ id: "u3", company_id: null, person_id: "", quantity: 9 }),
    ], anon, lotKeys);
    expect(group.lots).toHaveLength(2);
    const [untested, other] = group.lots;
    expect(untested).toMatchObject({ units: 4, countries: [], condition: { tested: 0, untested: 4, notStated: 0, damaged: 0 } });
    expect(other).toMatchObject({ units: 2, countries: ["Czechia"] });
    expect(untested.lotKey).not.toBe(other.lotKey);
    expect(group.countries).toEqual(["Czechia"]);
    expect(JSON.stringify(group)).not.toMatch(/Sariai|Kolin/);
  });

  it("filters to exact group keys", () => {
    const key = groupKeyFor(lotRows[0]);
    expect(matchesFilters(lotRows[0], { groupKeys: [key] })).toBe(true);
    expect(matchesFilters(lotRows[0], { groupKeys: ["grp_0000000000000000"] })).toBe(false);
  });

  it("ignores run-on part number lists when splitting", () => {
    expect(partKey("37501-AO050")).toBe("37501A0050");
    expect(partKey("37501A0050")).toBe(partKey("37501-AO050"));
    expect(partKey("722FA0101240220323")).toBe("");
    expect(partKey("16 755 893 80 16 755 894 80 16 890 952 80")).toBe("");
    expect(partKey("123")).toBe("");
  });
});

describe("pack identity", () => {
  const eNiro = { pack_key: "fam:kia-niro-67-5", pack_name: "Kia e-Niro 67.5 kWh", usable_kwh: 64, gross_kwh: 67.5 };
  const niro2 = { pack_key: "evdb:kia|niro|68.0", pack_name: "Kia Niro EV 68.0 kWh", usable_kwh: 64.8, gross_kwh: 68 };

  it("puts every listing of one physical pack in one group under the usable kWh, whatever the advert calls it", () => {
    const groups = aggregate(withPackIdentity([
      row({ id: "a", make: "Kia", model: "Niro", capacity_kwh: 64, part_numbers: ["37501-Q4052"], ...eNiro }),
      row({ id: "b", make: "Kia", model: "Niro", capacity_kwh: 67.5, part_numbers: ["37501-Q4151"], ...eNiro }),
      row({ id: "c", make: "Kia", model: "Niro VAN DE", capacity_kwh: 64, part_numbers: ["37501Q4052"] }),
      row({ id: "d", make: "Kia", model: "Niro Mk2", capacity_kwh: 64.8, part_numbers: ["37501-AO050"], ...niro2 }),
      row({ id: "e", make: "Kia", model: "Niro II", capacity_kwh: 64.8, part_numbers: ["37501A0050"] }),
    ]));
    expect(groups.map((group) => [group.label, group.units, group.capacityKwh, group.grossKwh])).toEqual([
      ["Kia e-Niro 64 kWh pack", 3, 64, 67.5],
      ["Kia Niro EV 64.8 kWh pack", 2, 64.8, 68],
    ]);
  });

  it("never merges on a part number or spec that points to two packs, and leaves unknown listings in text groups", () => {
    const rows = withPackIdentity([
      row({ id: "a", make: "Kia", model: "Niro", capacity_kwh: 64, part_numbers: ["SHARED1"], ...eNiro }),
      row({ id: "b", make: "Kia", model: "Niro", capacity_kwh: 64, part_numbers: ["SHARED1"], ...niro2 }),
      row({ id: "c", make: "Kia", model: "Niro", capacity_kwh: 64, part_numbers: ["SHARED1"] }),
      row({ id: "d", make: "Kia", model: "Niro", capacity_kwh: 64 }),
      row({ id: "e", make: "Kia", model: "Soul", capacity_kwh: 27 }),
    ]);
    expect(rows.slice(2).map((r) => r.pack_key ?? null)).toEqual([null, null, null]);
  });

  it("learns a pack from a listing that states the same spec, only when the listing has no part number", () => {
    const [, learned, other] = withPackIdentity([
      row({ id: "a", make: "Kia", model: "Niro Mk2", capacity_kwh: 64.8, ...niro2 }),
      row({ id: "b", make: "Kia", model: "Niro Mk2", capacity_kwh: 64.8 }),
      row({ id: "c", make: "Kia", model: "Niro Mk2", capacity_kwh: 64.8, part_numbers: ["99999X9999"] }),
    ]);
    expect(learned.pack_key).toBe(niro2.pack_key);
    expect(other.pack_key ?? null).toBeNull();
  });

  it("groups only on curated pack identities, never on graph research keys", () => {
    const research = { pack_key: "res:notes-1", pack_name: "Audi q5 oem family candidate" };
    const groups = aggregate(withPackIdentity([
      row({ id: "a", make: "Audi", model: "Q5", capacity_kwh: 17.9, part_numbers: ["80A915591A"], ...research }),
      row({ id: "b", make: "Audi", model: "Q5", capacity_kwh: 14.1, part_numbers: ["80A915591A"], ...research }),
    ]));
    expect(groups.map((group) => group.units)).toEqual([1, 1]);
  });

  it("keeps damaged packs out of every group", () => {
    expect(aggregate([row({ id: "x", damaged: true }), row({ id: "y" })])[0].units).toBe(1);
  });

  it("labels named packs without brackets or spec tails and falls back when a name is unusable", () => {
    expect(packLabel("Hyundai Kona Electric 64 kWh (OS, 2017-2021)", 64)).toBe("Hyundai Kona Electric 64 kWh pack");
    expect(packLabel("BMW iX3 (G08) 80 kWh pack (73.83 kWh usable), 345 V 232 Ah, 2020-2024", 73.8)).toBe("BMW iX3 73.8 kWh pack");
    expect(packLabel("Audi Q5 hybrid quattro traction battery, VW-group number 8R0 915 591 (kWh not stated)", null)).toBeNull();
    const [group] = aggregate([row({ pack_key: "res:notes-1", pack_name: "Audi q5 fy phev 17 9kwh oem family candidate", make: "Audi", model: "Q5", capacity_kwh: 17.9 })]);
    expect(group.label).toBe("Audi Q5 17.9 kWh pack");
  });
});

describe("aggregateStock", () => {
  it("groups by spec and never exposes supplier identity", () => {
    const groups = aggregate(stock);
    expect(groups).toHaveLength(2);
    const id3 = groups.find((group) => group.make === "Volkswagen")!;
    expect(id3).toMatchObject({ units: 4, priceEurIncVatOnly: 1 });
    const peugeot = groups.find((group) => group.make === "Peugeot")!;
    expect(peugeot).toMatchObject({ units: 2, years: { min: 2021, max: 2022 } });
    const text = JSON.stringify(groups);
    for (const secret of ["Secret Breaker", "Other Dismantler", "co_a", "co_b", "p_a", "sto_1", "sto_4"]) expect(text).not.toContain(secret);
  });

  it("bands prices below three suppliers but always shows supplier count and countries", () => {
    const [few] = aggregate([row({ id: "a", price_eur_ex_vat: 4180 }), row({ id: "b", company_id: "co_b", price_eur_ex_vat: 4777 })]);
    expect(few).toMatchObject({ sources: 2, countries: ["Sweden"], synced: null, priceEurExVat: { min: 4000, median: null, max: 5000, priced: 2 } });
    const [crowd] = aggregate([row({ id: "a" }), row({ id: "b", company_id: "co_b", country: "Lithuania", price_eur_ex_vat: 3500 }),
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
    expect(aggregate([row({ make: "Hyundai", model: "Hyundai Ioniq 5" })])[0]).toMatchObject({ label: "Hyundai Ioniq 5 50 kWh pack", chemistry: "NMC" });
  });

  it("gives per-supplier units under scoped opaque tokens", () => {
    const rows = [row({ id: "a", company_id: "c1", quantity: 2 }), row({ id: "b", company_id: "c1", quantity: 1 }), row({ id: "c", company_id: "c2", person_id: "p_c", quantity: 1 })];
    const [group] = aggregateStock(rows, (id) => supplierToken(id, "conv-1234", "k".repeat(32)), lotKeys);
    expect(group.sources).toBe(2);
    expect(group.suppliers.map((entry) => entry.units)).toEqual([3, 1]);
    expect(group.suppliers[0].supplier).toMatch(/^S[0-9a-f]{6}$/);
    expect(JSON.stringify(group)).not.toMatch(/"c1"|"c2"|Secret Breaker/);
    expect(supplierToken("c1", "conv-1234", "k".repeat(32))).toBe(group.suppliers[0].supplier);
    expect(supplierToken("c1", "conv-9999", "k".repeat(32))).not.toBe(group.suppliers[0].supplier);
  });
});

describe("forgiving search", () => {
  const today = new Date("2026-10-27T12:00:00Z");
  const hit = (over: Partial<StockRow>, filters: Parameters<typeof matchesFilters>[1]) => matchesFilters(row(over), filters, today);

  it("folds case, accents, spaces and punctuation in model names", () => {
    expect(hit({ make: "VW", model: "ID.3" }, { model: "ID3" })).toBe(true);
    expect(hit({ make: "Tesla", model: "Model 3" }, { model: "Model3" })).toBe(true);
    expect(hit({ make: "Renault", model: "ZOE" }, { model: "Zoé" })).toBe(true);
    expect(hit({ make: "Kia", model: "e-Niro" }, { model: "Niro EV" })).toBe(true);
  });

  it("tolerates one typo in words but not in numbers", () => {
    expect(hit({ make: "Hyundai", model: "Ioniq 5" }, { model: "Ionic 5" })).toBe(true);
    expect(hit({ make: "Tesla", model: "Model S" }, { model: "Model3" })).toBe(false);
    expect(hit({ make: "Hyundai", model: "Ioniq 58 kWh" }, { model: "Ioniq 5" })).toBe(false);
    expect(hit({ make: "Peugeot", model: "e208" }, { model: "208" })).toBe(true);
  });

  it("expands platforms and groups", () => {
    expect(hit({ make: "Škoda", model: "Enyaq iV 80" }, { model: "MEB" })).toBe(true);
    expect(hit({ make: "Volkswagen", model: "Golf" }, { model: "MEB" })).toBe(false);
    expect(hit({ make: "Vauxhall", model: "Corsa-e" }, { make: "Stellantis" })).toBe(true);
    expect(hit({ make: "Renault", model: "Zoe" }, { make: "Stellantis" })).toBe(false);
  });

  it("normalises countries, powertrains and chemistries", () => {
    expect(normalCountry("Sariai, Lithuania")).toBe("Lithuania");
    expect(normalCountry("DE")).toBe("Germany");
    expect(normalCountry("uk")).toBe("United Kingdom");
    expect(hit({ country: "Sweden" }, { country: "DE" })).toBe(false);
    expect(hit({ country: "Germany" }, { country: "Deutschland" })).toBe(true);
    expect(normalPowertrain("plug-in hybrid")).toBe("PHEV");
    expect(normalPowertrain("Electric")).toBe("BEV");
    expect(hit({ powertrain: "Electric" }, { powertrain: "BEV" })).toBe(true);
    expect(chemistryFamilies("LiFePO4")).toEqual(["LFP"]);
    expect(chemistryFamilies("NMC | UNKNOWN")).toEqual(["NMC"]);
    expect(hit({ chemistry: "LFP" }, { chemistry: "LiFePO4" })).toBe(true);
    expect(hit({ chemistry: "NMC622" }, { chemistry: "LFP" })).toBe(false);
  });

  it("recognises cell and module lots and hides them unless asked", () => {
    expect(effectiveFormat({ make: "EVE", model: "INR18650 33V", format: null, quantity: 95647 })).toBe("cell");
    expect(effectiveFormat({ make: "LG Chem (renault)", model: "LG Renault ZOE 2P8S Module", format: null, quantity: 89000 })).toBe("module");
    expect(effectiveFormat({ make: "Kia", model: "Niro", format: null, quantity: 1 })).toBe("pack");
    expect(hit({ make: "EVE", model: "INR18650 33V", format: null, quantity: 95647 }, {})).toBe(false);
    expect(hit({ make: "EVE", model: "INR18650 33V", format: null, quantity: 95647 }, { format: "cell" })).toBe(true);
    expect(hit({ make: "LG Chem", model: "ZOE Module", format: "module", quantity: 500 }, { model: "Zoe" })).toBe(false);
  });

  it("widens kWh a little around a single value and uses graph kWh only when none is stated", () => {
    expect(hit({ capacity_kwh: 77.4 }, { kwhMin: 77, kwhMax: 77 })).toBe(true);
    expect(hit({ capacity_kwh: null, usable_kwh: 64.8, gross_kwh: 68 }, { kwhMin: 66, kwhMax: 70 })).toBe(true);
    expect(hit({ capacity_kwh: 72.6, gross_kwh: 77.4 }, { kwhMin: 75, kwhMax: 80 })).toBe(false);
  });

  it("falls back to the vehicles a pack fits only when the model text finds nothing", () => {
    const rows = [row({ id: "a", make: "Kia", model: "Soul EV", fits: "Kia Soul EV 2019-2023; Kia Niro EV" }), row({ id: "b", make: "Kia", model: "Niro" })];
    expect(searchRows(rows, { model: "Niro" }, today)).toMatchObject({ matchedOn: "model", rows: [{ id: "b" }] });
    expect(searchRows([rows[0]], { model: "Niro" }, today)).toMatchObject({ matchedOn: "fits", rows: [{ id: "a" }] });
  });

  it("suggests close names when nothing matches", () => {
    const rows = [row({ make: "Tesla", model: "Model Y" }), row({ make: "Hyundai", model: "Ioniq 5" })];
    expect(suggestModels(rows, { make: "Tesl" })).toEqual(["Tesla"]);
    expect(suggestModels(rows, { model: "Zorblax" })).toEqual([]);
  });
});

describe("grouping", () => {
  it("merges model spellings of the same pack and keeps different kWh apart", () => {
    const key = (model: string, kwh: number | null) => groupKeyFor(row({ make: "Kia", model, capacity_kwh: kwh, chemistry: null }));
    expect(key("Niro Mk2", 64.8)).toBe(key("Niro II", 64.8));
    expect(key("Niro SG2 Mk2", 64.8)).toBe(key("e-Niro", 64.8));
    expect(key("Niro (listed as Niro EV)", 64.8)).toBe(key("NIRO 2022-> pack", 64.8));
    expect(key("Niro", 64)).not.toBe(key("Niro", 64.8));
    expect(groupKeyFor(row({ chemistry: "NMC622" }))).toBe(groupKeyFor(row({ chemistry: "LFP" })));
  });

  it("cleans display models", () => {
    expect(cleanModel("VW", "VW ID.3 (E11, E12) Pro  107 kW  145 PS (11.2020-> )")).toBe("ID.3 Pro");
    expect(cleanModel("Hyundai", "IONIQ 5 (listed as Ioniq) 77.4 kWh battery")).toBe("IONIQ 5");
    expect(cleanModel("Mercedes", "MB C 205 2014-21")).toBe("C 205");
  });
});
