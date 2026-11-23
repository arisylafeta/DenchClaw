// The Matches rules layer: rule out only on a conflict both sides state, then order by fixed keys.
//
// This is a faithful TypeScript port of the proven A1 ranking in
// `scripts/rebattery/match_replay/rules.py` (11 of 12 real lots in the top 5, zero rule violations). The replay
// gate in `scripts/rebattery/match_replay/run_replay.py --arm TS` runs this file against the frozen fixtures and
// fails on any difference from A1, so there is one implementation and it cannot drift.
//
// A missing fact never rules anyone out. A disputed fact (a `conflict` field in the product key) is treated as
// missing, because a disputed figure must not decide who is ruled out.
import type { KeyFormat, ProductKey, ProductLine } from "./product-key";
import { activityFit, RESEARCH_POLICY } from "./research-policy";
import { broaderKeysFor, CELL_FORMATS, CYLINDRICAL_SIZES, normalCellFormat, productKeyLevel, type CellFormat, type ProductFacts } from "./product-key-for";

export type SupplyFacts = {
  title?: string | null;
  make?: string | null;
  model?: string | null;
  platform?: string | null;
  /** "cells" | "modules" | "packs" | "systems", lower case, as the replay fixtures and the key both give it. */
  format?: string | null;
  chemistry?: string | null;
  /** kWh per unit. Null when a range is stated or unknown. */
  kwh?: number | null;
  kwhMin?: number | null;
  kwhMax?: number | null;
  moduleSeries?: string | null;
  partNumber?: string | null;
  /** A cell lot's form factor (18650, 21700, cylindrical, prismatic, pouch); null when the lot does not state one. */
  cellFormat?: string | null;
  /** The cell model code of a cell lot (NCR2170M), never a vehicle model. */
  cellModel?: string | null;
  /** Pack nominal voltage in volts, when the listing states one. */
  voltageV?: number | null;
  units?: number | null;
  sellerPriceEurPerKwh?: number | null;
  sellerPriceEurPerUnit?: number | null;
  /** A batch that cannot be split. */
  wholeBatch?: boolean | null;
  /** Damaged or mixed-condition stock. */
  damagedMixed?: boolean | null;
  /** The seller's company, so their own buy box never ranks them. */
  seller?: string | null;
  country?: string | null;
  soh?: number | string | null;
  tested?: boolean | string | null;
};

/** The as-of view of a dossier: frontmatter (already date-filtered by the replay) and the filtered body. */
export type DossierView = { frontmatter?: Record<string, unknown> | null; body?: string | null };

export type BuyerFacts = {
  id: string;
  name: string;
  profile: Record<string, unknown>;
  stage: string | null;
  tier: string | null;
  basis: string | null;
  lastTouch: string | null;
  dossier: DossierView | null;
  /**
   * Dated `buyer_interest` lines, current as of the ranking date. Absent or empty means today's ranking exactly:
   * lines only add evidence, they never rule anyone out or lower a tier.
   */
  lines?: BuyerLine[] | null;
};

/** One `buyer_interest` line as the rules read it. Facts and dates only; expiry is checked against the ranking date. */
export type BuyerLine = {
  kind: string;
  productKey: string;
  make?: string | null;
  model?: string | null;
  format?: string | null;
  chemistry?: string | null;
  kwhMin?: number | null;
  kwhMax?: number | null;
  firstSeen: string;
  lastSeen: string;
  expiresOn?: string | null;
  quantity?: number | null;
  quantityUnit?: string | null;
  price?: number | null;
  priceCurrency?: string | null;
  priceUnit?: string | null;
  /** `target` for a buyer's wanted price (never a hard limit), `bid` and `paid` for what they offered or paid. */
  priceBasis?: string | null;
  /** A flexible upper figure stated beside a target: "under $30/kWh, flexible up to $50". Shown, never filtered on. */
  priceMax?: number | null;
  declineReason?: string | null;
};

export type RankedBuyer = {
  companyId: string;
  name: string;
  productTier: number;
  /** Kind rank and recency of the best specific, non-inferred line; 0 when none. Tie-breaks after the price keys. */
  lineKind?: number;
  lineRecency?: number;
  priceFit: number;
  priceBasis: number;
  priceMargin: number;
  /** Relative gap between the lot and the nearest size a dossier buyer bought or asked for; 0 when unknown. Smaller ranks higher, after the price keys. */
  sizeGap?: number;
  /** A research-only buyer whose site lists other chemistries than the lot. Stays in, ranks below the same tier without it. */
  chemDiffers?: boolean;
  stage: string | null;
  basis: string | null;
  lastTouch: string;
  isLead: boolean;
};

export const STAGE_RANK: Record<string, number> = {
  Customer: 6, Bidding: 5, Qualified: 4, "In conversation": 3, Responded: 2, Contacted: 1, Identified: 0,
};
export const TIER_RANK: Record<string, number> = { A: 2, B: 1, C: 0 };
export const PRICE_BASIS_RANK: Record<string, number> = { paid: 3, quoted_by_buyer: 2, stated_target: 1 };

const GENERIC = new Set(`battery batteries pack packs module modules cell cells
  kwh kw ev evs hv used new second life tested
  untested complete for and or the a an of with
  from to van vans car cars traction bess container
  pilot storage stationary units unit approx approximately
  mixed etc lithium li ion lfp nmc nca lmo lto`.split(/\s+/).filter(Boolean));

/** A list of usable values: a JSON array, or one string. */
function list(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
      .map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

/** One `rules_out` or `evidence_required` entry: a plain value, or a {value, seen, src} mapping. */
function ruleEntryValue(item: unknown): string | null {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const value = (item as Record<string, unknown>).value;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  if (typeof item === "string" && item.trim()) {
    return item.trim();
  }
  if (typeof item === "number" && Number.isFinite(item)) {
    return String(item);
  }
  return null;
}

/** `rules_out` and `evidence_required` values, with dated entries unwrapped. */
function ruleValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(ruleEntryValue).filter((item): item is string => !!item);
  }
  const single = ruleEntryValue(value);
  return single ? [single] : [];
}

export function norm(text: unknown): string {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Accent-insensitive normalisation, used only for body-keyword matching. */
export function normLoose(text: unknown): string {
  return String(text ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function tokens(text: unknown): string[] {
  return norm(text).split(" ").filter((token) => token.length > 1 && !GENERIC.has(token));
}

const PLATFORM_GROUPS: Set<string>[] = [
  new Set(["meb"]),
  new Set(["e cmp", "ecmp", "cmp", "smart car"]),
  new Set(["e k9", "ek9", "k9"]),
  new Set(["k0"]),
  new Set(["stla m"]),
  new Set(["stla"]),
  new Set(["egmp", "e gmp"]),
  new Set(["ze1"]),
];

function platformKey(value: unknown): string | null {
  const key = norm(value);
  if (!key) {
    return null;
  }
  for (let index = 0; index < PLATFORM_GROUPS.length; index += 1) {
    if (PLATFORM_GROUPS[index].has(key)) {
      return `g${index}`;
    }
  }
  return key;
}

export function platformMatch(a: unknown, b: unknown): boolean {
  const ka = platformKey(a);
  const kb = platformKey(b);
  return !!(ka && kb && ka === kb);
}

const hasDossier = (buyer: BuyerFacts) => !!buyer.dossier && Object.keys(buyer.dossier).length > 0;
/** Kinds of Want that mean a buyer has told us something themselves; only `inferred` (a research guess) does not. */
const STATED_KINDS = new Set(["ask", "saved_search", "standing", "interest", "bought", "declined"]);

/** Research-only (lines loaded): no dossier and no live Want of a stated kind, so the website buy box is the only evidence. */
export function researchOnly(buyer: BuyerFacts, asOf: string): boolean {
  // `lines` absent means the lines are off: today's ranking, so nobody counts as research-only.
  return !hasDossier(buyer) && Array.isArray(buyer.lines) && !buyer.lines.some((line) => STATED_KINDS.has(line.kind) && lineLive(line, asOf));
}

/** The research-only buyer's website chemistries when none match the lot's chemistry, else null. */
function researchChemDiffers(supply: SupplyFacts, buyer: BuyerFacts, asOf: string): string[] | null {
  const chem = String(supply.chemistry ?? "").toUpperCase();
  const stated = list(buyer.profile.chemistries).map((value) => value.toUpperCase());
  return chem && stated.length && !stated.includes(chem) && researchOnly(buyer, asOf) ? stated : null;
}

const frontmatter = (buyer: BuyerFacts): Record<string, unknown> => buyer.dossier?.frontmatter ?? {};

function dossierProducts(buyer: BuyerFacts): Record<string, unknown>[] {
  const products = frontmatter(buyer).products;
  return Array.isArray(products) ? products.filter((product): product is Record<string, unknown> => !!product && typeof product === "object") : [];
}

function dossierRules(buyer: BuyerFacts): Record<string, unknown> {
  const rules = frontmatter(buyer).rules_out;
  return rules && typeof rules === "object" && !Array.isArray(rules) ? (rules as Record<string, unknown>) : {};
}

function dossierPrice(buyer: BuyerFacts): Record<string, unknown> | null {
  const rows = (frontmatter(buyer).price as unknown[] | undefined) ?? [];
  const usable = Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];
  if (!usable.length) {
    return null;
  }
  let best = usable[0];
  let bestKey = priceRowKey(best);
  for (const row of usable.slice(1)) {
    const key = priceRowKey(row);
    // Python's max() keeps the first of equal rows.
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { best = row; bestKey = key; }
  }
  return best;
}

const priceRowKey = (row: Record<string, unknown>): [number, number] => [
  PRICE_BASIS_RANK[String(row.basis ?? "")] ?? 0,
  Number(row.eur_per_kwh ?? row.eur_per_unit ?? 0),
];

function buyerChemistries(buyer: BuyerFacts): string[] {
  if (hasDossier(buyer)) {
    return dossierProducts(buyer).filter((p) => p.chemistry).map((p) => String(p.chemistry));
  }
  return list(buyer.profile.chemistries);
}

function buyerFormats(buyer: BuyerFacts): string[] {
  if (hasDossier(buyer)) {
    return dossierProducts(buyer).filter((p) => p.format).map((p) => String(p.format));
  }
  return list(buyer.profile.formats);
}

function buyerPartNumbers(buyer: BuyerFacts): string[] {
  if (hasDossier(buyer)) {
    return dossierProducts(buyer).filter((p) => p.part_number).map((p) => String(p.part_number));
  }
  return list(buyer.profile.part_numbers);
}

const wantsText = (buyer: BuyerFacts) => String(buyer.profile.wants ?? "");
const profileModels = (buyer: BuyerFacts) => list(buyer.profile.models);

/** Dated asks strictly before the offer; undated asks are dropped. */
export function filteredPastAsks(profile: Record<string, unknown>, asOf: string): string[] {
  const asks = profile.past_asks;
  if (!Array.isArray(asks)) {
    return [];
  }
  const out: string[] = [];
  for (const item of asks) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const date = String(row.date ?? "").slice(0, 10);
    if (!date || date >= asOf) {
      continue;
    }
    if (row.wants) {
      out.push(String(row.wants));
    }
  }
  return out;
}

/** Product words from the strict-dated dossier body and dated past asks. Nothing undated gets in. */
function fallbackText(buyer: BuyerFacts, asOf: string): string {
  const parts: string[] = [];
  if (buyer.dossier?.body) {
    parts.push(String(buyer.dossier.body));
  }
  parts.push(...filteredPastAsks(buyer.profile, asOf));
  return ` ${normLoose(parts.join(" "))} `;
}

/**
 * 4 part number, 3 model/platform, 2 make, 1 chemistry+format, 0 none.
 * `bodyFallback: false` is the A1-strict arm: frontmatter and profile facts only, no keyword read of the body.
 */
export function productTier(supply: SupplyFacts, buyer: BuyerFacts, asOf: string, bodyFallback = true): number {
  const part = norm(supply.partNumber);
  if (part) {
    for (const candidate of buyerPartNumbers(buyer)) {
      if (norm(candidate) === part) {
        return 4;
      }
    }
    if (` ${norm(wantsText(buyer))} `.includes(` ${part} `)) {
      return 4;
    }
  }

  const supplyModels = tokens(supply.model);
  const platform = supply.platform;
  for (const product of dossierProducts(buyer)) {
    if (platform && product.platform && platformMatch(platform, product.platform)) {
      return 3;
    }
    if (supplyModels.length && product.model) {
      const productNorm = norm(product.model);
      if (supplyModels.some((model) => ` ${productNorm} `.includes(` ${model} `))) {
        return 3;
      }
    }
  }
  for (const model of profileModels(buyer)) {
    if (supplyModels.length && supplyModels.some((token) => ` ${norm(model)} `.includes(` ${token} `))) {
      return 3;
    }
  }
  const wantsNorm = norm(wantsText(buyer));
  if (supplyModels.length && supplyModels.some((model) => ` ${wantsNorm} `.includes(` ${model} `))) {
    return 3;
  }
  if (platform && ` ${wantsNorm} `.includes(` ${norm(platform)} `)) {
    return 3;
  }

  const supplyMakes = tokens(supply.make).filter((token) => token !== "group");
  if (supplyMakes.length) {
    for (const product of dossierProducts(buyer)) {
      if (product.make && supplyMakes.some((make) => ` ${norm(product.make)} `.includes(` ${make} `))) {
        return 2;
      }
    }
    for (const make of [...list(buyer.profile.makes), ...list(buyer.profile.cell_makers)]) {
      if (supplyMakes.some((token) => ` ${norm(make)} `.includes(` ${token} `))) {
        return 2;
      }
    }
    if (supplyMakes.some((make) => ` ${wantsNorm} `.includes(` ${make} `))) {
      return 2;
    }
  }

  const chemistries = buyerChemistries(buyer);
  const chemOk = chemMatch(supply, chemistries);
  const fmtOk = formatMatch(supply, buyerFormats(buyer));
  // A research-only buyer's chemistry ranks instead of filtering; the format still has to fit.
  const chemRanks = !!researchChemDiffers(supply, buyer, asOf) && (fmtOk || !supply.format);
  const earlyTier1 = chemRanks
    || (chemOk && fmtOk)
    || (chemOk && !supply.format)
    || (fmtOk && !supply.chemistry)
    || (fmtOk && !chemistries.length);
  if (!bodyFallback) {
    return earlyTier1 ? 1 : 0;
  }

  // Last resort: product words in the strict-dated dossier body and dated asks.
  const text = fallbackText(buyer, asOf);
  if (part && text.includes(` ${part} `)) {
    return 4;
  }
  if (platform && text.includes(` ${normLoose(platform)} `)) {
    return 3;
  }
  if (supplyModels.length && supplyModels.some((model) => text.includes(` ${model} `))) {
    return 3;
  }
  if (supplyMakes.length && supplyMakes.some((make) => text.includes(` ${make} `))) {
    return 2;
  }
  const chemWord = normLoose(supply.chemistry);
  const fmtWord = normLoose(supply.format);
  const chemHit = !!chemWord && text.includes(` ${chemWord} `);
  const fmtHit = !!fmtWord && (text.includes(` ${fmtWord} `) || text.includes(` ${fmtWord.replace(/s$/, "")} `));
  if ((chemHit && fmtHit) || (fmtHit && !supply.chemistry) || (chemHit && !supply.format) || (fmtHit && !chemistries.length)) {
    return 1;
  }
  return earlyTier1 ? 1 : 0;
}

function chemMatch(supply: SupplyFacts, chemistries: string[]): boolean {
  const chem = String(supply.chemistry ?? "").toUpperCase();
  return !!chem && chemistries.map((value) => value.toUpperCase()).includes(chem);
}

function formatMatch(supply: SupplyFacts, formats: string[]): boolean {
  const fmt = String(supply.format ?? "").toLowerCase();
  return !!fmt && formats.map((value) => value.toLowerCase()).includes(fmt);
}

/** "30 kWh or more" read from dossier prose: a range, a minimum, or "at least". */
export function bodyKwhBounds(body: string): [number, number] | null {
  const text = body ?? "";
  let match = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to|\u2013)\s*(\d+(?:\.\d+)?)\s*kwh/i);
  if (match) {
    const lo = Number(match[1]);
    const hi = Number(match[2]);
    return [Math.min(lo, hi), Math.max(lo, hi)];
  }
  match = text.match(/(\d+(?:\.\d+)?)\s*kwh\s*(?:minimum|min\b)/i);
  if (match) {
    return [Number(match[1]), 10_000];
  }
  match = text.match(/(?:minimum|at least|min(?:imum)?)\s*(\d+(?:\.\d+)?)\s*kwh/i);
  if (match) {
    return [Number(match[1]), 10_000];
  }
  return null;
}

/** A dossier product's stated capacity, including the optional open range (kwh_min / kwh_max). */
function productKwhValues(product: Record<string, unknown>): number[] {
  const values = product.kwh;
  if (Array.isArray(values)) {
    return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  }
  if (typeof values === "number" && Number.isFinite(values)) {
    return [values];
  }
  return [];
}

/** [min, max] for a product that states an open range instead of a single kWh figure. */
function productKwhRange(product: Record<string, unknown>): [number, number] | null {
  const lo = typeof product.kwh_min === "number" ? product.kwh_min : null;
  const hi = typeof product.kwh_max === "number" ? product.kwh_max : null;
  if (lo == null && hi == null) {
    return null;
  }
  return [lo ?? 0, hi ?? 10_000];
}

const relativeGap = (value: number, target: number) => (target ? Math.abs(value - target) / target : 1);

/** The gap between a supply figure (or range) and a buyer's capacity figure (or range); 0 when they overlap. */
function gapBetween(supplyLo: number, supplyHi: number, targetLo: number, targetHi: number): number {
  if (supplyHi < targetLo) {
    return relativeGap(supplyHi, targetLo);
  }
  if (supplyLo > targetHi) {
    return relativeGap(supplyLo, targetHi);
  }
  return 0;
}

/** A supply figure as an interval: one value, or the stated range. */
const supplyRange = (supply: SupplyFacts): [number, number] | null => {
  const lo = supply.kwhMin;
  const hi = supply.kwhMax;
  if (typeof lo === "number" && typeof hi === "number") {
    return [lo, hi];
  }
  if (typeof supply.kwh === "number") {
    return [supply.kwh, supply.kwh];
  }
  return null;
};

/** The buy box's kWh bounds for this lot: its own format's bounds when the profile has them, else the flat ones. */
function profileKwhBounds(supply: SupplyFacts, profile: Record<string, unknown>): [number | null, number | null] {
  const byFormat = profile.kwh_by_format;
  const entry = byFormat && typeof byFormat === "object" && !Array.isArray(byFormat)
    ? (byFormat as Record<string, unknown>)[String(supply.format ?? "").toLowerCase()]
    : null;
  const source = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
  const lo = source ? source.min : profile.kwh_min;
  const hi = source ? source.max : profile.kwh_max;
  return [typeof lo === "number" ? lo : null, typeof hi === "number" ? hi : null];
}

function withinProfileKwh(supply: SupplyFacts, buyer: BuyerFacts, tolerance: number): boolean {
  const [lo, hi] = profileKwhBounds(supply, buyer.profile);
  const range = supplyRange(supply);
  if (!range || (lo == null && hi == null)) {
    return false;
  }
  if (lo != null && range[1] < lo * (1 - tolerance)) {
    return false;
  }
  if (hi != null && range[0] > hi * (1 + tolerance)) {
    return false;
  }
  return true;
}

function kwhTolerance(buyer: BuyerFacts): number {
  const substitution = frontmatter(buyer).substitution;
  if (substitution && typeof substitution === "object" && typeof (substitution as Record<string, unknown>).kwh_tolerance === "number") {
    return (substitution as Record<string, unknown>).kwh_tolerance as number;
  }
  return 0.15;
}

const SIZE_VERB: Record<string, string> = { bought: "they bought", asked: "they asked for", said_interested: "they said they wanted" };

/**
 * How far a lot's size is from the sizes a dossier buyer bought, asked for or said they wanted (same format).
 * Never excludes: it ranks (`gap`, 0 when unknown or a same-platform substitution) and, when the lot is beyond the
 * tolerance of every figure, names the nearest one in `note`. Legacy buyers return null.
 */
export function sizeFit(supply: SupplyFacts, buyer: BuyerFacts): { gap: number; note: string | null } | null {
  if (!hasDossier(buyer)) { return null; }
  const fmt = String(supply.format ?? "").toLowerCase();
  const range = supplyRange(supply);
  if (!range || (fmt !== "packs" && fmt !== "modules")) { return null; }
  if (dossierProducts(buyer).some((product) => supply.platform && product.platform && platformMatch(supply.platform, product.platform))) {
    return { gap: 0, note: null };
  }
  let best: { gap: number; value: number | null; status: string } | null = null;
  for (const product of dossierProducts(buyer)) {
    const status = String(product.status ?? "");
    if (!(status in SIZE_VERB) || String(product.format ?? "").toLowerCase() !== fmt) { continue; }
    const productRange = productKwhRange(product);
    if (productRange) {
      const gap = gapBetween(range[0], range[1], productRange[0], productRange[1]);
      if (!best || gap < best.gap) { best = { gap, value: null, status }; }
    }
    for (const value of productKwhValues(product)) {
      const gap = gapBetween(range[0], range[1], value, value);
      if (!best || gap < best.gap) { best = { gap, value, status }; }
    }
  }
  if (!best) { return { gap: 0, note: null }; }
  const gap = Math.floor(best.gap * 10_000 + 0.5) / 10_000;
  const note = best.value != null && best.gap > kwhTolerance(buyer)
    ? `Size differs: ${SIZE_VERB[best.status]} ${Math.round(best.value * 100) / 100} kWh`
    : null;
  return { gap, note };
}

/** `buyBox` marks the flat legacy buy box lists (chemistries, formats), the only rule-outs a live line can override. */
export type RuleOut = {
  code: string; detail: string; buyBox?: boolean; stated?: string;
  /** Dossier rules_out entries: the rule in the buyer's words, and the dated entry's `seen` and `src`. */
  text?: string; seen?: string; src?: string;
};

/** The dated `rules_out` entry behind a match: its text, and the `seen` / `src` when it carries them. */
function ruleEntry(raw: unknown, matches: (value: string) => boolean): { seen?: string; src?: string } {
  const items = Array.isArray(raw) ? raw : [raw];
  for (const item of items) {
    const value = ruleEntryValue(item);
    if (value && matches(value) && item && typeof item === "object") {
      const entry = item as Record<string, unknown>;
      return {
        ...(typeof entry.seen === "string" && entry.seen ? { seen: entry.seen } : {}),
        ...(typeof entry.src === "string" && entry.src ? { src: entry.src } : {}),
      };
    }
  }
  return {};
}

const alnum = (text: unknown) => String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A part or cell model code is at least 6 characters with a letter and a digit once upper-cased and stripped to A-Z, 0-9. */
export const isPartCode = (value: unknown) => {
  const code = alnum(value);
  return code.length >= 6 && /[A-Z]/.test(code) && /\d/.test(code);
};

/**
 * A lot whose part number or cell model code is exactly one the buyer refuses (`rules_out.part_numbers`).
 * Exact after upper-casing and stripping spaces and dashes: NCR2170M does not rule out NCR2170M-4, and the
 * vehicle model never counts.
 */
function partRule(supply: SupplyFacts, rules: Record<string, unknown>): RuleOut | null {
  const lot = [supply.partNumber, supply.cellModel].map(alnum).filter((value) => value.length > 0);
  if (!lot.length) { return null; }
  const items = Array.isArray(rules.part_numbers) ? rules.part_numbers : [];
  for (const item of items) {
    const value = ruleEntryValue(item);
    if (value && isPartCode(value) && lot.includes(alnum(value))) {
      return { code: "part", detail: `rules_out.part_numbers includes ${value}`, text: `No ${value}`, ...ruleEntry(item, (entry) => entry === value) };
    }
  }
  return null;
}

/** The buyer's stated minimum pack voltage as `{ value, seen, src }`, or null. */
function minPackVoltage(buyer: BuyerFacts): { value: number; seen?: string; src?: string } | null {
  const raw = frontmatter(buyer).min_pack_voltage;
  const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const value = entry ? entry.value : raw;
  if (typeof value !== "number" || !(value > 0)) { return null; }
  return {
    value,
    ...(entry && typeof entry.seen === "string" && entry.seen ? { seen: entry.seen } : {}),
    ...(entry && typeof entry.src === "string" && entry.src ? { src: entry.src } : {}),
  };
}

const voltageApplies = (supply: SupplyFacts) => ["packs", "systems"].includes(String(supply.format ?? "").toLowerCase());

/** Why this buyer is ruled out of this lot, or null. Only a conflict both sides state rules anyone out. */
export function ruleOut(supply: SupplyFacts, buyer: BuyerFacts, ignoreBuyBoxLists = false, asOf: string = new Date().toISOString().slice(0, 10)): RuleOut | null {
  const isDossier = hasDossier(buyer);
  const rules = isDossier ? dossierRules(buyer) : {};
  const profile = buyer.profile;
  const chem = String(supply.chemistry ?? "").toUpperCase();
  const fmt = String(supply.format ?? "").toLowerCase();

  if (isDossier) {
    const ruled = ruleValues(rules.chemistries).map((value) => value.toUpperCase());
    if (chem && ruled.includes(chem)) {
      return { code: "chemistry", detail: `rules_out.chemistries includes ${chem}`, text: `No ${chem} cells`, ...ruleEntry(rules.chemistries, (value) => value.toUpperCase() === chem) };
    }
    const lotCellFormat = isCellLot(supply) ? normalCellFormat(supply.cellFormat ?? null) : null;
    const ruledCell = lotCellFormat ? ruleValues(rules.cell_formats).find((value) => normalCellFormat(value) && cellFormatFits(value, lotCellFormat)) : undefined;
    if (ruledCell) {
      return { code: "cell_format", detail: `rules_out.cell_formats includes ${ruledCell}`, text: `No ${ruledCell} cells`, ...ruleEntry(rules.cell_formats, (value) => value === ruledCell) };
    }
    const ruledFormats = ruleValues(rules.formats).map((value) => value.toLowerCase());
    if (fmt && ruledFormats.includes(fmt)) {
      return { code: "format", detail: `rules_out.formats includes ${fmt}`, text: `No ${fmt}`, ...ruleEntry(rules.formats, (value) => value.toLowerCase() === fmt) };
    }
  } else if (!ignoreBuyBoxLists) {
    const stated = list(profile.chemistries).map((value) => value.toUpperCase());
    const statedFormats0 = list(profile.formats).map((value) => value.toLowerCase());
    const formatFits = !fmt || statedFormats0.includes(fmt);
    if (chem && stated.length && !stated.includes(chem) && !(formatFits && researchOnly(buyer, asOf))) {
      return { code: "chemistry", detail: `buy profile chemistries are ${stated.join("/")}`, buyBox: true, stated: stated.join("/") };
    }
    const statedFormats = list(profile.formats).map((value) => value.toLowerCase());
    if (fmt && statedFormats.length && !statedFormats.includes(fmt)) {
      return { code: "format", detail: `buy profile formats are ${statedFormats.join("/")}`, buyBox: true, stated: statedFormats.join("/") };
    }
  }

  // A platform is only a conflict when the buyer explicitly refuses it.
  if (isDossier && supply.platform) {
    for (const phrase of ruleValues(rules.other)) {
      const text = norm(phrase);
      if (platformMatch(supply.platform, phrase) || ` ${text} `.includes(` ${norm(supply.platform)} `)) {
        if (["will not accept", "not interchangeable", "not acceptable", "refuses"].some((word) => text.includes(word))) {
          return { code: "platform", detail: `rules_out.other: ${phrase}`, text: ruleValues([phrase])[0], ...ruleEntry(rules.other, (value) => value === ruleValues([phrase])[0]) };
        }
      }
    }
  }

  // Capacity: only for packs and modules, and only when the buyer states a capacity on the same format.
  // A same-platform capacity difference is a substitution candidate, not a conflict.
  const range = supplyRange(supply);
  if (range && (fmt === "packs" || fmt === "modules")) {
    if (isDossier) {
      // Only a range the buyer stated (kwh_min / kwh_max) rules a lot out. Sizes from products they bought or
      // asked about only rank and add a check; see sizeFit.
      const products = dossierProducts(buyer).filter((product) => String(product.format ?? "").toLowerCase() === fmt
        && productKwhRange(product));
      const samePlatform = dossierProducts(buyer).some((product) => supply.platform && product.platform && platformMatch(supply.platform, product.platform));
      if (products.length && !samePlatform) {
        const tolerance = kwhTolerance(buyer);
        let best = Number.POSITIVE_INFINITY;
        for (const product of products) {
          const productRange = productKwhRange(product);
          if (productRange) {
            best = Math.min(best, gapBetween(range[0], range[1], productRange[0], productRange[1]));
          }
          for (const value of productKwhValues(product)) {
            best = Math.min(best, gapBetween(range[0], range[1], value, value));
          }
        }
        const bodyBounds = bodyKwhBounds(String(buyer.dossier?.body ?? ""));
        const bodyCovers = !!bodyBounds && range[0] >= bodyBounds[0] * (1 - tolerance) && range[1] <= bodyBounds[1] * (1 + tolerance);
        if (best > tolerance && !bodyCovers && !withinProfileKwh(supply, buyer, tolerance)) {
          const shown = supply.kwhMin != null && supply.kwhMax != null ? `${supply.kwhMin}-${supply.kwhMax}` : `${range[0]}`;
          return { code: "kwh", detail: `stated ${fmt} capacity is ${Math.round(best * 100)}% away from ${shown} kWh` };
        }
      }
    } else {
      const stated = profileKwhBounds(supply, profile).some((bound) => bound != null);
      if (stated && !withinProfileKwh(supply, buyer, 0.15)) {
        const shown = supply.kwhMin != null && supply.kwhMax != null ? `${supply.kwhMin}-${supply.kwhMax}` : `${range[0]}`;
        return { code: "kwh", detail: `buy profile kWh bounds exclude ${shown} kWh` };
      }
    }
  }

  if (isDossier) {
    const part = partRule(supply, rules);
    if (part) { return part; }
    const minV = minPackVoltage(buyer);
    if (minV && voltageApplies(supply) && supply.voltageV != null && supply.voltageV < minV.value) {
      const text = `Packs below ${minV.value} V`;
      const said = minV.seen ? `, said ${shortDate(minV.seen, asOf)}` : "";
      return { code: "voltage", detail: `${text}${said}`, text, ...(minV.seen ? { seen: minV.seen } : {}), ...(minV.src ? { src: minV.src } : {}) };
    }
  }
  if (isDossier && supply.damagedMixed && rules.damaged === true) {
    return { code: "damaged", detail: "buyer will not take damaged stock", text: "No damaged stock" };
  }
  if (fmt === "systems") {
    if (isDossier && rules.bess_systems === true) {
      return { code: "bess", detail: "buyer will not take containerised/stationary systems", text: "No containerised or stationary systems" };
    }
    const statedFormats = list(profile.formats).map((value) => value.toLowerCase());
    if (statedFormats.length === 1 && statedFormats[0] === "packs") {
      return { code: "bess", detail: "packs-only buyer" };
    }
  }
  if (supply.wholeBatch) {
    const quantity = isDossier ? frontmatter(buyer).quantity : null;
    if (quantity && typeof quantity === "object" && (quantity as Record<string, unknown>).whole_batch_ok === false) {
      return { code: "whole_batch", detail: "buyer will not take an indivisible batch" };
    }
  }

  const seller = norm(supply.seller);
  if (seller && norm(buyer.name) === seller) {
    return { code: "seller", detail: "seller's own company" };
  }
  return null;
}

/** Price fit: 3 buyer pays above the seller, 2 buyer has a price but no comparable seller price, 0 no price. */
export function priceKey(supply: SupplyFacts, buyer: BuyerFacts): [number, number, number] {
  const row = dossierPrice(buyer);
  let buyerKwh: number | null = null;
  let buyerUnit: number | null = null;
  let basisRank = 0;
  if (row) {
    buyerKwh = typeof row.eur_per_kwh === "number" ? row.eur_per_kwh : null;
    buyerUnit = typeof row.eur_per_unit === "number" ? row.eur_per_unit : null;
    basisRank = PRICE_BASIS_RANK[String(row.basis ?? "")] ?? 0;
  }
  const sellerKwh = supply.sellerPriceEurPerKwh ?? null;
  const sellerUnit = supply.sellerPriceEurPerUnit ?? null;
  if (buyerKwh != null && sellerKwh != null) {
    const spread = buyerKwh - sellerKwh;
    return [spread >= 0 ? 3 : 1, basisRank, sellerKwh ? spread / sellerKwh : 0];
  }
  if (buyerUnit != null && sellerUnit != null) {
    const spread = buyerUnit - sellerUnit;
    return [spread >= 0 ? 3 : 1, basisRank, sellerUnit ? spread / sellerUnit : 0];
  }
  if (buyerKwh != null || buyerUnit != null) {
    return [2, basisRank, 0];
  }
  return [0, 0, 0];
}

function lastTouch(buyer: BuyerFacts, asOf: string): string {
  const value = buyer.lastTouch;
  if (!value) {
    return "";
  }
  return value.slice(0, 10) <= asOf ? value.slice(0, 10) : "";
}

/** Newest first; an empty last touch sorts last. */
function lastTouchKey(value: string): number {
  if (!value) {
    return 10 ** 12;
  }
  const digits = value.replace(/-/g, "").slice(0, 8);
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? -parsed : 10 ** 12;
}

export const isLead = (buyer: BuyerFacts) => buyer.basis !== "stated" && (!buyer.stage || buyer.stage === "Identified");

// --- Interest lines as evidence ----------------------------------------------------------------------------------

/** Best line kind first. Used as the first tie-break after the product tier. */
export const LINE_KIND_RANK: Record<string, number> = {
  bought: 6, ask: 5, standing: 4, saved_search: 3, interest: 2, inferred: 1,
};
const LINE_KIND_LABEL: Record<string, string> = {
  bought: "Bought", ask: "Ask", standing: "Standing want", saved_search: "Saved search", interest: "Interest",
  inferred: "Inferred", declined: "Declined",
};
const LINE_KWH_TOLERANCE = 0.15;
/** `model:kia-ev3` (no kWh suffix) covers every pack size of the model, so the line's own kWh range still has to fit. */
const isModelWideKey = (key: string) => key.startsWith("model:") && !/kwh$/.test(key);

export type FitLine = { line: BuyerLine; tier: number; kindRank: number; recency: number };
export type LineEvidence = {
  /** Tier the best fitting line gives; 0 when none lifts. The product tier is the better of this and today's. */
  tier: number;
  kindRank: number;
  recency: number;
  best: FitLine | null;
  /** Up to two more fitting lines worth naming. */
  also: FitLine[];
  /** A declined line on one of the lot's specific keys. */
  declined: BuyerLine | null;
};
const NO_EVIDENCE: LineEvidence = { tier: 0, kindRank: 0, recency: 0, best: null, also: [], declined: null };

/** The lot line as the facts the product key is built from; the same builder buyer lines were keyed with. */
function supplyProductFacts(supply: SupplyFacts): ProductFacts {
  return {
    partNumbers: supply.partNumber ? [supply.partNumber] : null,
    make: supply.make ?? null, model: supply.model ?? null,
    format: supply.format ?? null, chemistry: supply.chemistry ?? null, cellFormat: supply.cellFormat ?? null,
    kwh: supply.kwh ?? null, kwhMin: supply.kwhMin ?? null, kwhMax: supply.kwhMax ?? null,
  };
}

/** A stated cell format covers another when they are the same, or one is `cylindrical` and the other a round size. */
export function cellFormatFits(wanted: string | null | undefined, lot: string | null | undefined): boolean {
  const a = normalCellFormat(wanted);
  const b = normalCellFormat(lot);
  if (!a || !b || a === b) { return true; }
  return (a === "cylindrical" && CYLINDRICAL_SIZES.includes(b)) || (b === "cylindrical" && CYLINDRICAL_SIZES.includes(a));
}

const isCellLot = (supply: SupplyFacts) => String(supply.format ?? "").toLowerCase().startsWith("cell");

/** The cell formats a lot's keys are built for: its own and what it counts as; a lot that does not state one counts as any. */
function lotCellFormats(supply: SupplyFacts): (CellFormat | null)[] {
  if (!isCellLot(supply)) { return [null]; }
  const own = normalCellFormat(supply.cellFormat ?? null);
  if (!own) { return [null, ...CELL_FORMATS]; }
  if (own === "cylindrical") { return [null, "cylindrical", ...CYLINDRICAL_SIZES]; }
  return [null, own, ...(CYLINDRICAL_SIZES.includes(own) ? ["cylindrical" as const] : [])];
}

/** The cell format a broad key carries (`broad:samsung-sdi-21700-nmc-cells`), or null. */
function keyCellFormat(key: string): CellFormat | null {
  const match = /^broad:(?:.+-)?(18650|21700|26650|32700|4680|cylindrical|prismatic|pouch)-[a-z]+-cells$/.exec(key);
  return match ? (match[1] as CellFormat) : null;
}

type LotKeys = { keys: Set<string>; plainBroad: Set<string> };
const chainCache = new WeakMap<SupplyFacts, LotKeys>();
/**
 * The keys this lot line counts as: its own chain (part, pack, model, cell, make-scoped broad, plain broad), and the
 * broad keys of a buyer who left chemistry or format unstated ("Audi packs", "LFP anything"), because an unstated
 * fact is not a conflict. `plainBroad` are the make-less ones, which are the weakest evidence (tier 1).
 */
function lotKeys(supply: SupplyFacts): LotKeys {
  let found = chainCache.get(supply);
  if (!found) {
    const facts = supplyProductFacts(supply);
    const keys = new Set<string>();
    const plainBroad = new Set<string>();
    for (const cellFormat of lotCellFormats(supply)) {
      for (const variant of [facts, { ...facts, chemistry: null }, { ...facts, format: null }, { ...facts, chemistry: null, format: null }]) {
        const chain = broaderKeysFor({ ...variant, cellFormat });
        for (const key of chain) { keys.add(key); }
        plainBroad.add(chain[chain.length - 1]);
      }
    }
    found = { keys, plainBroad };
    chainCache.set(supply, found);
  }
  return found;
}

const day10 = (value: string | null | undefined) => (value ?? "").slice(0, 10);
const dateNumber = (value: string) => Number(day10(value).replace(/-/g, "")) || 0;

/** A line counts when it has started and has not expired as of the ranking date. */
function lineLive(line: BuyerLine, asOf: string): boolean {
  if (line.firstSeen && day10(line.firstSeen) > asOf) { return false; }
  return !line.expiresOn || day10(line.expiresOn) >= asOf;
}

/** A kWh range on a broad line fits when the lot's capacity is inside it, with today's 15% tolerance. */
function lineKwhFits(line: BuyerLine, supply: SupplyFacts): boolean {
  const lo = line.kwhMin ?? null;
  const hi = line.kwhMax ?? null;
  const range = supplyRange(supply);
  if (!range || (lo == null && hi == null)) { return true; }
  if (lo != null && range[1] < lo * (1 - LINE_KWH_TOLERANCE)) { return false; }
  if (hi != null && range[0] > hi * (1 + LINE_KWH_TOLERANCE)) { return false; }
  return true;
}

/**
 * What the buyer's current lines say about this lot line. A line fits when its key is one the lot counts as
 * (the lot's own key or any broader one); a broad line also needs the lot's kWh inside its range. The tier follows
 * the key level: part 4, pack/model/cell 3, make-scoped broad 2, plain broad 1. A broad `inferred` line is a copy
 * of the generic buy box, so it never lifts a tier or leads the row text.
 */
export function lineEvidence(supply: SupplyFacts, buyer: BuyerFacts, asOf: string): LineEvidence {
  const lines = buyer.lines;
  if (!lines?.length) { return NO_EVIDENCE; }
  const { keys: chain, plainBroad } = lotKeys(supply);
  const fits: FitLine[] = [];
  let declined: BuyerLine | null = null;
  for (const line of lines) {
    if (!lineLive(line, asOf) || !chain.has(line.productKey)) { continue; }
    const level = productKeyLevel(line.productKey);
    if (line.kind === "declined") {
      if (level !== "broad" && (!declined || day10(line.lastSeen) > day10(declined.lastSeen))) { declined = line; }
      continue;
    }
    if ((level === "broad" || isModelWideKey(line.productKey)) && !lineKwhFits(line, supply)) { continue; }
    if (level === "broad" && line.kind === "inferred") { continue; }
    const tier = level === "part" ? 4 : level === "broad" ? (plainBroad.has(line.productKey) ? 1 : 2) : 3;
    fits.push({ line, tier, kindRank: LINE_KIND_RANK[line.kind] ?? 0, recency: dateNumber(line.lastSeen) });
  }
  if (!fits.length && !declined) { return NO_EVIDENCE; }
  fits.sort((a, b) => b.tier - a.tier || b.kindRank - a.kindRank || b.recency - a.recency);
  const best = fits[0] ?? null;
  // A plain broad line (chemistry and format only) says what today's buy box already says, so it can lift an empty
  // tier but does not break ties; only a line that names a make, model, part, pack or cell does. An inferred line
  // is a copy of the buy box and never breaks ties either, so the tie-break reads the best other specific line.
  const breaker = fits.find((fit) => fit.tier >= 2 && fit.line.kind !== "inferred") ?? null;
  return {
    tier: best?.tier ?? 0,
    kindRank: breaker?.kindRank ?? 0,
    recency: breaker?.recency ?? 0,
    best,
    also: fits.slice(1).filter((fit) => fit.tier >= 2).slice(0, 2),
    declined,
  };
}

const OVERRIDE_KINDS = new Set(["bought", "ask", "standing"]);
export type BuyBoxOverride = { rule: RuleOut; line: BuyerLine };

/**
 * A live, specific bought, ask or standing line whose key is the lot's own (part, pack, model or cell, not a broad
 * key) beats a rule-out that only comes from the flat legacy buy box lists: the buyer has shown what they take. It
 * never beats an explicit dossier `rules_out`, which `ruleOut` keeps returning for dossier buyers.
 */
export function buyBoxOverride(supply: SupplyFacts, buyer: BuyerFacts, asOf: string): BuyBoxOverride | null {
  if (!buyer.lines?.length) { return null; }
  const rule = ruleOut(supply, buyer, false, asOf);
  if (!rule?.buyBox) { return null; }
  const own = new Set(broaderKeysFor(supplyProductFacts(supply)).filter((key) => productKeyLevel(key) !== "broad"));
  let found: BuyerLine | null = null;
  for (const line of buyer.lines) {
    if (!OVERRIDE_KINDS.has(line.kind) || !lineLive(line, asOf) || !own.has(line.productKey)) { continue; }
    if (!found || dateNumber(line.lastSeen) > dateNumber(found.lastSeen)) { found = line; }
  }
  return found ? { rule, line: found } : null;
}

/** Rule-out with line overrides applied: the buy box lists are skipped when a line overrides them. */
export function ruleOutWithLines(supply: SupplyFacts, buyer: BuyerFacts, asOf: string): RuleOut | null {
  return buyBoxOverride(supply, buyer, asOf) ? ruleOut(supply, buyer, true, asOf) : ruleOut(supply, buyer, false, asOf);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "16 Jun" in the ranking year, "16 Jun 2025" otherwise. */
export function shortDate(value: string, asOf: string): string {
  const text = day10(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) { return text; }
  const base = `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]}`;
  return match[1] === asOf.slice(0, 4) ? base : `${base} ${match[1]}`;
}

/** "Audi MEB 82 kWh, packs, NMC" from the facts the line stores. */
function lineProduct(line: BuyerLine): string {
  const parts: string[] = [];
  const vehicle = [line.make, line.model].filter(Boolean).join(" ");
  if (vehicle) { parts.push(vehicle); }
  if (line.format) { parts.push(line.format.toLowerCase().replace(/s?$/, "s")); }
  const cellFormat = keyCellFormat(line.productKey);
  if (cellFormat && String(line.format ?? "").toLowerCase().startsWith("cell")) { parts.push(cellFormat); }
  if (line.chemistry) { parts.push(line.chemistry.toUpperCase()); }
  const lo = line.kwhMin ?? null;
  const hi = line.kwhMax ?? null;
  if (lo != null && hi != null) { parts.push(lo === hi ? `${lo} kWh` : `${lo}-${hi} kWh`); }
  else if (lo != null) { parts.push(`${lo}+ kWh`); }
  else if (hi != null) { parts.push(`up to ${hi} kWh`); }
  return parts.length ? parts.join(", ") : line.productKey.replace(/^[a-z]+:/, "").replace(/-/g, " ");
}

const PRICE_UNIT_TEXT: Record<string, string> = { kWh: "/kWh", pack: "/pack", cell: "/cell" };
const CURRENCY_SYMBOL: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

/** A target price reads \"target $30/kWh, flexible to $50\": a target is a wish, never a limit, so the flexible figure is said beside it. */
function linePrice(line: BuyerLine): string[] {
  if (line.price == null || !line.priceCurrency) { return []; }
  const unit = PRICE_UNIT_TEXT[line.priceUnit ?? ""] ?? "";
  if (line.priceBasis !== "target") { return [`${line.priceCurrency} ${line.price.toLocaleString("en-GB")}${unit}`]; }
  const symbol = CURRENCY_SYMBOL[line.priceCurrency] ?? `${line.priceCurrency} `;
  const money = (value: number) => `${symbol}${value.toLocaleString("en-GB")}`;
  const main = `target ${money(line.price)}${unit}`;
  return line.priceMax != null && line.priceMax > line.price ? [main, `flexible to ${money(line.priceMax)}`] : [main];
}

/** One line as one phrase: what, when, and the quantity and price when the line has them. */
export function lineText(line: BuyerLine, asOf: string): string {
  const label = LINE_KIND_LABEL[line.kind] ?? line.kind;
  const product = lineProduct(line);
  const when = line.kind === "saved_search" ? `active since ${shortDate(line.firstSeen, asOf)}` : shortDate(line.lastSeen, asOf);
  const quantity = line.quantity != null && line.quantityUnit ? `${line.quantity} ${line.quantityUnit}` : null;
  return [`${label}: ${product}`, when, quantity, ...linePrice(line)].filter(Boolean).join(", ");
}

/** The row text a line gives: the best specific line, then up to two more. Null when no line fits. */
function lineFits(evidence: LineEvidence, asOf: string, lead: string | null): string | null {
  if (!evidence.best) { return null; }
  // A weaker line than today's tier does not lead the row: today's wording stays first and the line follows as "Also".
  const all = [evidence.best, ...evidence.also].map((fit) => lineText(fit.line, asOf));
  if (lead) { return `${lead}. Also: ${all.slice(0, 2).join("; ")}`; }
  return all.length > 1 ? `${all[0]}. Also: ${all.slice(1).join("; ")}` : all[0];
}

const BOUGHT_VERB: Record<string, string> = { bought: "bought", ask: "asked for", standing: "want" };
const FORMAT_NOUN: Record<string, string> = { packs: "pack", modules: "module", cells: "cell", systems: "system" };
const overrideCheck = (override: BuyBoxOverride, supply: SupplyFacts, asOf: string) => {
  const chem = String(supply.chemistry ?? "").toUpperCase();
  const fmt = String(supply.format ?? "").toLowerCase();
  const noun = FORMAT_NOUN[fmt] ?? fmt ?? "lot";
  const what = [override.rule.code === "chemistry" ? chem : null, noun || "lot"].filter(Boolean).join(" ");
  return `Buy box says ${override.rule.stated} only; they ${BOUGHT_VERB[override.line.kind] ?? override.line.kind} this ${what} on ${shortDate(override.line.lastSeen, asOf)}`;
};

const declinedCheck = (line: BuyerLine, asOf: string) => {
  const product = [line.make, line.model].filter(Boolean).join(" ");
  const reason = line.declineReason?.trim();
  return `Declined${product ? ` ${product}` : ""} on ${shortDate(line.lastSeen, asOf)}${reason ? `: ${reason}` : ""}`;
};

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The A1 ranking: rule out, then order by product tier, price fit, price basis, margin, stage and last contact.
 * Identical to `rank_a1` in scripts/rebattery/match_replay/rules.py, which the replay gate checks.
 */
export function rankA1(supply: SupplyFacts, buyers: BuyerFacts[], asOf: string, top = 30, bodyFallback = true): RankedBuyer[] {
  const ranked: RankedBuyer[] = [];
  for (const buyer of buyers) {
    if (ruleOutWithLines(supply, buyer, asOf)) {
      continue;
    }
    const price = priceKey(supply, buyer);
    const evidence = lineEvidence(supply, buyer, asOf);
    ranked.push({
      companyId: buyer.id, name: buyer.name,
      productTier: Math.max(productTier(supply, buyer, asOf, bodyFallback), evidence.tier),
      lineKind: evidence.kindRank, lineRecency: evidence.recency,
      priceFit: price[0], priceBasis: price[1], priceMargin: price[2], sizeGap: sizeFit(supply, buyer)?.gap ?? 0,
      chemDiffers: !!researchChemDiffers(supply, buyer, asOf),
      stage: buyer.stage, basis: buyer.basis, lastTouch: lastTouch(buyer, asOf), isLead: isLead(buyer),
    });
  }
  ranked.sort((a, b) => b.productTier - a.productTier
    || Number(!!a.chemDiffers) - Number(!!b.chemDiffers)
    || b.priceFit - a.priceFit
    || b.priceBasis - a.priceBasis
    || b.priceMargin - a.priceMargin
    || (a.sizeGap ?? 0) - (b.sizeGap ?? 0)
    || (b.lineKind ?? 0) - (a.lineKind ?? 0)
    || (b.lineRecency ?? 0) - (a.lineRecency ?? 0)
    || (STAGE_RANK[b.stage ?? ""] ?? 0) - (STAGE_RANK[a.stage ?? ""] ?? 0)
    || lastTouchKey(a.lastTouch) - lastTouchKey(b.lastTouch)
    || compareText(a.companyId, b.companyId));
  return ranked.slice(0, top);
}

// --- Production: the product key in, the tab's rows out --------------------------------------------------------

const TIER_LABEL = ["No product match", "Chemistry and format only", "Same make", "Same model or platform", "Same part number"];

/** The same lot as the replay fixtures describe it: one line, lower-case format, flat seller prices. */
export function supplyFactsFromKey(key: ProductKey, listing: { title?: string | null; seller?: string | null; country?: string | null; damagedMixed?: boolean | null; wholeBatch?: boolean | null } = {}): SupplyFacts[] {
  return key.lines.map((line, index) => ({
    title: listing.title ?? null,
    make: line.make, model: line.model, platform: line.platform,
    format: line.format ? line.format.toLowerCase() : null,
    // A disputed chemistry or format must not rule anyone out.
    chemistry: line.unknown.chemistry ? null : line.chemistry,
    kwh: line.unknown.kwh ? null : line.kwh,
    kwhMin: line.unknown.kwh ? null : line.kwhMin,
    kwhMax: line.unknown.kwh ? null : line.kwhMax,
    moduleSeries: line.moduleSeries,
    partNumber: line.partNumber,
    cellFormat: line.format === "Cells" ? line.cellFormat ?? null : null,
    cellModel: line.format === "Cells" ? line.model : null,
    voltageV: key.voltageV ?? null,
    units: line.units ?? (index === 0 ? key.units : null),
    // A seller price orders the list only when it is one firm amount; the key has already enforced that.
    sellerPriceEurPerKwh: key.sellerPrice?.eurPerKwh ?? null,
    sellerPriceEurPerUnit: key.sellerPrice?.eurPerUnit ?? null,
    wholeBatch: listing.wholeBatch ?? (key.lines.length === 1 && key.units != null && (key.units ?? 0) > 1 ? true : null),
    damagedMixed: listing.damagedMixed ?? null,
    seller: listing.seller ?? null,
    country: listing.country ?? null,
  }));
}

const kwhText = (line: ProductLine) =>
  line.kwhMin != null ? `${line.kwhMin}-${line.kwhMax} kWh` : line.kwh != null ? `${Math.round(line.kwh * 100) / 100} kWh` : "capacity unconfirmed";

export type RankedBuyerRow = RankedBuyer & {
  rank: number;
  /** Why this company fits, in one line that cites what was matched. */
  fits: string;
  /** What to check before offering: the gaps that would change the answer. */
  checks: string[];
  priceBand: string | null;
  hasDossier: boolean;
  userVerdict: "shortlist" | "not_a_fit" | null;
};

export type RuledOutRow = {
  companyId: string; name: string; code: string; detail: string; kind: "rule" | "verdict";
  /** The dossier's own words for the rule, and when and where the buyer said it (dated entries only). */
  text?: string; seen?: string; src?: string;
};

/** A research-only buyer in the separate band: never filtered, ordered by fit. */
export type ResearchBuyerRow = {
  companyId: string; name: string; rank: number;
  /** Policy weight of the lot's format over their activities, plus make and chemistry overlap. Always above 0 here. */
  fit: number;
  fits: string;
  checks: string[];
  stage: string | null; basis: string | null; lastTouch: string; isLead: boolean;
  userVerdict: "shortlist" | null;
};

export type RankBuyersResult = {
  ranked: RankedBuyerRow[]; ruledOut: RuledOutRow[]; evaluated: number;
  /** Research-only buyers (no dossier, no live stated Want), after every stated-demand buyer, never interleaved. */
  research: ResearchBuyerRow[]; researchTotal: number;
};

/** What a research-only buyer's site says they do: `profile.activities`, else the older `formats` field. */
function researchActivities(buyer: BuyerFacts): { activities: string[]; legacyFormats: string[] } {
  const activities = list(buyer.profile.activities);
  return { activities, legacyFormats: activities.length ? [] : list(buyer.profile.formats).map((value) => value.toLowerCase()) };
}

const OVERLAP_MODEL = 3;
const OVERLAP_MAKE = 2;
const OVERLAP_CHEMISTRY = 1;

/** Fit of one lot for a research-only buyer. Nothing filters; 0 means no evidence at all. */
function researchFit(supply: SupplyFacts, buyer: BuyerFacts): { fit: number; reasons: string[]; chemDiffers: string[] | null } {
  const { activities, legacyFormats } = researchActivities(buyer);
  const reasons: string[] = [];
  let fit = 0;
  const fmt = String(supply.format ?? "").toLowerCase();
  if (activities.length) {
    const hit = activityFit(activities, fmt);
    if (hit.activity) {
      fit += hit.weight;
      reasons.push(`Research: ${RESEARCH_POLICY[hit.activity].label} (site)`);
    }
  } else if (fmt && legacyFormats.includes(fmt)) {
    fit += STRONG_LEGACY;
    reasons.push(`Research: buys ${fmt} (site)`);
  }
  const supplyModels = [...tokens(supply.model), ...(supply.platform ? [norm(supply.platform)] : [])].filter(Boolean);
  const modelHit = profileModels(buyer).some((model) => supplyModels.length > 0 && supplyModels.some((token) => ` ${norm(model)} `.includes(` ${token} `)));
  const supplyMakes = tokens(supply.make).filter((token) => token !== "group");
  const makeHit = [...list(buyer.profile.makes), ...list(buyer.profile.cell_makers)]
    .find((make) => supplyMakes.some((token) => ` ${norm(make)} `.includes(` ${token} `)));
  if (modelHit) {
    fit += OVERLAP_MODEL;
    reasons.push(`names ${supply.model ?? supply.platform}`);
  } else if (makeHit) {
    fit += OVERLAP_MAKE;
    reasons.push(`works on ${makeHit}`);
  }
  const chem = String(supply.chemistry ?? "").toUpperCase();
  const stated = list(buyer.profile.chemistries).map((value) => value.toUpperCase());
  if (chem && stated.includes(chem)) {
    fit += OVERLAP_CHEMISTRY;
    reasons.push(chem);
  }
  const differs = chem && stated.length && !stated.includes(chem) ? stated : null;
  return { fit, reasons, chemDiffers: differs };
}
const STRONG_LEGACY = 3;

function priceBand(key: ProductKey, supply: SupplyFacts, buyer: BuyerFacts): string | null {
  const row = dossierPrice(buyer);
  if (!row) {
    return null;
  }
  const sellerKwh = supply.sellerPriceEurPerKwh;
  const sellerUnit = supply.sellerPriceEurPerUnit;
  const buyerKwh = typeof row.eur_per_kwh === "number" ? row.eur_per_kwh : null;
  const buyerUnit = typeof row.eur_per_unit === "number" ? row.eur_per_unit : null;
  if (buyerKwh != null && sellerKwh != null) {
    const pct = Math.round(((buyerKwh - sellerKwh) / sellerKwh) * 100);
    return `${sellerKwh.toFixed(0)}/kWh against their ${buyerKwh.toFixed(0)}/kWh (${pct >= 0 ? "+" : ""}${pct}%)`;
  }
  if (buyerUnit != null && sellerUnit != null) {
    const pct = Math.round(((buyerUnit - sellerUnit) / sellerUnit) * 100);
    return `${sellerUnit.toFixed(0)}/unit against their ${buyerUnit.toFixed(0)} (${pct >= 0 ? "+" : ""}${pct}%)`;
  }
  if (buyerKwh != null || buyerUnit != null) {
    return key.sellerPrice ? "They state a price; the seller's price cannot be compared" : "No firm seller price, so no margin";
  }
  return null;
}

/** Cell formats the buyer's live lines and dossier products ask for, which a lot that does not state one cannot confirm. */
function wantedCellFormats(supply: SupplyFacts, buyer: BuyerFacts, asOf: string): CellFormat[] {
  if (!isCellLot(supply) || normalCellFormat(supply.cellFormat ?? null)) { return []; }
  const wanted = new Set<CellFormat>();
  const { keys } = lotKeys(supply);
  for (const line of buyer.lines ?? []) {
    if (line.kind === "declined" || line.kind === "inferred" || !lineLive(line, asOf) || !keys.has(line.productKey)) { continue; }
    const cellFormat = keyCellFormat(line.productKey);
    if (cellFormat) { wanted.add(cellFormat); }
  }
  for (const product of dossierProducts(buyer)) {
    if (!String(product.format ?? "").toLowerCase().startsWith("cell")) { continue; }
    const cellFormat = normalCellFormat(typeof product.cell_format === "string" ? product.cell_format : null);
    if (cellFormat) { wanted.add(cellFormat); }
  }
  return [...wanted].toSorted((a, b) => a.localeCompare(b));
}

function checksFor(key: ProductKey, line: ProductLine, supply: SupplyFacts, buyer: BuyerFacts): string[] {
  const checks: string[] = [];
  if (line.unknown.kwh || supply.kwh == null) {
    checks.push(key.notes.find((note) => /total/i.test(note)) ?? "Capacity per unit is unconfirmed");
  }
  if (line.unknown.format && !line.format) {
    checks.push("Format is not stated");
  }
  if (line.unknown.chemistry && !key.chemistry) {
    checks.push(key.chemistries.length > 1 ? `Lot mixes chemistries (${key.chemistries.join(", ")})` : "Chemistry is not stated");
  }
  if (!key.sellerPrice) {
    checks.push(key.priceNote ?? "No firm seller price");
  }
  if (!buyer.lastTouch) {
    checks.push("No contact yet");
  }
  else if (lastDays(buyer.lastTouch) > 120) {
    checks.push(`Last contact ${buyer.lastTouch.slice(0, 10)}`);
  }
  if (buyer.dossier && !dossierPrice(buyer)) {
    checks.push("No price on their dossier");
  }
  const minV = minPackVoltage(buyer);
  if (minV && voltageApplies(supply) && supply.voltageV == null) {
    checks.push(`Voltage not stated; they need at least ${minV.value} V`);
  }
  return checks;
}

const lastDays = (value: string) => Math.round((Date.now() - new Date(value).getTime()) / 86_400_000);

/**
 * The tab's recommended buyers: the best-fitting product line decides each company's tier, verdicts order and
 * hide, and every ruled-out company comes back with its reason.
 */
export function rankBuyers(supplies: SupplyFacts[], buyers: BuyerFacts[], options: {
  asOf?: string;
  top?: number;
  researchTop?: number;
  verdicts?: Map<string, "shortlist" | "not_a_fit">;
  key?: ProductKey;
} = {}): RankBuyersResult {
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const verdicts = options.verdicts ?? new Map<string, "shortlist" | "not_a_fit">();
  const rows = new Map<string, RankedBuyerRow>();
  const ruledOut: RuledOutRow[] = [];
  const researchRows: Omit<ResearchBuyerRow, "rank">[] = [];
  let evaluated = 0;

  for (const buyer of buyers) {
    evaluated += 1;
    const verdict = verdicts.get(buyer.id) ?? null;
    if (verdict === "not_a_fit") {
      ruledOut.push({ companyId: buyer.id, name: buyer.name, code: "not_a_fit", detail: "Marked not a fit", kind: "verdict" });
      continue;
    }
    if (researchOnly(buyer, asOf)) {
      // Inferred demand ranks, it never filters; only the seller's own company is left out.
      if (supplies.some((supply) => norm(supply.seller) && norm(buyer.name) === norm(supply.seller))) {
        continue;
      }
      let top: ReturnType<typeof researchFit> | null = null;
      for (const supply of supplies) {
        const found = researchFit(supply, buyer);
        if (!top || found.fit > top.fit) { top = found; }
      }
      if (top && top.fit > 0) {
        const fits = top.reasons.join("; ");
        researchRows.push({
          companyId: buyer.id, name: buyer.name, fit: top.fit,
          fits: top.chemDiffers ? `${fits}; Chemistry differs: their site lists ${top.chemDiffers.join("/")}` : fits,
          checks: top.chemDiffers ? [`Chemistry differs: their site lists ${top.chemDiffers.join("/")}`] : [],
          stage: buyer.stage, basis: buyer.basis, lastTouch: lastTouch(buyer, asOf), isLead: isLead(buyer),
          userVerdict: verdict === "shortlist" ? "shortlist" : null,
        });
      }
      continue;
    }
    let best: { row: RankedBuyer; line: number } | null = null;
    let lastRule: RuleOut | null = null;
    for (let index = 0; index < supplies.length; index += 1) {
      const supply = supplies[index];
      const out = ruleOutWithLines(supply, buyer, asOf);
      if (out) { lastRule = out; continue; }
      const price = priceKey(supply, buyer);
      const evidence = lineEvidence(supply, buyer, asOf);
      const candidate: RankedBuyer = {
        companyId: buyer.id, name: buyer.name,
        productTier: Math.max(productTier(supply, buyer, asOf), evidence.tier),
        lineKind: evidence.kindRank, lineRecency: evidence.recency,
        priceFit: price[0], priceBasis: price[1], priceMargin: price[2], sizeGap: sizeFit(supply, buyer)?.gap ?? 0,
        chemDiffers: !!researchChemDiffers(supply, buyer, asOf),
        stage: buyer.stage, basis: buyer.basis, lastTouch: lastTouch(buyer, asOf), isLead: isLead(buyer),
      };
      if (!best || (candidate.productTier - best.row.productTier
        || Number(!!best.row.chemDiffers) - Number(!!candidate.chemDiffers)
        || candidate.priceFit - best.row.priceFit
        || candidate.priceMargin - best.row.priceMargin
        || (best.row.sizeGap ?? 0) - (candidate.sizeGap ?? 0)
        || (candidate.lineKind ?? 0) - (best.row.lineKind ?? 0)
        || (candidate.lineRecency ?? 0) - (best.row.lineRecency ?? 0)) > 0) {
        best = { row: candidate, line: index };
      }
    }
    if (!best) {
      const rule: RuleOut | null = lastRule;
      if (rule) {
        ruledOut.push({
          companyId: buyer.id, name: buyer.name, code: rule.code, detail: rule.detail, kind: "rule",
          ...(rule.text ? { text: rule.text } : {}), ...(rule.seen ? { seen: rule.seen } : {}), ...(rule.src ? { src: rule.src } : {}),
        });
      }
      continue;
    }
    const line = (options.key?.lines[best.line] ?? null);
    const supply = supplies[best.line];
    const size = supply.kwhMin != null ? `${supply.kwhMin}-${supply.kwhMax} kWh` : supply.kwh != null ? `${Math.round(supply.kwh * 100) / 100} kWh` : "";
    const product = [line ? kwhText(line) : size, supply.format, supply.chemistry ? supply.chemistry.toUpperCase() : null].filter(Boolean).join(" ");
    const evidence = lineEvidence(supply, buyer, asOf);
    const today = [TIER_LABEL[best.row.productTier], product].filter(Boolean).join(": ");
    const todayTier = productTier(supply, buyer, asOf);
    // The line leads the row when it names something specific or lifts the tier; otherwise today's wording stays.
    const lineLeads = !!evidence.best && (evidence.best.tier >= 2 || evidence.best.tier > todayTier);
    const siteChem = researchChemDiffers(supply, buyer, asOf);
    const chemNote = siteChem ? `Chemistry differs: their site lists ${siteChem.join("/")}` : null;
    const tierText = chemNote && best.row.productTier === 1 ? `${chemNote}: ${product}` : today;
    const fits = lineLeads ? lineFits(evidence, asOf, evidence.tier >= todayTier ? null : today) ?? today : tierText;
    const checks = line && options.key ? checksFor(options.key, line, supply, buyer) : checksFor(options.key ?? emptyKey(), emptyLine(), supply, buyer);
    if (chemNote && best.row.productTier !== 1) { checks.push(chemNote); }
    const unstated = wantedCellFormats(supply, buyer, asOf);
    if (unstated.length) { checks.push(`Cell format not stated; they need ${unstated.join(" or ")}`); }
    const sizeNote = sizeFit(supply, buyer)?.note;
    if (sizeNote) { checks.push(sizeNote); }
    const override = buyBoxOverride(supplies[best.line], buyer, asOf);
    if (override) { checks.push(overrideCheck(override, supplies[best.line], asOf)); }
    if (evidence.declined) { checks.push(declinedCheck(evidence.declined, asOf)); }
    rows.set(buyer.id, {
      ...best.row,
      rank: 0,
      fits,
      checks,
      priceBand: options.key ? priceBand(options.key, supply, buyer) : null,
      hasDossier: hasDossier(buyer),
      userVerdict: verdict,
    });
  }

  const ordered = [...rows.values()].toSorted((a, b) =>
    Number(b.userVerdict === "shortlist") - Number(a.userVerdict === "shortlist")
    || b.productTier - a.productTier
    || Number(!!a.chemDiffers) - Number(!!b.chemDiffers)
    || b.priceFit - a.priceFit
    || b.priceBasis - a.priceBasis
    || b.priceMargin - a.priceMargin
    || (a.sizeGap ?? 0) - (b.sizeGap ?? 0)
    || (b.lineKind ?? 0) - (a.lineKind ?? 0)
    || (b.lineRecency ?? 0) - (a.lineRecency ?? 0)
    || (STAGE_RANK[b.stage ?? ""] ?? 0) - (STAGE_RANK[a.stage ?? ""] ?? 0)
    || lastTouchKey(a.lastTouch) - lastTouchKey(b.lastTouch)
    || compareText(a.companyId, b.companyId));
  const top = options.top ?? 30;
  const researchOrdered = researchRows.toSorted((a, b) =>
    Number(b.userVerdict === "shortlist") - Number(a.userVerdict === "shortlist")
    || b.fit - a.fit
    || (STAGE_RANK[b.stage ?? ""] ?? 0) - (STAGE_RANK[a.stage ?? ""] ?? 0)
    || lastTouchKey(a.lastTouch) - lastTouchKey(b.lastTouch)
    || compareText(a.companyId, b.companyId));
  return {
    ranked: ordered.slice(0, top).map((row, index) => ({ ...row, rank: index + 1 })),
    ruledOut,
    evaluated,
    research: researchOrdered.slice(0, options.researchTop ?? 50).map((row, index) => ({ ...row, rank: index + 1 })),
    researchTotal: researchOrdered.length,
  };
}

const emptyKey = (): ProductKey => ({
  lines: [], mixed: false, units: null, partNumbers: [], chemistries: [], format: null, chemistry: null,
  sellerPrice: null, voltageV: null, priceNote: null, conflicts: [], notes: [],
  source: { model: null, capacity: null, chemistry: null, format: null, quantity: null, title: null },
});

const emptyLine = (): ProductLine => ({
  format: null, chemistry: null, kwh: null, kwhMin: null, kwhMax: null, units: null, partNumber: null,
  make: null, makeGroup: null, model: null, platform: null, moduleSeries: null,
  unknown: { kwh: true, format: true, chemistry: true }, basis: null,
});

export type { KeyFormat };
