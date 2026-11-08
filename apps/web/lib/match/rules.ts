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
};

export type RankedBuyer = {
  companyId: string;
  name: string;
  productTier: number;
  priceFit: number;
  priceBasis: number;
  priceMargin: number;
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
  const earlyTier1 = (chemOk && fmtOk)
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

function withinProfileKwh(supply: SupplyFacts, buyer: BuyerFacts, tolerance: number): boolean {
  const profile = buyer.profile;
  const lo = typeof profile.kwh_min === "number" ? profile.kwh_min : null;
  const hi = typeof profile.kwh_max === "number" ? profile.kwh_max : null;
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

export type RuleOut = { code: string; detail: string };

/** Why this buyer is ruled out of this lot, or null. Only a conflict both sides state rules anyone out. */
export function ruleOut(supply: SupplyFacts, buyer: BuyerFacts): RuleOut | null {
  const isDossier = hasDossier(buyer);
  const rules = isDossier ? dossierRules(buyer) : {};
  const profile = buyer.profile;
  const chem = String(supply.chemistry ?? "").toUpperCase();
  const fmt = String(supply.format ?? "").toLowerCase();

  if (isDossier) {
    const ruled = ruleValues(rules.chemistries).map((value) => value.toUpperCase());
    if (chem && ruled.includes(chem)) {
      return { code: "chemistry", detail: `rules_out.chemistries includes ${chem}` };
    }
    const ruledFormats = ruleValues(rules.formats).map((value) => value.toLowerCase());
    if (fmt && ruledFormats.includes(fmt)) {
      return { code: "format", detail: `rules_out.formats includes ${fmt}` };
    }
  } else {
    const stated = list(profile.chemistries).map((value) => value.toUpperCase());
    if (chem && stated.length && !stated.includes(chem)) {
      return { code: "chemistry", detail: `buy profile chemistries are ${stated.join("/")}` };
    }
    const statedFormats = list(profile.formats).map((value) => value.toLowerCase());
    if (fmt && statedFormats.length && !statedFormats.includes(fmt)) {
      return { code: "format", detail: `buy profile formats are ${statedFormats.join("/")}` };
    }
  }

  // A platform is only a conflict when the buyer explicitly refuses it.
  if (isDossier && supply.platform) {
    for (const phrase of ruleValues(rules.other)) {
      const text = norm(phrase);
      if (platformMatch(supply.platform, phrase) || ` ${text} `.includes(` ${norm(supply.platform)} `)) {
        if (["will not accept", "not interchangeable", "not acceptable", "refuses"].some((word) => text.includes(word))) {
          return { code: "platform", detail: `rules_out.other: ${phrase}` };
        }
      }
    }
  }

  // Capacity: only for packs and modules, and only when the buyer states a capacity on the same format.
  // A same-platform capacity difference is a substitution candidate, not a conflict.
  const range = supplyRange(supply);
  if (range && (fmt === "packs" || fmt === "modules")) {
    if (isDossier) {
      const products = dossierProducts(buyer).filter((product) => String(product.format ?? "").toLowerCase() === fmt
        && (productKwhValues(product).length > 0 || productKwhRange(product)));
      const samePlatform = dossierProducts(buyer).some((product) => supply.platform && product.platform && platformMatch(supply.platform, product.platform));
      if (products.length && !samePlatform) {
        let tolerance = 0.15;
        const substitution = frontmatter(buyer).substitution;
        if (substitution && typeof substitution === "object" && typeof (substitution as Record<string, unknown>).kwh_tolerance === "number") {
          tolerance = (substitution as Record<string, unknown>).kwh_tolerance as number;
        }
        let best = Number.POSITIVE_INFINITY;
        for (const product of products) {
          const productRange = productKwhRange(product);
          const values = productKwhValues(product);
          if (productRange) {
            best = Math.min(best, gapBetween(range[0], range[1], productRange[0], productRange[1]));
          }
          for (const value of values) {
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
      const stated = typeof profile.kwh_min === "number" || typeof profile.kwh_max === "number";
      if (stated && !withinProfileKwh(supply, buyer, 0.15)) {
        const shown = supply.kwhMin != null && supply.kwhMax != null ? `${supply.kwhMin}-${supply.kwhMax}` : `${range[0]}`;
        return { code: "kwh", detail: `buy profile kWh bounds exclude ${shown} kWh` };
      }
    }
  }

  if (isDossier && supply.damagedMixed && rules.damaged === true) {
    return { code: "damaged", detail: "buyer will not take damaged stock" };
  }
  if (fmt === "systems") {
    if (isDossier && rules.bess_systems === true) {
      return { code: "bess", detail: "buyer will not take containerised/stationary systems" };
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

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The A1 ranking: rule out, then order by product tier, price fit, price basis, margin, stage and last contact.
 * Identical to `rank_a1` in scripts/rebattery/match_replay/rules.py, which the replay gate checks.
 */
export function rankA1(supply: SupplyFacts, buyers: BuyerFacts[], asOf: string, top = 30, bodyFallback = true): RankedBuyer[] {
  const ranked: RankedBuyer[] = [];
  for (const buyer of buyers) {
    if (ruleOut(supply, buyer)) {
      continue;
    }
    const price = priceKey(supply, buyer);
    ranked.push({
      companyId: buyer.id, name: buyer.name,
      productTier: productTier(supply, buyer, asOf, bodyFallback),
      priceFit: price[0], priceBasis: price[1], priceMargin: price[2],
      stage: buyer.stage, basis: buyer.basis, lastTouch: lastTouch(buyer, asOf), isLead: isLead(buyer),
    });
  }
  ranked.sort((a, b) => b.productTier - a.productTier
    || b.priceFit - a.priceFit
    || b.priceBasis - a.priceBasis
    || b.priceMargin - a.priceMargin
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

export type RuledOutRow = { companyId: string; name: string; code: string; detail: string; kind: "rule" | "verdict" };

export type RankBuyersResult = { ranked: RankedBuyerRow[]; ruledOut: RuledOutRow[]; evaluated: number };

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
  verdicts?: Map<string, "shortlist" | "not_a_fit">;
  key?: ProductKey;
} = {}): RankBuyersResult {
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const verdicts = options.verdicts ?? new Map<string, "shortlist" | "not_a_fit">();
  const rows = new Map<string, RankedBuyerRow>();
  const ruledOut: RuledOutRow[] = [];
  let evaluated = 0;

  for (const buyer of buyers) {
    evaluated += 1;
    const verdict = verdicts.get(buyer.id) ?? null;
    if (verdict === "not_a_fit") {
      ruledOut.push({ companyId: buyer.id, name: buyer.name, code: "not_a_fit", detail: "Marked not a fit", kind: "verdict" });
      continue;
    }
    let best: { row: RankedBuyer; line: number } | null = null;
    let lastRule: RuleOut | null = null;
    for (let index = 0; index < supplies.length; index += 1) {
      const supply = supplies[index];
      const out = ruleOut(supply, buyer);
      if (out) { lastRule = out; continue; }
      const price = priceKey(supply, buyer);
      const candidate: RankedBuyer = {
        companyId: buyer.id, name: buyer.name,
        productTier: productTier(supply, buyer, asOf), priceFit: price[0], priceBasis: price[1], priceMargin: price[2],
        stage: buyer.stage, basis: buyer.basis, lastTouch: lastTouch(buyer, asOf), isLead: isLead(buyer),
      };
      if (!best || candidate.productTier > best.row.productTier
        || (candidate.productTier === best.row.productTier && candidate.priceFit > best.row.priceFit)
        || (candidate.productTier === best.row.productTier && candidate.priceFit === best.row.priceFit && candidate.priceMargin > best.row.priceMargin)) {
        best = { row: candidate, line: index };
      }
    }
    if (!best) {
      const rule: RuleOut | null = lastRule;
      if (rule) {
        ruledOut.push({ companyId: buyer.id, name: buyer.name, code: rule.code, detail: rule.detail, kind: "rule" });
      }
      continue;
    }
    const line = (options.key?.lines[best.line] ?? null);
    const supply = supplies[best.line];
    const size = supply.kwhMin != null ? `${supply.kwhMin}-${supply.kwhMax} kWh` : supply.kwh != null ? `${Math.round(supply.kwh * 100) / 100} kWh` : "";
    const product = [line ? kwhText(line) : size, supply.format, supply.chemistry ? supply.chemistry.toUpperCase() : null].filter(Boolean).join(" ");
    const fits = [TIER_LABEL[best.row.productTier], product].filter(Boolean).join(": ");
    rows.set(buyer.id, {
      ...best.row,
      rank: 0,
      fits,
      checks: line && options.key ? checksFor(options.key, line, supply, buyer) : checksFor(options.key ?? emptyKey(), emptyLine(), supply, buyer),
      priceBand: options.key ? priceBand(options.key, supply, buyer) : null,
      hasDossier: hasDossier(buyer),
      userVerdict: verdict,
    });
  }

  const ordered = [...rows.values()].toSorted((a, b) =>
    Number(b.userVerdict === "shortlist") - Number(a.userVerdict === "shortlist")
    || b.productTier - a.productTier
    || b.priceFit - a.priceFit
    || b.priceBasis - a.priceBasis
    || b.priceMargin - a.priceMargin
    || (STAGE_RANK[b.stage ?? ""] ?? 0) - (STAGE_RANK[a.stage ?? ""] ?? 0)
    || lastTouchKey(a.lastTouch) - lastTouchKey(b.lastTouch)
    || compareText(a.companyId, b.companyId));
  const top = options.top ?? 30;
  return {
    ranked: ordered.slice(0, top).map((row, index) => ({ ...row, rank: index + 1 })),
    ruledOut,
    evaluated,
  };
}

const emptyKey = (): ProductKey => ({
  lines: [], mixed: false, units: null, partNumbers: [], chemistries: [], format: null, chemistry: null,
  sellerPrice: null, priceNote: null, conflicts: [], notes: [],
  source: { model: null, capacity: null, chemistry: null, format: null, quantity: null, title: null },
});

const emptyLine = (): ProductLine => ({
  format: null, chemistry: null, kwh: null, kwhMin: null, kwhMax: null, units: null, partNumber: null,
  make: null, makeGroup: null, model: null, platform: null, moduleSeries: null,
  unknown: { kwh: true, format: true, chemistry: true }, basis: null,
});

export type { KeyFormat };
