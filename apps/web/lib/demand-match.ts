// Scores our own inventory (marketplace listings, live trades and supply) against one demand
// row, so the Suitable supply tab can answer "do we have it, at a price that leaves a deal?" at a glance.
// Pure and deterministic: no model calls. The inbox check's AI matches for trades and supply feed in as evidence.
import type { Demand } from "./bulk-demand";

export type SourceKind = "marketplace" | "trade" | "supply";
export type Format = "Packs" | "Modules" | "Cells" | "Systems";

/** One unit of supply in a shape every source can fill. Price is per unit, in `currency`. */
export type Candidate = {
  key: string;
  source: SourceKind;
  title: string;
  seller: string | null;
  make: string | null;
  model: string | null;
  format: Format | null;
  chemistry: string | null;
  cellFormat: string | null;
  kwh: number | null;
  /** True when kWh was borrowed from marketplace listings of the same make and model, not stated for this row. */
  kwhEstimated: boolean;
  units: number | null;
  price: number | null;
  currency: string | null;
  /** True when the currency was inferred from the seller's country rather than stated. */
  currencyAssumed: boolean;
  country: string | null;
  location: string | null;
  soh: number | null;
  year: number | null;
  partNumber: string | null;
  photos: number;
  tested: boolean;
  verified: boolean;
  seen: string | null;
  href: string;
  /** For trades and supply: the inbox check's judgement of this pair, when it made one. */
  ai: { strength: "strong" | "partial"; reason: string } | null;
  /** Other sources that hold the same unit. */
  alsoIn: SourceKind[];
};

export type CheckState = "pass" | "partial" | "unknown" | "fail";
export type Check = { key: CheckKey; label: string; state: CheckState; detail: string };
export type CheckKey = "product" | "capacity" | "chemistry" | "format" | "quantity" | "price";

export type Economics = {
  /** Seller price in EUR per kWh, when price and kWh are known. */
  sellerEurPerKwh: number | null;
  sellerEurPerUnit: number | null;
  buyerEurPerKwh: number | null;
  buyerEurPerUnit: number | null;
  /** (buyer - seller) / buyer, when both sides are known. */
  marginPct: number | null;
  /** Spread in EUR over the units this candidate can cover. */
  spreadEur: number | null;
  /** Where this unit's EUR/kWh sits among comparable units (same group), 0 = cheapest. */
  cheapestRank: number | null;
  peers: number;
};

export type Match = {
  candidate: Candidate;
  /** Exact: everything the buyer specified is confirmed. Check: it fits, but something is unknown or estimated. */
  verdict: "exact" | "check";
  checks: Check[];
  economics: Economics;
  /** Grouping key: same product and capacity across sellers, so bulk asks see total units. */
  group: string;
};

export type MatchGroup = {
  key: string;
  label: string;
  verdict: Match["verdict"];
  units: number;
  sellers: string[];
  sources: SourceKind[];
  eurPerKwh: { min: number; max: number } | null;
  bestMarginPct: number | null;
  /** Units the group can cover against the ask, when the ask has a unit count. */
  covers: { have: number; need: number } | null;
  /** Under 1% of a bulk ask (50+ units): too small to matter, hidden unless asked for. */
  small: boolean;
  matches: Match[];
};

export type MatchResult = {
  requirement: Requirement;
  groups: MatchGroup[];
  considered: number;
  /** Why nothing could be matched, when the ask is too vague to score. */
  blocked: string | null;
  /** Rough FX used to compare prices across currencies. */
  fxNote: string;
};

/** Approximate EUR value of one unit of each currency. Prices are compared, never quoted, with these. */
export const EUR_PER: Record<string, number> = {
  EUR: 1, GBP: 1.16, USD: 0.86, NOK: 0.085, SEK: 0.088, DKK: 0.134, PLN: 0.235, CHF: 1.07, CZK: 0.04,
};
export const FX_NOTE = "Approximate FX (1 GBP ≈ €1.16, 1 USD ≈ €0.86, 1 NOK ≈ €0.085, 1 SEK ≈ €0.088)";

export const toEur = (amount: number | null, currency: string | null) =>
  amount == null || !currency || !(currency.toUpperCase() in EUR_PER) ? null : amount * EUR_PER[currency.toUpperCase()];

// Buy-box makes as the words a seller writes in make or model.
const MAKE_WORDS: Record<string, string[]> = {
  Tesla: ["tesla"],
  "VW Group": ["volkswagen", "vw", "skoda", "audi", "seat", "cupra", "porsche"],
  Renault: ["renault", "dacia"],
  Nissan: ["nissan"],
  "Hyundai or Kia": ["hyundai", "kia"],
  "BMW or Mini": ["bmw", "mini"],
  "Mercedes-Benz": ["mercedes", "mercedes-benz", "smart"],
  Stellantis: ["peugeot", "citroen", "citroën", "opel", "vauxhall", "fiat", "jeep", "ds", "alfa"],
  Ford: ["ford"],
  GM: ["chevrolet", "cadillac", "gmc", "buick"],
  BYD: ["byd"],
  "MG or SAIC": ["mg", "maxus", "saic"],
  "Volvo or Polestar": ["volvo", "polestar"],
  JLR: ["jaguar", "land", "range"],
  "Toyota or Lexus": ["toyota", "lexus"],
};
// Cell and module makers count as makes too ("LG Chem modules", "CATL cells").
const CELL_MAKERS = ["lg", "samsung", "catl", "panasonic", "eve", "svolt", "lishen", "calb", "gotion", "sk", "farasis", "envision", "aesc", "cbak", "terrae"];
const MAKE_WORDS_FLAT = new Set([...Object.values(MAKE_WORDS).flat(), ...CELL_MAKERS]);
const ALL_MAKE_WORDS = new Set([...MAKE_WORDS_FLAT, "stellantis", "group", "chem", "sdi", "energy", "solution"]);

// Platform names buyers use, as the models a seller lists. Each alias expands to any of its models.
// `not` drops a model that shares the word ("Proace City" is a K9 van, not the K0 Proace); `kwh` is what the platform
// name itself implies when the ask gives no capacity.
type Platform = { models: string[]; not?: string[]; kwh?: number[] };
const K9 = ["berlingo", "combo", "partner", "rifter", "doblo", "proace city"];
const PLATFORMS: Record<string, Platform> = {
  meb: { models: ["id.3", "id3", "id.4", "id4", "id.5", "id5", "id. buzz", "buzz", "enyaq", "born", "q4", "elroq"] },
  "e-k9": { models: K9 },
  k9: { models: K9 },
  "e-cmp": { models: ["208", "2008", "corsa", "mokka", "ds3", "c4", "500x"] },
  "stla-m": { models: ["3008", "5008", "grandland"] },
  stla: { models: ["3008", "308", "408", "5008", "c5", "ds7", "ds4", "grandland", "astra", "compass", "renegade"] },
  proace: { models: ["proace", "jumpy", "expert", "vivaro", "dispatch", "spacetourer", "traveller"], not: ["city"] },
  ze1: { models: ["leaf"], kwh: [40, 62] },
};

// Words that describe any battery and say nothing about which product is wanted.
const GENERIC = new Set(`pack packs battery batteries module modules cell cells kwh kw ev evs hv high voltage complete
  reusable operational used new second life second-life tested untested for and or the a an of with from to top priority
  pri phase gen generation model models van vans car cars passenger traction bess container pilot storage stationary
  energy home commercial residential grid units unit approx approximately around about only but plus mixed etc
  lithium li-ion ion lfp nmc nca lmo lto lifepo4 chemistry prismatic cylindrical pouch equivalent or similar
  initial test next week then if successful highest confirmed oct sep sourcing matrix the those these brand branded
  more than any all many makers maker various plug-in plugin hybrid hybrids phev bev group`.split(/\s+/).filter(Boolean));

export type Requirement = {
  formats: Format[];
  chemistries: string[];
  cellFormats: string[];
  makeWords: string[];
  /** Product phrases from the ask ("kona", "ioniq 5", "zoe"), each expanded with platform aliases. */
  products: { phrase: string; anyOf: string[]; not: string[] }[];
  kwh: { min: number; max: number } | { options: number[] } | null;
  unitsNeeded: number | null;
  kwhNeeded: number | null;
  buyerEurPerKwh: number | null;
  buyerEurPerUnit: number | null;
  country: string | null;
  minSoh: number | null;
  wantsNew: boolean;
  /** Traction packs for reuse: containerised and stationary systems are a different product. */
  evOnly: boolean;
  cellTokens: string[];
  /** Human summary of what the ask pins down, for the "What they want" card. */
  pinned: string[];
};

const norm = (text: string) =>
  ` ${text.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9.\-/ ]+/g, " ").replace(/\.(?![a-z0-9])|(?<![a-z0-9])\./g, " ")
    .replace(/\s+/g, " ").trim()} `;

/** kWh figures in free text: "60–80 kWh" is a range, "55, 62 and 82 kWh" and "81.6/105 kWh" are options. */
export function kwhFromText(text: string): Requirement["kwh"] {
  const t = text.toLowerCase().replace(/,(\d)/g, ".$1");
  const plus = t.match(/(\d+(?:\.\d+)?)\s*kwh\s*\+|(?:over|above|at least|min(?:imum)?)\s*(\d+(?:\.\d+)?)\s*kwh/);
  if (plus) return { min: Number(plus[1] ?? plus[2]), max: 10_000 };
  const range = t.match(/(\d+(?:\.\d+)?)\s*(?:–|-|to)\s*(\d+(?:\.\d+)?)\s*kwh/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const list = t.match(/((?:\d+(?:\.\d+)?\s*(?:\/|,|and|or)\s*)*\d+(?:\.\d+)?)\s*kwh/);
  if (!list) return null;
  const options = list[1].split(/\/|,|and|or/).map((n) => Number(n.trim())).filter((n) => n > 0.5 && n < 5000);
  return options.length ? { options } : null;
}

function unitCount(demand: Demand): number | null {
  const unit = demand.volume_unit?.toLowerCase();
  if (demand.volume && unit && /pack|cell|module|system|unit/.test(unit)) return demand.volume;
  const m = demand.quantity?.replace(/,(\d{3})/g, "$1").match(/(\d+(?:\.\d+)?)\s*(packs?|cells?|modules?|units?|systems?)/i);
  if (m) return Number(m[1]);
  // "1 test pack, then 10 packs": the larger number is the deal.
  const all = [...(demand.quantity ?? "").matchAll(/(\d+)\s*(?:packs?|units?)/gi)].map((x) => Number(x[1]));
  if (all.length) return Math.max(...all);
  const lead = demand.wants.match(/^(?:approximately\s+|about\s+)?(\d+)\s+(?!kwh)/i);
  return lead ? Number(lead[1]) : null;
}

function kwhCount(demand: Demand): number | null {
  const unit = demand.volume_unit?.toLowerCase();
  if (!demand.volume || !unit) return null;
  return unit === "kwh" ? demand.volume : unit === "mwh" ? demand.volume * 1000 : null;
}

const COUNTRY_WORDS: [RegExp, string][] = [
  [/\b(uk|united kingdom|england|scotland|wales|gb)\b/i, "GB"], [/\b(germany|deutschland|de)\b/i, "DE"],
  [/\b(france|fr)\b/i, "FR"], [/\b(italy|italia|it)\b/i, "IT"], [/\b(poland|polska|pl)\b/i, "PL"],
  [/\b(netherlands|holland|nl)\b/i, "NL"], [/\b(belgium|be)\b/i, "BE"], [/\b(spain|es)\b/i, "ES"],
  [/\b(norway|no)\b/i, "NO"], [/\b(sweden|se)\b/i, "SE"], [/\b(greece|gr)\b/i, "GR"], [/\b(ukraine|ua)\b/i, "UA"],
  [/\b(lithuania|lt)\b/i, "LT"], [/\b(india|in)\b/i, "IN"], [/\b(uganda)\b/i, "UG"], [/\b(usa|united states|us)\b/i, "US"],
  [/\b(finland|fi)\b/i, "FI"], [/\b(slovenia|si)\b/i, "SI"], [/\b(macedonia)\b/i, "MK"], [/\b(china)\b/i, "CN"],
];
export function countryFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const [re, code] of COUNTRY_WORDS) if (re.test(text)) return code;
  return null;
}


/** Reads what a demand row actually pins down: the structured spec first, then its words. A word only counts as a
 * product when some seller uses it in a make or model (`vocab`), so "homogeneous lots" never becomes a product. */
export function requirementFor(demand: Demand, vocab?: Set<string>): Requirement {
  const spec = demand.spec ?? {};
  const parts = [demand.product_family ?? "", demand.wants].filter(Boolean);
  const text = parts.join(" ; ");
  const t = norm(text);
  const makeWords = (spec.makes ?? []).flatMap((make) => MAKE_WORDS[make] ?? [make.toLowerCase()]);
  // A make named in the words counts even without a structured make ("Hyundai Kona").
  for (const word of MAKE_WORDS_FLAT) if (t.includes(` ${word} `) && !makeWords.includes(word)) makeWords.push(word);
  const products: Requirement["products"] = [];
  let platformKwh: number[] | undefined;
  for (const [alias, platform] of Object.entries(PLATFORMS)) {
    if (!t.includes(` ${alias} `) && !t.includes(` ${alias.replace("-", " ")} `)) continue;
    if (alias === "stla" && t.includes(" stla-m ")) continue;
    if (alias === "k9" && t.includes(" e-k9 ")) continue;
    products.push({ phrase: alias.toUpperCase(), anyOf: platform.models, not: platform.not ?? [] });
    platformKwh ??= platform.kwh;
  }
  for (const part of parts) {
    const tokens = norm(part).trim().split(" ");
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i];
      if (!word || GENERIC.has(word) || ALL_MAKE_WORDS.has(word) || word in PLATFORMS || /^e-(k9|cmp)$/.test(word)) continue;
      if (/^\d+(\.\d+)?(kwh|ah|v)?$/.test(word) || word.length < 2) continue;
      if (vocab && !vocab.has(word)) continue;
      const next = tokens[i + 1];
      // "Ioniq 5", "Model 3": a one- or two-digit number after a model word belongs to it, unless it is a kWh figure.
      const phrase = next && /^\d{1,2}$/.test(next) && tokens[i + 2] !== "kwh" ? `${word} ${next}` : word;
      if (!products.some((p) => p.phrase === phrase || p.anyOf.includes(word))) products.push({ phrase, anyOf: [phrase], not: [] });
    }
  }
  const cellTokens = [...new Set([...t.matchAll(/(?<![0-9])(18650|21700|26650|32700|4680|2170)(?![0-9])| (\d{2}e) /g)]
    .map((m) => (m[1] === "2170" ? "21700" : m[1] ?? m[2])))];
  const kwh = spec.kwh_min != null || spec.kwh_max != null
    ? { min: spec.kwh_min ?? 0, max: spec.kwh_max ?? 10_000 }
    : kwhFromText(text) ?? (platformKwh ? { options: platformKwh } : null);
  const currency = demand.price_currency ?? "EUR";
  const unit = demand.price_unit?.toLowerCase() ?? "";
  const maxEur = toEur(demand.max_price, currency);
  const buyerEurPerKwh = maxEur != null && unit === "kwh" ? maxEur : maxEur != null && unit === "mwh" ? maxEur / 1000 : null;
  const buyerEurPerUnit = maxEur != null && buyerEurPerKwh == null && unit ? maxEur : null;
  const formats = [...(spec.formats ?? [])] as Format[];
  if (!formats.length) {
    if (/\bcells?\b|18650|21700/.test(t)) formats.push("Cells");
    if (/\bmodules?\b/.test(t)) formats.push("Modules");
    if (/\bpacks?\b/.test(t)) formats.push("Packs");
  }
  const chemistries = [...(spec.chemistries ?? [])];
  if (!chemistries.length) {
    if (/ (lfp|lifepo4) /.test(t)) chemistries.push("LFP");
    if (/ nmc /.test(t)) chemistries.push("NMC");
  }
  const req: Requirement = {
    formats,
    chemistries,
    cellFormats: spec.cell_formats ?? [],
    makeWords,
    products: cellTokens.length ? [] : products,
    kwh,
    unitsNeeded: unitCount(demand),
    kwhNeeded: kwhCount(demand),
    buyerEurPerKwh,
    buyerEurPerUnit,
    country: countryFromText(demand.location),
    minSoh: spec.min_soh ?? null,
    evOnly: (spec.origins ?? []).some((o) => o === "Passenger EV" || o === "Bus or truck") || / (ev|traction|traction-battery|vehicle) /.test(t),
    wantsNew: (spec.conditions ?? []).length > 0 && (spec.conditions ?? []).every((c) => c === "New or surplus"),
    cellTokens,
    pinned: [],
  };
  req.pinned = [
    req.products.length ? req.products.map((p) => p.phrase.replace(/\b\w/g, (c) => c.toUpperCase())).join(" / ") : null,
    req.kwh ? ("options" in req.kwh ? `${req.kwh.options.join(" / ")} kWh` : req.kwh.max >= 10_000 ? `${req.kwh.min}+ kWh`
      : req.kwh.min === req.kwh.max ? `${req.kwh.min} kWh` : `${req.kwh.min}–${req.kwh.max} kWh`) : null,
    req.chemistries.length ? req.chemistries.join(" / ") : null,
    req.formats.length ? req.formats.join(" / ") : null,
    req.cellTokens.length ? req.cellTokens.join(" / ") : null,
  ].filter((x): x is string => !!x);
  return req;
}

const candidateText = (c: Candidate) => norm(`${c.make ?? ""} ${c.model ?? ""} ${c.title} ${c.partNumber ?? ""}`);

function kwhFits(req: Requirement, kwh: number): CheckState {
  if (!req.kwh) return "unknown";
  if ("options" in req.kwh) {
    const best = Math.min(...req.kwh.options.map((o) => Math.abs(kwh - o) / o));
    return best <= 0.07 ? "pass" : best <= 0.15 ? "partial" : "fail";
  }
  if (kwh >= req.kwh.min && kwh <= req.kwh.max) return "pass";
  const off = kwh < req.kwh.min ? (req.kwh.min - kwh) / req.kwh.min : (kwh - req.kwh.max) / req.kwh.max;
  return off <= 0.1 ? "partial" : "fail";
}

const kwhLabel = (kwh: number) => `${Math.round(kwh * 10) / 10} kWh`;
const PRODUCT_CHECKS = new Set<CheckKey>(["product", "capacity", "chemistry", "format"]);

// Energy a cylindrical cell of each size can hold, in Wh. A "21700" listing at 340 Wh is a mislabelled prismatic.
const CELL_WH: Record<string, [number, number]> = { "18650": [5, 13], "21700": [9, 26], "26650": [8, 22], "32700": [12, 25], "4680": [70, 110] };
/** The cylindrical size a name states anywhere ("INR18650-26E", "26650FS3", "Panasonic 2170"), if any. */
export function statedCellSize(text: string): string | null {
  const m = text.match(/(?<![0-9])(18650|21700|26650|32700|4680|2170)(?![0-9])/);
  return m ? (m[1] === "2170" ? "21700" : m[1]) : null;
}

/** Judges one candidate: null when it is clearly not what was asked for, else Exact or Check with its economics. */
export function scoreCandidate(req: Requirement, c: Candidate): Match | null {
  const checks: Check[] = [];
  const text = candidateText(c);

  // Product: named models must appear; else named makes; else the trade/supply AI judgement.
  if (req.cellTokens.length) {
    if (c.format && c.format !== "Cells") return null;
    const sizes = req.cellTokens.filter((tok) => tok in CELL_WH);
    const size = statedCellSize(text);
    // A different stated cell size is a different product.
    if (size && sizes.length && !sizes.includes(size)) return null;
    // So is a cell whose energy cannot fit the size asked for, or one that says it is prismatic or pouch.
    if (sizes.length && c.kwh != null && !sizes.some((tok) => c.kwh! * 1000 >= CELL_WH[tok][0] && c.kwh! * 1000 <= CELL_WH[tok][1])) return null;
    if (sizes.length && / (prismatic|pouch|blade|lf\d{2,3}) /.test(text)) return null;
    // Small cylindrical cells hold at most about 6 Ah; a 40 Ah or 61.2 Ah cell is prismatic or pouch.
    const ah = text.match(/(\d+(?:\.\d+)?) ?ah\b/);
    if (sizes.some((tok) => tok !== "4680") && ah && Number(ah[1]) > 6) return null;
    // A trade or batch that never says cells (packs, a BESS tender) is not a cell lot, whatever the inbox AI linked.
    if (!c.format && !/ cells? /.test(text)) return null;
    if (req.cellFormats.length && c.cellFormat && !req.cellFormats.some((f) => c.cellFormat!.toLowerCase().includes(f.toLowerCase()))) return null;
    const hit = size && sizes.includes(size) ? size : req.cellTokens.find((tok) => !(tok in CELL_WH) && text.includes(tok));
    checks.push({ key: "product", label: "Cell type", state: hit ? "pass" : "unknown", detail: hit ? `${hit} cells` : "Cell size not stated" });
  } else if (req.products.length) {
    const hit = req.products.find((p) => p.anyOf.some((m) => text.includes(` ${m} `) || text.includes(` ${m.replace(/\s/g, "")} `))
      && !p.not.some((n) => text.includes(` ${n} `)));
    if (!hit && !c.ai) return null;
    const makeOk = !req.makeWords.length || req.makeWords.some((w) => text.includes(` ${w} `));
    if (hit && !makeOk && c.make) return null;
    checks.push(hit
      ? { key: "product", label: "Product", state: "pass", detail: `${[c.make, c.model].filter(Boolean).join(" ") || c.title}` }
      : { key: "product", label: "Product", state: "partial", detail: `AI: ${c.ai!.reason}` });
  } else if (req.makeWords.length) {
    const hit = req.makeWords.some((w) => text.includes(` ${w} `));
    if (!hit && !c.ai) return null;
    checks.push({ key: "product", label: "Make", state: hit ? "pass" : "partial", detail: hit ? (c.make ?? c.title) : `AI: ${c.ai!.reason}` });
  } else if (c.ai) {
    checks.push({ key: "product", label: "Product", state: "partial", detail: `AI: ${c.ai.reason}` });
  }

  if (req.evOnly && (/ (bess|container|containerised|containerized|stationary|cabinet|rack) /.test(text) || (c.kwh ?? 0) > 300)) return null;

  // Format.
  if (req.formats.length) {
    if (c.format && !req.formats.includes(c.format)) return null;
    checks.push({ key: "format", label: "Format", state: c.format ? "pass" : "unknown", detail: c.format ?? "Format not stated" });
  }

  // Chemistry: a stated, different chemistry rules the unit out; generic "Li-ion" is unknown.
  if (req.chemistries.length) {
    const chem = c.chemistry?.toUpperCase() ?? null;
    if (chem && chem !== "LI-ION" && !req.chemistries.some((x) => x.toUpperCase() === chem)) return null;
    checks.push({ key: "chemistry", label: "Chemistry", state: chem && chem !== "LI-ION" ? "pass" : "unknown",
      detail: chem && chem !== "LI-ION" ? chem : "Chemistry not confirmed" });
  } else if (c.chemistry && /nimh|lead/i.test(c.chemistry) && !req.cellTokens.length) {
    return null; // nobody on the demand list buys NiMH or lead-acid unless they say so
  }

  // Capacity.
  if (req.kwh) {
    if (c.kwh == null) {
      checks.push({ key: "capacity", label: "Capacity", state: "unknown", detail: "kWh not stated" });
    } else {
      const state = kwhFits(req, c.kwh);
      if (state === "fail") return null;
      checks.push({ key: "capacity", label: "Capacity", state: c.kwhEstimated && state === "pass" ? "partial" : state,
        detail: `${c.kwhEstimated ? "~" : ""}${kwhLabel(c.kwh)}${c.kwhEstimated ? " (typical for this model)" : ""}` });
    }
  } else if (c.kwh != null && c.kwh < 5 && req.formats.includes("Packs") && !req.cellTokens.length) {
    return null; // hybrid packs under 5 kWh are not what a pack buyer means
  }

  // Nothing pinned down at all: refuse to rank the whole inventory.
  if (!checks.some((x) => x.key === "product" || x.key === "capacity" || x.key === "chemistry")) return null;

  if (req.minSoh != null && c.soh != null && c.soh < req.minSoh) return null;

  // Economics.
  // A zero price or a pack above €600/kWh is a listing placeholder or a currency slip, not a price to plan on.
  let sellerEurPerUnit = c.price != null && c.price > 0 ? toEur(c.price, c.currency) : null;
  // Under €5/kWh is a token price (1 NOK, a £1 auction start), and it would float to the top of a cheapest-first list.
  if (sellerEurPerUnit != null && c.kwh && (sellerEurPerUnit / c.kwh < 5 || (c.kwh >= 5 && sellerEurPerUnit / c.kwh > 600))) sellerEurPerUnit = null;
  const sellerEurPerKwh = sellerEurPerUnit != null && c.kwh ? sellerEurPerUnit / c.kwh : null;
  const buyerEurPerUnit = req.buyerEurPerUnit ?? (req.buyerEurPerKwh != null && c.kwh ? req.buyerEurPerKwh * c.kwh : null);
  const marginPct = buyerEurPerUnit != null && sellerEurPerUnit != null && buyerEurPerUnit > 0
    ? (buyerEurPerUnit - sellerEurPerUnit) / buyerEurPerUnit : null;
  const coverUnits = Math.min(c.units ?? 1, req.unitsNeeded ?? c.units ?? 1);
  const spreadEur = marginPct != null ? (buyerEurPerUnit! - sellerEurPerUnit!) * coverUnits : null;
  if (marginPct != null) {
    checks.push({ key: "price", label: "Price", state: marginPct >= 0.1 ? "pass" : marginPct >= 0 ? "partial" : "fail",
      detail: marginPct >= 0 ? `${Math.round(marginPct * 100)}% under the buyer's max` : `${Math.round(-marginPct * 100)}% over the buyer's max` });
  } else {
    checks.push({ key: "price", label: "Price", state: "unknown",
      detail: sellerEurPerUnit == null ? "No seller price" : "Buyer has not given a price" });
  }

  // Quantity.
  if (req.unitsNeeded) {
    const have = c.units ?? 1;
    checks.push({ key: "quantity", label: "Quantity", state: have >= req.unitsNeeded ? "pass" : "partial",
      detail: `${have} of ${req.unitsNeeded} ${have >= req.unitsNeeded ? "" : "(group with others below)"}`.trim() });
  } else if (req.kwhNeeded && c.kwh) {
    const have = (c.units ?? 1) * c.kwh;
    checks.push({ key: "quantity", label: "Quantity", state: have >= req.kwhNeeded ? "pass" : "partial",
      detail: `${Math.round(have)} of ${Math.round(req.kwhNeeded)} kWh` });
  }

  // Location, seller trust and freshness are shown as columns, not scored: the trader judges them at a glance.
  const verdict = checks.every((x) => !PRODUCT_CHECKS.has(x.key) || x.state === "pass") ? "exact" : "check";
  const make = (c.make ?? "").toLowerCase();
  const modelWord = norm(c.model ?? c.title).trim().split(" ").filter((w) => w !== make)[0] ?? "";
  const groupKey = `${make}|${modelWord}|${c.kwh ? Math.round(c.kwh) : "?"}|${c.format ?? ""}`;
  return {
    candidate: c, verdict, checks,
    economics: { sellerEurPerKwh, sellerEurPerUnit, buyerEurPerKwh: req.buyerEurPerKwh, buyerEurPerUnit, marginPct, spreadEur, cheapestRank: null, peers: 0 },
    group: c.source === "trade" || c.source === "supply" ? `${c.source}:${c.key}` : groupKey,
  };
}

const groupLabel = (m: Match) => {
  const c = m.candidate;
  if (c.source === "trade" || c.source === "supply") return c.title;
  // Stock lists often repeat the make in the model ("Citroen Citroen Berlingo").
  const model = c.make && c.model?.toLowerCase().startsWith(c.make.toLowerCase()) ? c.model.slice(c.make.length).trim() : c.model;
  const name = [c.make, model].filter(Boolean).join(" ") || c.title;
  const size = c.kwh ? ` · ${c.kwhEstimated ? "~" : ""}${c.kwh < 1 ? `${Math.round(c.kwh * 1000)} Wh` : kwhLabel(c.kwh)}` : "";
  return `${name}${size}${c.format && c.format !== "Packs" ? ` ${c.format.toLowerCase()}` : ""}`;
};

const FIT_RANK: Record<Match["verdict"], number> = { exact: 0, check: 1 };
/** A lot under this share of a bulk ask is noise next to the ask (one cell against 500,000). */
export const SMALL_SHARE = 0.01;
const priceOf = (m: Match) => m.economics.sellerEurPerKwh ?? 1e9;

/** One rule: Exact before Check, then cheapest €/kWh (priced before unpriced), then the group that covers more of the ask. */
export function compareGroups(a: MatchGroup, b: MatchGroup): number {
  const covers = (g: MatchGroup) => (g.covers ? Math.min(1, g.covers.have / g.covers.need) : 0);
  return Number(a.small) - Number(b.small) || FIT_RANK[a.verdict] - FIT_RANK[b.verdict] || (a.eurPerKwh?.min ?? 1e9) - (b.eurPerKwh?.min ?? 1e9) || covers(b) - covers(a) || b.units - a.units;
}

/** Filters our inventory to what fits, groups the same product across sellers, and sorts Exact then cheapest. */
export function matchDemand(demand: Demand, candidates: Candidate[], hidden: Set<string> = new Set()): MatchResult {
  const requirement = requirementFor(demand, vocabulary(candidates));
  const pinned = requirement.products.length || requirement.makeWords.length || requirement.kwh
    || requirement.chemistries.length || requirement.cellTokens.length;
  if (!pinned && !candidates.some((c) => c.ai)) {
    return { requirement, groups: [], considered: candidates.length, blocked: "The ask names no product, capacity or chemistry, so there is nothing to match on. Add one in Edit.", fxNote: FX_NOTE };
  }
  const matches = candidates.filter((c) => !hidden.has(c.key)).map((c) => scoreCandidate(requirement, c)).filter((m): m is Match => !!m);
  const byGroup = new Map<string, Match[]>();
  for (const m of matches) byGroup.set(m.group, [...(byGroup.get(m.group) ?? []), m]);
  const groups: MatchGroup[] = [];
  for (const [key, list] of byGroup) {
    const priced = list.filter((m) => m.economics.sellerEurPerKwh != null).sort((a, b) => a.economics.sellerEurPerKwh! - b.economics.sellerEurPerKwh!);
    priced.forEach((m, i) => { m.economics.cheapestRank = i; m.economics.peers = priced.length; });
    // Within a group: best fit first, then cheapest, so the unit to buy is always on top.
    list.sort((a, b) => FIT_RANK[a.verdict] - FIT_RANK[b.verdict] || priceOf(a) - priceOf(b));
    const units = list.reduce((s, m) => s + (m.candidate.units ?? 1), 0);
    const best = list[0];
    const need = requirement.unitsNeeded;
    const margins = list.map((m) => m.economics.marginPct).filter((x): x is number => x != null);
    groups.push({
      key, label: groupLabel(best),
      verdict: best.verdict,
      units,
      sellers: bySeller(list).map((seller) => seller.name),
      sources: [...new Set(list.flatMap((m) => [m.candidate.source, ...m.candidate.alsoIn]))],
      eurPerKwh: priced.length ? { min: priced[0].economics.sellerEurPerKwh!, max: priced[priced.length - 1].economics.sellerEurPerKwh! } : null,
      bestMarginPct: margins.length ? Math.max(...margins) : null,
      covers: need ? { have: units, need } : null,
      small: !!need && need >= 50 && units < need * SMALL_SHARE,
      matches: list,
    });
  }
  groups.sort(compareGroups);
  return { requirement, groups, considered: candidates.length, blocked: null, fxNote: FX_NOTE };
}

const vocabCache = new WeakMap<Candidate[], Set<string>>();
/** Every word sellers use in a make or model: the only words that can name a product in an ask. */
export function vocabulary(candidates: Candidate[]): Set<string> {
  let vocab = vocabCache.get(candidates);
  if (!vocab) {
    vocab = new Set();
    for (const c of candidates) for (const w of norm(`${c.make ?? ""} ${c.model ?? ""}`).trim().split(" ")) if (w.length > 1 && !GENERIC.has(w)) vocab.add(w);
    vocabCache.set(candidates, vocab);
  }
  return vocab;
}

/** One company across sources: "LKQ SYNETIQ" (marketplace) and "Synetiq" (stock list) are the same seller. */
export const sellerKey = (name: string | null) =>
  (name ?? "").toLowerCase().replace(/\(.*\)|\b(autohandel|lkq|automotive|auto|recycling|nv|ltd|limited|as|ab|bv|uab)\b|b\.v\./g, " ")
    .trim().split(/\s+/)[0] || (name ?? "").toLowerCase();

export type SellerGroup = {
  key: string;
  name: string;
  country: string | null;
  location: string | null;
  sources: SourceKind[];
  units: number;
  kwh: { min: number; max: number } | null;
  eurPerKwh: { min: number; max: number } | null;
  /** EUR for the priced units only; `pricedUnits` says how many that is. */
  totalEur: number | null;
  pricedUnits: number;
  verdict: Match["verdict"];
  withPhotos: number;
  matches: Match[];
};

/** A group split by seller, best first: Exact, then cheapest, then most units. Each seller is one collection. */
export function bySeller(matches: Match[]): SellerGroup[] {
  const map = new Map<string, Match[]>();
  for (const m of matches) {
    const key = sellerKey(m.candidate.seller) || m.candidate.key;
    map.set(key, [...(map.get(key) ?? []), m]);
  }
  const out: SellerGroup[] = [];
  for (const [key, list] of map) {
    const units = list.reduce((n, m) => n + (m.candidate.units ?? 1), 0);
    const kwhs = list.map((m) => m.candidate.kwh).filter((k): k is number => k != null);
    const priced = list.filter((m) => m.economics.sellerEurPerKwh != null);
    const perKwh = priced.map((m) => m.economics.sellerEurPerKwh!);
    // The name from the row with most units reads best ("Silverlake Automotive Recycling" over "Silverlake").
    const names = list.map((m) => m.candidate.seller).filter((n): n is string => !!n).sort((a, b) => b.length - a.length);
    out.push({
      key, name: names[0] ?? "Unknown seller",
      country: list.find((m) => m.candidate.country)?.candidate.country ?? null,
      location: list.find((m) => m.candidate.location)?.candidate.location ?? null,
      sources: [...new Set(list.flatMap((m) => [m.candidate.source, ...m.candidate.alsoIn]))],
      units,
      kwh: kwhs.length ? { min: Math.min(...kwhs), max: Math.max(...kwhs) } : null,
      eurPerKwh: perKwh.length ? { min: Math.min(...perKwh), max: Math.max(...perKwh) } : null,
      totalEur: priced.length ? priced.reduce((sum, m) => sum + m.economics.sellerEurPerUnit! * (m.candidate.units ?? 1), 0) : null,
      pricedUnits: priced.reduce((n, m) => n + (m.candidate.units ?? 1), 0),
      verdict: list.some((m) => m.verdict === "exact") ? "exact" : "check",
      withPhotos: list.filter((m) => m.candidate.photos > 0).length,
      matches: list,
    });
  }
  return out.sort((a, b) => FIT_RANK[a.verdict] - FIT_RANK[b.verdict] || (a.eurPerKwh?.min ?? 1e9) - (b.eurPerKwh?.min ?? 1e9) || b.units - a.units);
}

export type FillPlan = { sellers: { name: string; units: number }[]; units: number; need: number; eurPerKwh: number | null };

/**
 * Fewest sellers to fill the ask, since every extra seller is another collection: take the sellers with most units
 * first (cheaper first on a tie), and from each the cheapest units, until the ask is covered.
 */
export function fewestSellers(sellers: SellerGroup[], need: number | null): FillPlan | null {
  if (!need || need <= 0 || !sellers.length) return null;
  const order = [...sellers].sort((a, b) => b.units - a.units || (a.eurPerKwh?.min ?? 1e9) - (b.eurPerKwh?.min ?? 1e9));
  const plan: FillPlan["sellers"] = [];
  let have = 0;
  let eur = 0;
  let kwh = 0;
  for (const seller of order) {
    if (have >= need) break;
    let take = 0;
    for (const m of [...seller.matches].sort((a, b) => (a.economics.sellerEurPerKwh ?? 1e9) - (b.economics.sellerEurPerKwh ?? 1e9))) {
      if (have + take >= need) break;
      const n = Math.min(m.candidate.units ?? 1, need - have - take);
      take += n;
      if (m.economics.sellerEurPerUnit != null && m.candidate.kwh) {
        eur += m.economics.sellerEurPerUnit * n;
        kwh += m.candidate.kwh * n;
      }
    }
    plan.push({ name: seller.name, units: take });
    have += take;
  }
  return { sellers: plan, units: have, need, eurPerKwh: kwh ? eur / kwh : null };
}

/** The one-line answer for the demand list's Next column. */
export function bestLine(result: MatchResult): { text: string; verdict: Match["verdict"] } | null {
  const top = result.groups.find((g) => !g.small);
  if (!top) return null;
  const margin = top.bestMarginPct != null ? ` · ${Math.round(top.bestMarginPct * 100)}% margin` : "";
  const units = top.covers ? ` · ${Math.min(top.units, top.covers.need)}/${top.covers.need}` : top.units > 1 ? ` · ${top.units} units` : "";
  return { verdict: top.verdict, text: `${top.label}${units}${margin}` };
}
