import { createHash, createHmac } from "node:crypto";

/**
 * Commercial-buyer stock (REB-577): dismantler stock from `crm_stock_opportunities`, aggregated into
 * supplier-free groups for Jules' commercial-buyer path. Read only: the platform never writes to the CRM. Nothing in a `StockGroup` may identify a supplier:
 * no names, CRM ids, supplier references, VINs or source URLs. Group keys are opaque hashes of the spec.
 *
 * Search is forgiving on purpose: buyers type "ID3", "Zoé", "plug-in hybrid", "DE" or "MEB". Text is folded (case,
 * accents, spaces, punctuation), countries, powertrains and chemistries go through synonym tables, platform and group
 * names expand to their models, and model words tolerate one typo. The battery graph's pack name and fitting vehicles
 * are a fallback only (searched when the model text finds nothing), because they are long and sometimes loose; its
 * usable and gross kWh count for kWh filters. Grouping folds model spellings ("Niro Mk2", "Niro II", "e-Niro") into
 * one family per make, kWh (rounded) and format; chemistry is shown, not grouped on.
 *
 * `scripts/rebattery/commercial_stock_eval.py` runs the live buyer-style cases; the investigator's
 * `commercial_stock_lines.py` mirrors groupKeyFor and must change with it.
 */

/** One live stock row as loaded for aggregation. Internal: holds the supplier, never sent to the platform. */
export type StockRow = {
  id: string;
  company_id: string | null;
  person_id: string;
  supplier: string | null;
  status: "opportunity" | "listed";
  make: string | null;
  model: string | null;
  format: string | null;
  capacity_kwh: number | null;
  chemistry: string | null;
  powertrain: string | null;
  year: number | null;
  country: string | null;
  quantity: number;
  price_eur_ex_vat: number | null;
  price_eur: number | null;
  seen_on: string | null;
  sync_class: string | null;
  /** Battery graph match (only when found): pack identity, official name, fitting vehicles and kWh. */
  pack_key?: string | null;
  pack_name?: string | null;
  fits?: string | null;
  usable_kwh?: number | null;
  gross_kwh?: number | null;
};

export type StockFilters = {
  make?: string;
  model?: string;
  format?: "pack" | "module" | "cell";
  chemistry?: string;
  powertrain?: string;
  country?: string;
  kwhMin?: number;
  kwhMax?: number;
  maxPriceEurExVat?: number;
  seenWithinDays?: number;
  limit?: number;
};

export type StockGroup = {
  groupKey: string;
  label: string;
  make: string;
  model: string | null;
  format: string | null;
  capacityKwh: number | null;
  /** Chemistry family (NMC, LFP, NCA, LMO, LTO, NiMH); several joined with " / "; null when unstated. */
  chemistry: string | null;
  powertrain: string | null;
  units: number;
  /** Distinct suppliers holding the group (a count only; Ari, 28 Oct 2026: buyers plan collection from it). */
  sources: number;
  /**
   * Units per supplier under an opaque token, largest first. Tokens are scoped to one conversation (see supplierToken),
   * so Jules can tell how many suppliers cover a selection across searches, but they never identify or link a supplier.
   */
  suppliers: { supplier: string; units: number }[];
  /** Countries the stock is held in (supplier country), always shown: buyers plan logistics from it (Ari, 28 Oct 2026). */
  countries: string[];
  years: { min: number; max: number } | null;
  /** With fewer than MIN_SOURCES only a band rounded to PRICE_BAND_EUR is shown and median is null. */
  priceEurExVat: { min: number; median: number | null; max: number; priced: number } | null;
  /** Rows priced only with VAT included or with unknown VAT. */
  priceEurIncVatOnly: number;
  lastSeen: string | null;
  /** Rows refreshed by a supplier sync or marketplace mirror; null when fewer than MIN_SOURCES. */
  synced: number | null;
};

/** Below this many suppliers a group shows only a rounded price band. */
export const MIN_SOURCES = 3;
export const PRICE_BAND_EUR = 500;

const clean = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim() || null;
const deaccent = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
/** Lowercase, no accents, letters and digits only: "ID.3" = "id3", "Zoé" = "zoe", "Model 3" = "model3". */
export const fold = (value: string | null | undefined) => deaccent(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const words = (value: string | null | undefined) => deaccent(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const MAKE_ALIASES: Record<string, string> = {
  vw: "Volkswagen", volkswagen: "Volkswagen", mercedes: "Mercedes-Benz", mercedesbenz: "Mercedes-Benz", mb: "Mercedes-Benz",
  citroen: "Citroën", skoda: "Škoda", bmw: "BMW", mg: "MG", byd: "BYD", ds: "DS", kia: "Kia", seat: "SEAT", cupra: "Cupra",
  alfa: "Alfa Romeo", alfaromeo: "Alfa Romeo", landrover: "Land Rover", rangerover: "Land Rover",
  opel: "Opel", vauxhall: "Vauxhall", nio: "NIO", gwm: "GWM", jac: "JAC", leapmotor: "Leapmotor", lynkco: "Lynk & Co",
};

/** Group and alliance names a buyer may use as a make. */
const MAKE_GROUPS: Record<string, string[]> = {
  stellantis: ["Peugeot", "Citroën", "Opel", "Vauxhall", "Fiat", "DS", "Jeep", "Alfa Romeo", "Lancia", "Abarth", "Chrysler", "Dodge", "Maserati", "Stellantis"],
  psa: ["Peugeot", "Citroën", "Opel", "Vauxhall", "DS"],
  vag: ["Volkswagen", "Audi", "Škoda", "SEAT", "Cupra", "Porsche"],
  vwgroup: ["Volkswagen", "Audi", "Škoda", "SEAT", "Cupra", "Porsche"],
  volkswagengroup: ["Volkswagen", "Audi", "Škoda", "SEAT", "Cupra", "Porsche"],
  hyundaigroup: ["Hyundai", "Kia", "Genesis"],
  hmg: ["Hyundai", "Kia", "Genesis"],
  renaultgroup: ["Renault", "Dacia", "Alpine"],
  geely: ["Volvo", "Polestar", "Geely", "Lynk & Co", "Smart", "Zeekr"],
  jaguarlandrover: ["Jaguar", "Land Rover"],
};

/** Shared EV platforms: a model search for the platform matches these make/model prefixes (folded). */
const ECMP: [string, string][] = [["Peugeot", "e208"], ["Peugeot", "208"], ["Peugeot", "e2008"], ["Peugeot", "2008"], ["Opel", "corsa"], ["Opel", "mokka"],
  ["Vauxhall", "corsa"], ["Vauxhall", "mokka"], ["DS", "3"], ["DS", "ds3"], ["Citroën", "ec4"], ["Citroën", "c4"], ["Fiat", "600"], ["Jeep", "avenger"]];
const EGMP: [string, string][] = [["Hyundai", "ioniq5"], ["Hyundai", "ioniq6"], ["Kia", "ev6"], ["Kia", "ev9"], ["Genesis", "gv60"]];
const PLATFORMS: Record<string, [string, string][]> = {
  meb: [["Volkswagen", "id3"], ["Volkswagen", "id4"], ["Volkswagen", "id5"], ["Volkswagen", "id7"], ["Volkswagen", "idbuzz"],
    ["Škoda", "enyaq"], ["Škoda", "elroq"], ["Cupra", "born"], ["Cupra", "tavascan"], ["Audi", "q4"]],
  egmp: EGMP,
  ecmp: ECMP, stla: ECMP, stlasmall: ECMP, cmp: ECMP, emp1: ECMP,
  emp2: [["Peugeot", "e308"], ["Peugeot", "308"], ["Peugeot", "3008"], ["Peugeot", "508"], ["Opel", "astra"], ["Vauxhall", "astra"], ["Citroën", "c5"], ["DS", "4"], ["DS", "7"]],
  stlamedium: [["Peugeot", "e3008"], ["Peugeot", "e5008"], ["Peugeot", "3008"], ["Peugeot", "5008"]],
  ppe: [["Audi", "q6"], ["Porsche", "macan"]],
  j1: [["Porsche", "taycan"], ["Audi", "etrongt"]],
  cmfev: [["Nissan", "ariya"], ["Renault", "megane"], ["Renault", "scenic"]],
};

const COUNTRY_NAMES: Record<string, string[]> = {
  "United Kingdom": ["uk", "gb", "gbr", "greatbritain", "britain", "england", "scotland", "wales", "northernireland", "unitedkingdom"],
  Germany: ["de", "deu", "germany", "deutschland"],
  Netherlands: ["nl", "nld", "holland", "netherlands", "thenetherlands", "nederland"],
  Lithuania: ["lt", "ltu", "lithuania", "lietuva"],
  Sweden: ["se", "swe", "sweden", "sverige"],
  Norway: ["no", "nor", "norway", "norge"],
  Belgium: ["be", "bel", "belgium", "belgie", "belgique"],
  France: ["fr", "fra", "france"],
  Spain: ["es", "esp", "spain", "espana"],
  Romania: ["ro", "rou", "romania"],
  Poland: ["pl", "pol", "poland", "polska"],
  "United States": ["us", "usa", "unitedstates", "unitedstatesofamerica", "america"],
  China: ["cn", "chn", "china"],
  Italy: ["it", "ita", "italy", "italia"],
  Denmark: ["dk", "dnk", "denmark", "danmark"],
  Finland: ["fi", "fin", "finland", "suomi"],
  Austria: ["at", "aut", "austria", "osterreich"],
  Switzerland: ["ch", "che", "switzerland", "schweiz", "suisse"],
  Portugal: ["pt", "prt", "portugal"],
  Ireland: ["ie", "irl", "ireland"],
  Latvia: ["lv", "lva", "latvia"],
  Estonia: ["ee", "est", "estonia"],
  Czechia: ["cz", "cze", "czechia", "czechrepublic"],
  Hungary: ["hu", "hun", "hungary"],
  Slovakia: ["sk", "svk", "slovakia"],
  Slovenia: ["si", "svn", "slovenia"],
  Croatia: ["hr", "hrv", "croatia"],
  Greece: ["gr", "grc", "greece"],
  Bulgaria: ["bg", "bgr", "bulgaria"],
  Turkey: ["tr", "tur", "turkey", "turkiye"],
  Ukraine: ["ua", "ukr", "ukraine"],
};
const COUNTRY_BY_ALIAS = new Map(Object.entries(COUNTRY_NAMES).flatMap(([name, aliases]) => aliases.map((alias) => [alias, name] as const)));

/** "Sariai, Lithuania", "LT" and "Lietuva" are all Lithuania; unknown values pass through tidied. */
export function normalCountry(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const last = clean(raw.split(",").at(-1)) ?? raw;
  return COUNTRY_BY_ALIAS.get(fold(last)) ?? COUNTRY_BY_ALIAS.get(fold(raw)) ?? last;
}

const POWERTRAINS: Record<string, string> = {
  bev: "BEV", ev: "BEV", electric: "BEV", batteryelectric: "BEV", fullelectric: "BEV", fullyelectric: "BEV", fullev: "BEV",
  phev: "PHEV", pluginhybrid: "PHEV", plugin: "PHEV", pluginhybridelectric: "PHEV", rechargeablehybrid: "PHEV",
  hev: "HEV", hybrid: "HEV", fullhybrid: "HEV", selfcharginghybrid: "HEV", hybridelectric: "HEV",
  mhev: "MHEV", mildhybrid: "MHEV", "48v": "MHEV", "48vmildhybrid": "MHEV",
  fcev: "FCEV", fuelcell: "FCEV", hydrogen: "FCEV", fuelcellelectric: "FCEV",
};
export function normalPowertrain(value: string | null | undefined): string | null {
  return POWERTRAINS[fold(value)] ?? null;
}

/** Chemistry families named in free text: "NMC622", "NCM", "LMO | NMC" = NMC; "LiFePO4" = LFP. */
export function chemistryFamilies(value: string | null | undefined): string[] {
  const text = fold(value);
  if (!text) return [];
  const families = new Set<string>();
  if (/lfp|lifepo|lithiumironphosphate|lithiumferrophosphate/.test(text)) families.add("LFP");
  if (/nmc|ncm|nickelmanganesecobalt/.test(text)) families.add("NMC");
  if (/nca|nickelcobaltalumin/.test(text)) families.add("NCA");
  if (/lto|titanate/.test(text)) families.add("LTO");
  if (/nimh|nickelmetalhydride/.test(text)) families.add("NiMH");
  if (/lmo|manganeseoxide/.test(text) && !families.has("NMC")) families.add("LMO");
  return [...families].sort();
}

export function normalMake(value: string | null | undefined): string | null {
  const make = clean(value);
  if (!make) return null;
  const alias = MAKE_ALIASES[fold(make)];
  if (alias) return alias;
  return make.split(" ").map((part) => (part.length <= 3 && part === part.toUpperCase()) ? part : part[0].toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

export function normalFormat(value: string | null | undefined): string | null {
  const format = clean(value)?.toLowerCase();
  return format === "pack" || format === "module" || format === "cell" ? format : null;
}

/** kWh to one decimal so 50 and 50.0 group together; implausible values are dropped. */
export function normalKwh(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 2000 ? Math.round(value * 10) / 10 : null;
}

const MODULE_MODEL = /\bmodules?\b/i;
const CELL_MODEL = /\b(18650|21700|26650|32700|4680|2170|pouch|prismatic|cylindrical|qilin|cells?|inr\s?\d+|ncr\s?\d+|icr\s?\d+)\b/i;
const CELL_MAKERS = new Set(["catl", "eve", "samsungsdi", "samsung", "lgchem", "lgenergysolution", "panasonic", "terrae", "molicel", "calb", "lishen", "svolt", "gotion", "sunwoda", "farasis", "envision", "aesc"]);

/** Cell and module manufacturers: their lots are components, shown only when the buyer asks for a format or names the maker. */
const COMPONENT_MAKERS = [...CELL_MAKERS, "skon", "sk", "lg", "lges", "northvolt", "microvast", "forsee", "dalian", "cbak", "kokam", "toshiba", "saft"];
export function isComponentMaker(make: string | null | undefined): boolean {
  const folded = fold(make);
  return COMPONENT_MAKERS.some((maker) => folded === maker || (maker.length >= 4 && folded.startsWith(maker)));
}

/** Stated format, else a cell lot recognised from the model text (18650, Qilin, pouch) or a cell maker's bulk lot, else a pack. */
export function effectiveFormat(row: Pick<StockRow, "make" | "model" | "format" | "quantity">): string {
  const stated = normalFormat(row.format);
  if (stated) return stated;
  if (CELL_MODEL.test(row.model ?? "")) return "cell";
  if (MODULE_MODEL.test(row.model ?? "")) return "module";
  const make = fold(row.make);
  if (row.quantity >= 100 && [...CELL_MAKERS].some((maker) => make.startsWith(maker))) return "cell";
  if (row.quantity >= 2000) return "cell";
  return "pack";
}

/** Model without a repeated make ("Hyundai Ioniq 5" under make Hyundai, "VW ID.3" under Volkswagen, both lose the prefix). */
export function normalModel(make: string | null | undefined, model: string | null | undefined): string | null {
  const value = clean(model);
  if (!value) return null;
  const lower = value.toLowerCase();
  const canonical = normalMake(make);
  const prefixes = [clean(make)?.toLowerCase(), canonical?.toLowerCase(),
    ...Object.entries(MAKE_ALIASES).filter(([, name]) => name === canonical).map(([alias]) => alias)]
    .filter((prefix): prefix is string => Boolean(prefix)).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (lower.startsWith(`${prefix} `)) return value.slice(prefix.length + 1).trim() || null;
  }
  return value;
}

/** Display model: no repeated make, bracketed notes, year ranges, power ratings, kWh or trailing "pack"/"battery". */
export function cleanModel(make: string | null | undefined, model: string | null | undefined): string | null {
  const value = normalModel(make, model);
  if (!value) return null;
  const stripped = value
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(19|20)\d{2}\s*(-|–|->|to)\s*((19|20)?\d{2}\b)?\s*(->)?/gi, " ")
    .replace(/\b(19|20)\d{2}\s*->/g, " ")
    .replace(/\b\d+\s*(kw|ps|hp|bhp)\b/gi, " ")
    .replace(/\b\d+(\.\d+)?\s*kwh\b/gi, " ")
    .replace(/\b(hv battery|high voltage|battery|batteries|pack)\b/gi, " ")
    .replace(/[\s,;/-]+$/, "");
  return normalModel(make, clean(stripped)) ?? value;
}

/** Words that name a generation or the electric variant, dropped when the kWh already pins the pack. */
const VARIANT_WORDS = new Set(["mk1", "mk2", "mk3", "mk4", "mki", "mkii", "mkiii", "i", "ii", "iii", "iv", "gen1", "gen2", "gen3", "sg2", "de",
  "ne", "ev", "e", "electric", "bev", "ultimate", "premium", "gtline", "awd", "rwd", "4wd", "lr", "sr", "facelift", "fl", "lci", "plus", "long", "range", "standard", "performance"]);

/** Grouping family from the row's own model text (graph pack names are too loose to group or label on). */
function modelFamily(row: StockRow, kwh: number | null): string {
  const source = cleanModel(row.make, row.model);
  if (!source) return "";
  if (kwh === null) return fold(source);
  const kept = words(source.replace(/\be-/gi, "e ")).filter((word) => !VARIANT_WORDS.has(word));
  return kept.join("") || fold(source);
}

/** kWh used to group and label: the stated figure, else the graph's usable kWh. */
function rowKwh(row: StockRow): number | null {
  return normalKwh(row.capacity_kwh) ?? normalKwh(row.usable_kwh ?? null);
}

function specKey(row: StockRow) {
  const kwh = rowKwh(row);
  return ["v2", normalMake(row.make), modelFamily(row, kwh), effectiveFormat(row), kwh === null ? null : Math.round(kwh)]
    .map((part) => part ?? "").join("|");
}

/** Opaque, stable key for a spec. It is a hash of the spec only, so it never encodes a supplier or a row id. */
export function groupKeyFor(row: StockRow): string {
  return `grp_${createHash("sha256").update(specKey(row)).digest("hex").slice(0, 16)}`;
}

/** Opaque supplier token, stable within one scope (a conversation) and unlinkable across scopes. */
export function supplierToken(supplierId: string, scope: string, secret: string): string {
  return `S${createHmac("sha256", secret).update(`${scope}\u0000${supplierId}`).digest("hex").slice(0, 6)}`;
}

function levenshtein(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** One typo for words of 4+ characters, two for 8+. */
const typoLimit = (word: string) => (word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0);
const QUERY_STOP_WORDS = new Set(["ev", "e", "electric", "bev", "battery", "pack", "the", "kwh"]);

/** Substring match that will not split a number: "ioniq5" is in "ioniq5pack" but not in "ioniq58kwh". */
function containsBounded(text: string, target: string): boolean {
  for (let index = text.indexOf(target); index !== -1; index = text.indexOf(target, index + 1)) {
    const before = text[index - 1] ?? "";
    const after = text[index + target.length] ?? "";
    if (!(/\d/.test(target[0]) && /\d/.test(before)) && !(/\d/.test(target.at(-1)!) && /\d/.test(after))) return true;
  }
  return false;
}

function textMatches(haystacks: (string | null | undefined)[], wanted: string): boolean {
  const folded = haystacks.map(fold).filter(Boolean);
  const target = fold(wanted);
  if (!target) return true;
  if (folded.some((text) => containsBounded(text, target))) return true;
  const tokens = words(wanted).filter((word) => !QUERY_STOP_WORDS.has(word));
  if (!tokens.length) return false;
  const rowWords = haystacks.flatMap((text) => words(text));
  return tokens.every((token) => {
    // Numbers and very short words must be a whole word ("5" is not the 5 in "58 kWh"); "208" also matches "e208".
    if (/^\d+$/.test(token) || token.length <= 2) {
      return rowWords.some((word) => word === token || (word.endsWith(token) && /^[a-z]{1,2}$/.test(word.slice(0, -token.length))));
    }
    return folded.some((text) => text.includes(token))
      || (typoLimit(token) > 0 && !/\d/.test(token) && rowWords.some((word) => levenshtein(token, word, 2) <= typoLimit(token)));
  });
}

function platformMatches(row: StockRow, wanted: string): boolean | null {
  const platform = PLATFORMS[fold(wanted)];
  if (!platform) return null;
  const make = normalMake(row.make);
  const model = fold(cleanModel(row.make, row.model));
  return platform.some(([platformMake, prefix]) => make === platformMake && model.startsWith(prefix));
}

function makeMatches(row: StockRow, wanted: string): boolean {
  const make = normalMake(row.make);
  const group = MAKE_GROUPS[fold(wanted)];
  if (group) return group.includes(make ?? "");
  return make === normalMake(wanted);
}

function daysOld(date: string | null, today: Date) {
  if (!date) return Infinity;
  return (today.getTime() - new Date(`${date.slice(0, 10)}T00:00:00Z`).getTime()) / 86_400_000;
}

/** kWh range; a single value or a range under 2 kWh wide gets ±5% so 77 finds 77.4. The stated kWh counts, else the graph's usable or gross kWh. */
function kwhMatches(row: StockRow, filters: StockFilters): boolean {
  if (filters.kwhMin === undefined && filters.kwhMax === undefined) return true;
  let min = filters.kwhMin ?? 0;
  let max = filters.kwhMax ?? Infinity;
  if (Number.isFinite(max) && max - min < 2) { min *= 0.95; max *= 1.05; }
  const stated = normalKwh(row.capacity_kwh);
  const values = (stated !== null ? [stated] : [row.usable_kwh, row.gross_kwh].map((value) => normalKwh(value ?? null)))
    .filter((value): value is number => value !== null);
  return values.some((value) => value >= min && value <= max);
}

/** Model text match on the row's own model; `graph` also searches the battery graph's pack name and fitting vehicles. */
export function modelMatches(row: StockRow, wanted: string, graph = false): boolean {
  const platform = platformMatches(row, wanted);
  if (platform !== null) return platform;
  return textMatches(graph ? [row.model, cleanModel(row.make, row.model), row.pack_name, row.fits] : [row.model, cleanModel(row.make, row.model)], wanted);
}

/** All filters; the model filter uses the row's model text unless `graph` widens it to the battery graph. */
export function matchesFilters(row: StockRow, filters: StockFilters, today = new Date(), graph = false): boolean {
  if (!normalMake(row.make)) return false;
  const format = effectiveFormat(row);
  if (filters.format ? format !== filters.format : format === "cell") return false;
  if (filters.make && !makeMatches(row, filters.make)) return false;
  if (!filters.make && !filters.format && isComponentMaker(row.make)) return false;
  if (filters.model && !modelMatches(row, filters.model, graph)) return false;
  if (filters.chemistry) {
    const wanted = chemistryFamilies(filters.chemistry);
    const have = chemistryFamilies(row.chemistry);
    if (wanted.length ? !wanted.some((family) => have.includes(family)) : !fold(row.chemistry).includes(fold(filters.chemistry))) return false;
  }
  if (filters.powertrain) {
    const wanted = normalPowertrain(filters.powertrain) ?? clean(filters.powertrain)?.toUpperCase();
    if (normalPowertrain(row.powertrain) !== wanted) return false;
  }
  if (filters.country && normalCountry(row.country) !== normalCountry(filters.country)) return false;
  if (!kwhMatches(row, filters)) return false;
  if (filters.maxPriceEurExVat !== undefined && (row.price_eur_ex_vat === null || row.price_eur_ex_vat > filters.maxPriceEurExVat)) return false;
  if (filters.seenWithinDays !== undefined && daysOld(row.seen_on, today) > filters.seenWithinDays) return false;
  return true;
}

/** Rows for a search: model text first; only when that finds nothing, the battery graph's pack names and fitting vehicles. */
export function searchRows(rows: StockRow[], filters: StockFilters, today = new Date()): { rows: StockRow[]; matchedOn: "model" | "fits" | null } {
  const direct = rows.filter((row) => matchesFilters(row, filters, today));
  if (direct.length || !filters.model) return { rows: direct, matchedOn: filters.model ? "model" : null };
  const widened = rows.filter((row) => matchesFilters(row, filters, today, true));
  return { rows: widened, matchedOn: widened.length ? "fits" : null };
}

/** How the search read the buyer's words, so Jules can say what it looked for. */
export function interpretFilters(filters: StockFilters) {
  const platform = filters.model ? PLATFORMS[fold(filters.model)] : undefined;
  const group = filters.make ? MAKE_GROUPS[fold(filters.make)] : undefined;
  return {
    ...(filters.make ? { makes: group ?? [normalMake(filters.make) ?? filters.make] } : {}),
    ...(platform ? { platformModels: [...new Set(platform.map(([make, model]) => `${make} ${model}`))] } : {}),
    ...(filters.country ? { country: normalCountry(filters.country) ?? filters.country } : {}),
    ...(filters.powertrain ? { powertrain: normalPowertrain(filters.powertrain) ?? filters.powertrain } : {}),
    ...(filters.chemistry ? { chemistry: chemistryFamilies(filters.chemistry).join(" / ") || filters.chemistry } : {}),
    format: filters.format ?? "pack or module",
  };
}

/** Up to five nearby make/model names when a search finds nothing ("Ioniqq" → "Hyundai Ioniq 5"); empty when nothing is close. */
export function suggestModels(rows: StockRow[], filters: StockFilters, limit = 5): string[] {
  const wanted = fold(filters.model ?? filters.make);
  if (!wanted) return [];
  const scored = new Map<string, number>();
  for (const row of rows) {
    if (effectiveFormat(row) === "cell" && filters.format !== "cell") continue;
    if (filters.make && filters.model && !makeMatches(row, filters.make)) continue;
    const make = normalMake(row.make);
    const model = cleanModel(row.make, row.model);
    if (!make) continue;
    const target = filters.model ? fold(model) : fold(make);
    if (!target) continue;
    const distance = Math.min(levenshtein(wanted, target.slice(0, wanted.length), 4), levenshtein(wanted, target, 4));
    if (distance > Math.max(1, Math.floor(wanted.length / 3))) continue;
    const name = filters.model ? `${make} ${model}` : make;
    scored.set(name, Math.min(scored.get(name) ?? Infinity, distance));
  }
  return [...scored].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name]) => name);
}

const round = (value: number) => Math.round(value);

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mostCommon<T>(values: (T | null | undefined)[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) if (value !== null && value !== undefined && value !== "") counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function labelFor(group: Pick<StockGroup, "make" | "model" | "capacityKwh" | "format">) {
  return [group.make, group.model ?? "(model not stated)", group.capacityKwh !== null ? `${group.capacityKwh} kWh` : null, group.format]
    .filter(Boolean).join(" ");
}

/** Supplier-free groups, most units first. */
export function aggregateStock(rows: StockRow[], tokenFor: (supplierId: string) => string = () => "S"): StockGroup[] {
  const groups = new Map<string, StockRow[]>();
  for (const row of rows) {
    if (!normalMake(row.make)) continue;
    const key = groupKeyFor(row);
    const members = groups.get(key);
    if (members) members.push(row); else groups.set(key, [row]);
  }
  const result: StockGroup[] = [];
  for (const [groupKey, members] of groups) {
    const exVat = members.map((row) => row.price_eur_ex_vat).filter((price): price is number => typeof price === "number" && price > 0);
    const years = members.map((row) => row.year).filter((year): year is number => typeof year === "number" && year > 1990);
    const seen = members.map((row) => row.seen_on).filter((date): date is string => Boolean(date)).sort();
    const group = {
      make: normalMake(members[0].make)!,
      model: mostCommon(members.map((row) => cleanModel(row.make, row.model))),
      format: effectiveFormat(members[0]),
      capacityKwh: mostCommon(members.map(rowKwh)),
    };
    const families = [...new Set(members.flatMap((row) => chemistryFamilies(row.chemistry)))].sort();
    const perSupplier = new Map<string, number>();
    for (const row of members) {
      const id = String(row.company_id ?? row.person_id);
      perSupplier.set(id, (perSupplier.get(id) ?? 0) + row.quantity);
    }
    const sources = perSupplier.size;
    const crowd = sources >= MIN_SOURCES;
    result.push({
      groupKey,
      label: labelFor(group),
      ...group,
      chemistry: families.length ? families.join(" / ") : null,
      powertrain: mostCommon(members.map((row) => normalPowertrain(row.powertrain))),
      units: members.reduce((sum, row) => sum + row.quantity, 0),
      sources,
      suppliers: [...perSupplier].map(([id, units]) => ({ supplier: tokenFor(id), units })).sort((a, b) => b.units - a.units || a.supplier.localeCompare(b.supplier)),
      countries: [...new Set(members.map((row) => normalCountry(row.country)).filter((country): country is string => Boolean(country)))].sort(),
      years: years.length ? { min: Math.min(...years), max: Math.max(...years) } : null,
      priceEurExVat: !exVat.length ? null : crowd
        ? { min: round(Math.min(...exVat)), median: round(median(exVat)), max: round(Math.max(...exVat)), priced: exVat.length }
        : { min: Math.max(PRICE_BAND_EUR, Math.floor(Math.min(...exVat) / PRICE_BAND_EUR) * PRICE_BAND_EUR),
          median: null, max: Math.ceil(Math.max(...exVat) / PRICE_BAND_EUR) * PRICE_BAND_EUR, priced: exVat.length },
      priceEurIncVatOnly: members.filter((row) => row.price_eur_ex_vat === null && row.price_eur !== null).length,
      lastSeen: seen.at(-1)?.slice(0, 10) ?? null,
      synced: crowd ? members.filter((row) => row.sync_class === "synced" || row.sync_class === "marketplace").length : null,
    });
  }
  return result.sort((a, b) => b.units - a.units || a.label.localeCompare(b.label));
}
