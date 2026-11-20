/**
 * Reviewed pack families: vehicles and OEM part numbers that share one physical pack.
 *
 * Used by the product key builder so a buyer asking for "Corsa-e 50 kWh" and a seller listing "e-208 pack"
 * land on the same key. Only add a family when the sharing is sourced; an unsure mapping is worse than a
 * broader key (the builder then stops at make + model + kWh). Every entry cites a checkable source.
 *
 * Capacity and vehicle evidence comes from the supply research scan of 8 Oct 2026:
 *   /root/.hermes/workspace/research/2026-10-08-ev-pack-model-pages/supply/model_supply_inventory.csv
 * (column `capacity_variants` and the trailing notes, one row per model family). Part numbers are cited to the
 * repo fixture that carries them. Regenerate the CSV before adding a family or a capacity.
 */

export type PackFamily = {
  /** Stable key segment: `pack:<id>`. */
  id: string;
  label: string;
  /** Vehicle makes that carry the pack, folded with normalMake (e.g. "Vauxhall"). */
  makes: string[];
  /** Folded model prefixes; "corsa" matches "Corsa-e", "Corsa Electric". */
  modelPrefixes: string[];
  /** Stated capacities that mean this pack, gross or usable (64 and 64.8 are the same Niro pack). */
  kwh: number[];
  chemistry: string | null;
  /** OEM part numbers, compared with partKey (letters O and digit 0 are one character). */
  partNumbers: string[];
  source: string;
};

/** The checkable supply scan every capacity claim below is read from. */
const SUPPLY_SCAN = "/root/.hermes/workspace/research/2026-10-08-ev-pack-model-pages/supply/model_supply_inventory.csv";

export const PACK_FAMILIES: PackFamily[] = [
  {
    id: "stellantis-ecmp-50kwh",
    label: "Stellantis e-CMP 50 kWh",
    makes: ["Vauxhall", "Peugeot", "Opel", "DS", "Citroen"],
    modelPrefixes: ["corsa", "e208", "e2008", "mokka", "ds3", "ec4"],
    kwh: [50, 51, 54],
    chemistry: "NMC",
    partNumbers: [],
    source: `${SUPPLY_SCAN}, rows "Vauxhall Corsa-e", "Peugeot e-208", "Vauxhall Mokka-e": stock at 50/51/54 kWh, note "Stellantis e-CMP 50/54 kWh shared with e-208/e-2008/Mokka-e/e-C4/DS3".`,
  },
  {
    id: "kia-niro-64kwh",
    label: "Kia Niro / e-Niro 64 kWh",
    makes: ["Kia"],
    modelPrefixes: ["niro", "eniro"],
    kwh: [64, 64.8, 67.5],
    chemistry: "NMC",
    partNumbers: ["37501-AO050", "37501-Q4052", "37501-Q4151"],
    source: `${SUPPLY_SCAN}, row "Kia Niro EV (e-Niro)": eBay 64 kWh, stock 64.8/67.5 kWh; part numbers and capacities in apps/web/lib/commercial-stock.test.ts (37501-AO050, 37501-Q4052, 37501-Q4151).`,
  },
  {
    id: "nissan-leaf-40kwh",
    label: "Nissan Leaf 40 kWh",
    makes: ["Nissan"],
    modelPrefixes: ["leaf"],
    kwh: [39, 40],
    chemistry: "NMC",
    partNumbers: [],
    source: `${SUPPLY_SCAN}, row "Nissan Leaf": note "24/30/40/62 kWh generations"; 39 kWh stated and 40 kWh nominal are the ZE1 40 kWh pack (62 kWh is the e+ pack and is not this family).`,
  },
  {
    id: "hyundai-kia-egmp-77kwh",
    label: "Hyundai/Kia E-GMP 77 kWh",
    makes: ["Hyundai", "Kia", "Hyundai or Kia"],
    modelPrefixes: ["ioniq5", "ioniq6", "ev6"],
    kwh: [73, 77, 77.4],
    chemistry: "NMC",
    partNumbers: [],
    source: `${SUPPLY_SCAN}, rows "Hyundai Ioniq 5" (stock 73.0/77.4 kWh) and "Kia EV6" (77.4 kWh, note "E-GMP shared with Ioniq 5"). The EV9 is not in this family: the same scan lists its stock at 76.1 and 99.8 kWh, a different pack.`,
  },
  {
    id: "vw-meb-77kwh",
    label: "VW MEB 77 kWh",
    makes: ["VW Group", "Volkswagen", "Audi", "Skoda", "Cupra"],
    modelPrefixes: ["id3", "id4", "id5", "id7", "q4etron", "enyaq", "born"],
    kwh: [77, 82],
    chemistry: "NMC",
    partNumbers: [],
    source: `${SUPPLY_SCAN}, row "VW ID.3": note "MEB pack shared with ID.4/ID.5/Enyaq/Born", stock at 77 kWh usable / 82 kWh gross.`,
  },
  {
    id: "bmw-i3-42kwh",
    label: "BMW i3 42 kWh",
    makes: ["BMW"],
    modelPrefixes: ["i3"],
    kwh: [42, 42.2],
    chemistry: "NMC",
    partNumbers: [],
    source: `${SUPPLY_SCAN}, row "BMW i3": note "22/33/42 kWh (60/94/120 Ah)", stock at 42.2 kWh; 22 and 33 kWh are earlier generations and are not this family.`,
  },
  {
    id: "renault-zoe-52kwh",
    label: "Renault Zoe 52 kWh",
    makes: ["Renault"],
    modelPrefixes: ["zoe"],
    kwh: [52],
    chemistry: "NMC",
    partNumbers: [],
    source: `${SUPPLY_SCAN}, row "Renault Zoe": note "22/41/52 kWh"; 52 kWh is the ZE50 pack, 41 kWh the earlier R90 pack, so only 52 is in this family.`,
  },
  {
    id: "jaguar-ipace-90kwh",
    label: "Jaguar I-Pace 90 kWh",
    makes: ["JLR", "Jaguar", "Land Rover"],
    modelPrefixes: ["ipace"],
    kwh: [90],
    chemistry: "NMC",
    partNumbers: [],
    source: `${SUPPLY_SCAN}, row "Jaguar I-Pace": note "Single 90 kWh pack"; every stock listing states 90 kWh.`,
  },
  {
    id: "mercedes-eqc-80kwh",
    label: "Mercedes EQC 80 kWh",
    makes: ["Mercedes-Benz", "Mercedes", "Mercedes-Benz Group"],
    modelPrefixes: ["eqc"],
    kwh: [80],
    chemistry: "NMC",
    partNumbers: [],
    source: `${SUPPLY_SCAN}, row "Mercedes EQC": note "Single 80 kWh pack - clean page"; every stock listing states 80 kWh.`,
  },
];
