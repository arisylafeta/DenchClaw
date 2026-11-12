/**
 * Reviewed pack families: vehicles and OEM part numbers that share one physical pack.
 *
 * Used by the product key builder so a buyer asking for "Corsa-e 50 kWh" and a seller listing "e-208 pack"
 * land on the same key. Only add a family when the sharing is sourced; an unsure mapping is worse than a
 * broader key (the builder then stops at make + model + kWh).
 *
 * Reviewed against the live stock families in workspace/research/2026-10-08-ev-pack-model-pages/supply/
 * (model_supply_inventory.csv): the families below cover the largest groups in today's stock.
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

export const PACK_FAMILIES: PackFamily[] = [
  {
    id: "stellantis-ecmp-50kwh",
    label: "Stellantis e-CMP 50 kWh",
    makes: ["Vauxhall", "Peugeot", "Opel", "DS", "Citroen"],
    modelPrefixes: ["corsa", "e208", "e2008", "mokka", "ds3", "ec4"],
    kwh: [50, 51, 54],
    chemistry: "NMC",
    partNumbers: [],
    source: "Stellantis e-CMP: Corsa-e, e-208, e-2008, Mokka-e, DS 3 Crossback E-Tense and e-C4 share the 50/54 kWh pack (manufacturer specifications; stock research CSV note).",
  },
  {
    id: "kia-niro-64kwh",
    label: "Kia Niro / e-Niro 64 kWh",
    makes: ["Kia"],
    modelPrefixes: ["niro", "eniro"],
    kwh: [64, 64.8, 67.5, 68],
    chemistry: "NMC",
    partNumbers: ["37501-AO050", "37501-Q4052", "37501-Q4151"],
    source: "Kia Niro EV 64 kWh: 37501-AO050 and 37501-Q4052/Q4151 packs observed on ReBattery stock fixtures (apps/web/lib/commercial-stock.test.ts); 67.5/68 kWh is the gross figure for the same 64 kWh usable pack.",
  },
  {
    id: "tesla-model3y-75kwh",
    label: "Tesla Model 3 / Model Y 75 kWh",
    makes: ["Tesla"],
    modelPrefixes: ["model3", "modely"],
    kwh: [75, 78, 78.1, 78.8, 82],
    chemistry: "NMC",
    partNumbers: [],
    source: "Tesla Model 3/Y long-range 75 kWh pack (78/78.8/82 kWh gross variants in stock research CSV).",
  },
  {
    id: "nissan-leaf-40kwh",
    label: "Nissan Leaf 40 kWh",
    makes: ["Nissan"],
    modelPrefixes: ["leaf"],
    kwh: [39, 40],
    chemistry: "NMC",
    partNumbers: [],
    source: "Nissan Leaf ZE1 40 kWh pack (Leaf generations 24/30/40/62 kWh per stock research CSV).",
  },
  {
    id: "hyundai-kia-egmp-77kwh",
    label: "Hyundai/Kia E-GMP 77 kWh",
    makes: ["Hyundai", "Kia", "Hyundai or Kia"],
    modelPrefixes: ["ioniq5", "ioniq6", "ev6", "ev9"],
    kwh: [73, 74, 77, 77.4],
    chemistry: "NMC",
    partNumbers: [],
    source: "Hyundai Ioniq 5 / Kia EV6 E-GMP 77.4 kWh pack (73/77.4 kWh stated capacities in stock research CSV).",
  },
  {
    id: "vw-meb-77kwh",
    label: "VW MEB 77 kWh",
    makes: ["VW Group", "Volkswagen", "Audi", "Skoda", "Cupra"],
    modelPrefixes: ["id3", "id4", "id5", "id7", "q4etron", "enyaq", "born"],
    kwh: [77, 82],
    chemistry: "NMC",
    partNumbers: [],
    source: "VW MEB large pack 77 kWh (82 kWh gross): ID.3/ID.4/ID.5, Q4 e-tron, Enyaq, Cupra Born (stock research CSV).",
  },
  {
    id: "bmw-i3-42kwh",
    label: "BMW i3 42 kWh",
    makes: ["BMW"],
    modelPrefixes: ["i3"],
    kwh: [42, 42.2],
    chemistry: "NMC",
    partNumbers: [],
    source: "BMW i3 94 Ah / 120 Ah 42.2 kWh pack (22/33/42 kWh generations per stock research CSV).",
  },
  {
    id: "renault-zoe-52kwh",
    label: "Renault Zoe 52 kWh",
    makes: ["Renault"],
    modelPrefixes: ["zoe"],
    kwh: [52, 52.0, 41],
    chemistry: "NMC",
    partNumbers: [],
    source: "Renault Zoe ZE50 52 kWh pack (22/41/52 kWh generations per stock research CSV).",
  },
  {
    id: "jaguar-ipace-90kwh",
    label: "Jaguar I-Pace 90 kWh",
    makes: ["JLR", "Jaguar", "Land Rover"],
    modelPrefixes: ["ipace"],
    kwh: [90],
    chemistry: "NMC",
    partNumbers: [],
    source: "Jaguar I-Pace 90 kWh pack (stock research CSV: 90 kWh in every I-Pace listing).",
  },
  {
    id: "mercedes-eqc-80kwh",
    label: "Mercedes EQC 80 kWh",
    makes: ["Mercedes-Benz", "Mercedes", "Mercedes-Benz Group"],
    modelPrefixes: ["eqc"],
    kwh: [80],
    chemistry: "NMC",
    partNumbers: [],
    source: "Mercedes-Benz EQC 80 kWh pack (stock research CSV: 80 kWh in every EQC listing).",
  },
];
