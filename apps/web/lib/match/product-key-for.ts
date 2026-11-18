/**
 * One product key shared by supply and buyer interests.
 *
 * The most specific level the facts prove wins, never a guess:
 *   1. OEM part number                    part:SU001B5189
 *   2. pack family (battery graph pack_key, else the reviewed list)   pack:stellantis-ecmp-50kwh
 *   3. make + model + one kWh figure      model:hyundai-ioniq5-77.4kwh
 *      make + model, no single kWh figure   model:kia-ev3   (every pack size of the model; a lot of any size rolls up to it)
 *   4. cell maker + cell model            cell:samsung-sdi-inr21700-50e
 *   5. chemistry + format                 broad:lfp-packs
 *      with a stated make and nothing more specific:   broad:stellantis-nmc-packs
 *
 * A specific key also counts as its broader keys: `broaderKeysFor` returns the chain so a seller part
 * matches a buyer's broad ask. Key shapes are mirrored in SQL by buyer_interest_product_key() (migration
 * 112) so synced lines agree with keys the app computes; the buyer-interest database test compares the two.
 *
 * A source that states several makes, chemistries or formats is never reduced to its first value:
 * `expandProductFacts` returns one fact set per combination (capped), exactly as buyer_interest_fact_sets()
 * does in SQL, so a two-make, two-chemistry ask keeps four wants.
 */
import {
  chemistryFamilies,
  fold,

  normalKwh,
  normalMake,
  normalModel,
  partKey,
} from "@/lib/commercial-stock";
import { MODEL_ALIAS_ROWS, MODEL_BRAND_WORDS, MODEL_MAKE_ALIASES, MODEL_VARIANT_WORDS } from "./model-aliases.generated";
import { PACK_FAMILIES, type PackFamily } from "./pack-families";

export type ProductFacts = {
  /** OEM part numbers as written on the listing or the ask. */
  partNumbers?: (string | null | undefined)[] | string | null;
  /** Battery graph pack key (`fam:…`, `evdb:…`), when the source has one. */
  packKey?: string | null;
  make?: string | null;
  model?: string | null;
  /** pack, module, cell or system (single or plural). */
  format?: string | null;
  chemistry?: string | null;
  /** One kWh figure, when the source states one (a pack's capacity). */
  kwh?: number | null;
  /** A stated range; a range on its own is not a model key. */
  kwhMin?: number | null;
  kwhMax?: number | null;
  cellMaker?: string | null;
  /** Every make a source states, for `expandProductFacts`; `make` stays the single-value form. */
  makes?: (string | null | undefined)[] | null;
  chemistries?: (string | null | undefined)[] | null;
  formats?: (string | null | undefined)[] | null;
  /** A cell's form factor (18650, 21700, pouch, ...); only a cell key uses it. */
  cellFormat?: string | null;
  cellFormats?: (string | null | undefined)[] | null;
  /** Chemistries a source listed beside several makes without pairing them (kept as a preference, never crossed). */
  chemistryPreference?: string | null;
};

export type ProductKeyLevel = "part" | "pack" | "model" | "cell" | "broad";

export type ProductKey = { key: string; level: ProductKeyLevel };

const FORMAT_PLURAL: Record<string, string> = { pack: "packs", module: "modules", cell: "cells", system: "systems" };

/** Lines a single source may hold. A longer list is truncated and reported, never silently dropped. */
export const PRODUCT_FACT_COMBINATIONS = 12;

/** Group and alias names the key keeps whole, mirroring buyer_interest_make() in SQL. */
const MAKE_KEY_ALIASES: Record<string, string> = {
  vw: "volkswagen", volkswagen: "volkswagen", vwag: "volkswagen", volkwagen: "volkswagen",
  mercedes: "mercedes-benz", mercedesbenz: "mercedes-benz", mb: "mercedes-benz",
  citroen: "citroen", skoda: "skoda",
  vwgroup: "vw-group", volkswagengroup: "vw-group",
  hyundaiorkia: "hyundai-or-kia", bmwormini: "bmw-or-mini", mgorsaic: "mg-or-saic",
  volvoorpolestar: "volvo-or-polestar", toyotaorlexus: "toyota-or-lexus",
  jlr: "jlr", jaguarlandrover: "jlr", gm: "gm", stellantis: "stellantis",
};

/** Lower case, runs of anything else become one hyphen. Mirrors buyer_interest_slug() in SQL. */
function slug(value: string | null | undefined): string | null {
  const text = (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || null;
}

/** The make segment of a model key: alias first, then the display name normalMake gives, then the raw slug. */
export function makeKey(value: string | null | undefined): string | null {
  const folded = (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return MAKE_KEY_ALIASES[folded] ?? slug(normalMake(value ?? null)) ?? slug(value);
}

/**
 * Every make a value states: "BMW / Volvo" and "MG, Stellantis, Tesla" are three makes, not one slugged phrase.
 * A group name with "or" stays whole ("Hyundai or Kia", "BMW or Mini"), because that is one demand.
 * Mirrors buyer_interest_make_list() in SQL.
 */
export function splitMakes(values: (string | null | undefined)[] | null | undefined): string[] {
  const makes = new Set<string>();
  for (const value of values ?? []) {
    for (const piece of String(value ?? "").split(/\s*(?:,|\/|&|\band\b)\s*/i)) {
      const make = piece.trim();
      if (make) {makes.add(make);}
    }
  }
  return [...makes].toSorted((a, b) => a.localeCompare(b));
}

/**
 * A model value that lists vehicles or years instead of naming one model: "hybrid 2015-2022 (225xe, 330e)",
 * "82 kWh: ID.4, Q4 e-tron, Enyaq". Such prose never enters a key; the line falls back to its make-level key and
 * the text is kept on the line. Mirrors buyer_interest_prose_model() in SQL.
 */
export function isProseModel(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) {return false;}
  return /[(),;/:]/.test(text) || text.split(/\s+/).length >= 4 || /\b(?:19|20)\d{2}\b/.test(text);
}

/**
 * A part number written inside the model text ("Toyota Proace SU001B5189"): a token with letters and digits, 8+ code
 * characters, that is not a capacity ("1000kWh"). Mirrors buyer_interest_model_part_token() in SQL (migration 120).
 */
export function modelPartToken(value: string | null | undefined): string | null {
  const tokens = (value ?? "").trim().split(/\s+/).filter((token) => token.length > 0 && partKey(token).length >= 8
    && /[A-Za-z]/.test(token) && /[0-9]/.test(token) && !/(kwh|ah)$/i.test(token));
  return tokens.toSorted()[0] ?? null;
}

/** The model text without a part number written in it. Mirrors buyer_interest_strip_model_part() in SQL. */
function stripModelPart(value: string | null | undefined): string {
  const part = modelPartToken(value);
  return (value ?? "").trim().split(/\s+/).filter((token) => token !== part).join(" ");
}

/** The model without a capacity the facts already state: "Zoe 41 kWh" is the Zoe, keyed by its 41 kWh. */
export function modelKeyText(value: string | null | undefined): string | null {
  const text = stripModelPart(value).replace(/\b\d+(?:\.\d+)?\s*kwh\b/gi, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

/** One decimal, never a trailing .0. Mirrors buyer_interest_kwh_text() in SQL. */
export function kwhKeyText(value: number | null | undefined): string | null {
  const kwh = normalKwh(value ?? null);
  return kwh === null ? null : String(Math.round(kwh * 10) / 10);
}

function partList(facts: ProductFacts): string[] {
  const values = typeof facts.partNumbers === "string" ? [facts.partNumbers] : facts.partNumbers ?? [];
  const parts = values.map((part) => partKey(part)).filter((part) => part.length > 0);
  if (parts.length) {return parts;}
  // No stated part number: one written inside the model text is still the part ("Toyota Proace SU001B5189").
  const inModel = facts.cellMaker ? "" : partKey(modelPartToken(facts.model ?? null));  // a cell model is not a part
  return inModel ? [inModel] : [];
}

function singleKwh(facts: ProductFacts): number | null {
  const stated = normalKwh(facts.kwh ?? null);
  if (stated !== null) {return stated;}
  const min = normalKwh(facts.kwhMin ?? null);
  const max = normalKwh(facts.kwhMax ?? null);
  return min !== null && min === max ? min : null;
}

function formatOf(facts: ProductFacts): string | null {
  const text = (facts.format ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (text.startsWith("pack")) {return "pack";}
  if (text.startsWith("module")) {return "module";}
  if (text.startsWith("cell")) {return "cell";}
  if (text.startsWith("system")) {return "system";}
  return null;
}

/** Cell form factors a key can carry. Mirrors buyer_interest_cell_format() in SQL. */
export const CELL_FORMATS = ["18650", "21700", "26650", "32700", "4680", "cylindrical", "prismatic", "pouch"] as const;
export type CellFormat = (typeof CELL_FORMATS)[number];
/** The round formats a "cylindrical" cell can be. */
export const CYLINDRICAL_SIZES: readonly CellFormat[] = ["18650", "21700", "26650", "32700", "4680"];

const SIZE_TOKEN = /(?<![0-9])(18650|21700|2170|26650|32700|4680)(?![0-9])/g;
const QUANTITY_AFTER = /^\s*(?:pcs?\b|pieces?\b|units?\b|x\b|qty\b|off\b)/;
const QUANTITY_BEFORE = /(?:\bqty|\bx|\bquantity)[\s:]*$/;
const CELL_AFTER = /^[\s,:;-]*(?:li-?ion\s+|lithium\s+)?cells?\b/;
const CELL_BEFORE = /\bcells?[\s,:;(-]*$/;

/**
 * A cell form factor from a structured value (cell_format, format, model) or, with `inText`, from free text
 * (title, capacity): there a size counts only next to the word cell/cells ("21700 cells"). A number followed by
 * pcs/units/x/qty is a count, not a size, and two different sizes make the format unknown. Mirrors
 * buyer_interest_cell_format() in SQL.
 */
export function normalCellFormat(value: string | null | undefined, inText = false): CellFormat | null {
  const text = (value ?? "").toLowerCase();
  const sizes = new Set<CellFormat>();
  for (const match of text.matchAll(SIZE_TOKEN)) {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    if (QUANTITY_AFTER.test(after) || QUANTITY_BEFORE.test(before)) {continue;}
    if (inText && !CELL_AFTER.test(after) && !CELL_BEFORE.test(before)) {continue;}
    sizes.add(match[1] === "2170" ? "21700" : match[1] as CellFormat);
  }
  if (sizes.size > 1) {return null;}
  if (sizes.size === 1) {return [...sizes][0];}
  const distinct = [...text.matchAll(SIZE_TOKEN)].filter((m) => !QUANTITY_AFTER.test(text.slice(m.index + m[0].length)));
  if (new Set(distinct.map((m) => m[1] === "2170" ? "21700" : m[1])).size > 1) {return null;}
  if (/\bprismatic\b/.test(text)) {return "prismatic";}
  if (/\bpouch\b/.test(text)) {return "pouch";}
  if (/\b(?:cylindrical|round)\b/.test(text)) {return "cylindrical";}
  return null;
}

/** The cell format a key carries: only for a cell fact. */
function cellFormatOf(facts: ProductFacts): CellFormat | null {
  return formatOf(facts) === "cell" ? normalCellFormat(facts.cellFormat ?? null) : null;
}

function chemistryOf(facts: ProductFacts): string | null {
  return chemistryFamilies(facts.chemistry ?? null)[0] ?? null;
}

/** The reviewed family for these facts: by part number first, then make + model prefix + stated kWh. */
export function packFamilyFor(facts: ProductFacts): PackFamily | null {
  const parts = new Set(partList(facts));
  if (parts.size) {
    const byPart = PACK_FAMILIES.find((family) => family.partNumbers.some((part) => parts.has(partKey(part))));
    if (byPart) {return byPart;}
  }
  const makes = new Set([facts.make, normalMake(facts.make ?? null)].filter((value): value is string => Boolean(value)));
  const model = fold(normalModel(facts.make ?? null, facts.model ?? null) ?? facts.model ?? null);
  if (!makes.size || !model) {return null;}
  const kwh = singleKwh(facts);
  const min = normalKwh(facts.kwhMin ?? null);
  const max = normalKwh(facts.kwhMax ?? null);
  const capacityFits = (value: number) => kwh !== null ? Math.abs(value - kwh) <= 1.5
    : min !== null && max !== null ? value >= min - 1 && value <= max + 1 : true;
  return PACK_FAMILIES.find((family) => family.makes.some((name) => makes.has(name))
    && family.modelPrefixes.some((prefix) => model.startsWith(prefix))
    && family.kwh.some(capacityFits)) ?? null;
}

/** Battery graph identity when it is a curated pack (`fam:`/`evdb:`), as `pack:<id>`; research keys are not identities. */
function graphPack(facts: ProductFacts): string | null {
  const raw = (facts.packKey ?? "").trim();
  const match = /^(?:fam|evdb):(.+)$/i.exec(raw);
  const id = match ? slug(match[1]) : null;
  return id ? `pack:${id}` : null;
}

const ALIAS_VARIANT_WORDS = new Set(MODEL_VARIANT_WORDS);

function plainWords(value: string | null | undefined): string {
  return deaccentText(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function deaccentText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Make fold with the alias list's make aliases (vw is volkswagen). Mirrors buyer_interest_alias_make_fold() in SQL. */
function aliasMakeFold(value: string | null | undefined): string {
  const folded = fold(value ?? null);
  return MODEL_MAKE_ALIASES[folded] ?? folded;
}

/**
 * The model text as the alias list reads it: figures, asides, years, battery words and a leading make removed, trailing trim
 * words dropped. Mirrors buyer_interest_model_norm() in SQL (migration 121) and normal_tokens() in model_aliases.py.
 */
export function modelNormText(make: string | null | undefined, raw: string | null | undefined): string | null {
  const own = plainWords(make);
  const brands = [...new Set([own, ...MODEL_BRAND_WORDS])].filter(Boolean).toSorted((a, b) => b.length - a.length || a.localeCompare(b));
  for (const dropYears of [true, false]) {
    let text = deaccentText(raw ?? "").toLowerCase()
      .replace(/\b\d+(?:\.\d+)?\s*(?:kwh|kw|ps|hp|bhp|ah)\b/g, " ")
      .replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
    if (dropYears) {text = text.replace(/\b(?:19|20)\d{2}\b/g, " ");}
    text = text.replace(/\b(?:battery|batteries|packs?|modules?|hv|high voltage)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
    for (const brand of brands) {
      if (brand === "smart" && own && !["smart", "mercedes", "mercedes benz"].includes(own)) {continue;}
      if (text.startsWith(`${brand} `)) {
        text = text.slice(brand.length + 1);
        break;
      }
    }
    const tokens = text.split(" ").filter(Boolean);
    while (tokens.length > 1 && ALIAS_VARIANT_WORDS.has(tokens[tokens.length - 1])) {tokens.pop();}
    if (tokens.length) {return tokens.join(" ");}
  }
  return null;
}

/**
 * The canonical slug of a model text under a make when the alias list names it (Kona Electric is kona, e-Niro is niro), else
 * null. A text listing models names none; with a slash the whole text must equal an alias. Mirrors
 * buyer_interest_model_alias_slug() in SQL.
 */
export function modelAliasSlug(make: string | null | undefined, raw: string | null | undefined): string | null {
  if (!(raw ?? "").trim() || /[,;:]/.test(raw ?? "")) {return null;}
  const norm = modelNormText(make, raw);
  if (!norm) {return null;}
  const own = aliasMakeFold(make) || null;
  const exactOnly = (raw ?? "").includes("/");
  let best: { rank: [boolean, number]; slug: string } | null = null;
  for (const [aliasOwn, , alias, , slug, , isGlobal] of MODEL_ALIAS_ROWS) {
    if (!(norm === alias || (!exactOnly && norm.startsWith(`${alias} `)))) {continue;}
    const mine = own !== null && aliasOwn === own;
    if (!(mine || isGlobal)) {continue;}
    if (!best || (mine && !best.rank[0]) || (mine === best.rank[0] && alias.length > best.rank[1])) {
      best = { rank: [mine, alias.length], slug };
    }
  }
  return best?.slug ?? null;
}

/** The model segment of a key: the canonical slug, else the folded text. Mirrors buyer_interest_model_key() in SQL. */
function modelSegment(make: string | null | undefined, text: string | null | undefined): string | null {
  return modelAliasSlug(make, text) ?? fold(text ?? null);
}

function modelKey(facts: ProductFacts): string | null {
  const make = makeKey(facts.make ?? null);
  if (isProseModel(facts.model ?? null)) {return null;}
  const model = modelAliasSlug(facts.make, modelKeyText(facts.model ?? null))
    ?? fold(normalModel(facts.make ?? null, modelKeyText(facts.model ?? null)) ?? modelKeyText(facts.model ?? null));
  const kwh = kwhKeyText(singleKwh(facts));
  return make && model && kwh ? `model:${make}-${model}-${kwh}kwh` : null;
}

/** The model as a model-level key writes it: no kWh figure, no battery/pack/module word, no repeated make. Mirrors buyer_interest_model_wide_text() in SQL. */
export function modelWideText(make: string | null | undefined, model: string | null | undefined): string | null {
  const text = stripModelPart(model)
    .replace(/\b\d+(?:\.\d+)?\s*kwh\b/gi, " ")
    .replace(/\b(?:hv\s+)?(?:battery|batteries|packs?|modules?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalModel(make ?? null, text || null) ?? (text || null);
}

/**
 * The model-level key: a stated model with no single kWh figure (none stated, or a range) and no part number covers every pack
 * size of that model. A lot of that model, at any capacity, counts as it (see `productKeysFor`). Needs a make: a bare
 * model name ("Bolt") is not a product. Never invents a capacity.
 */
function modelWideKey(facts: ProductFacts): string | null {
  if (facts.cellMaker) {return null;}  // a cell is keyed by its maker and model
  const make = makeKey(facts.make ?? null);
  const text = modelWideText(facts.make, facts.model);
  if (!make || !text || isProseModel(text)) {return null;}
  const model = modelSegment(facts.make, text);
  return model ? `model:${make}-${model}` : null;
}

function cellKey(facts: ProductFacts): string | null {
  const maker = slug(facts.cellMaker ?? null);
  if (isProseModel(facts.model ?? null)) {return null;}
  const model = slug(facts.model ?? null);
  if (!maker || !model) {return null;}
  return `cell:${maker}-${model}`;
}

function broadKey(facts: ProductFacts, withCellFormat = false): string {
  const chemistry = slug(chemistryOf(facts)) ?? "any";
  const format = formatOf(facts);
  const cellFormat = withCellFormat ? cellFormatOf(facts) : null;
  return `broad:${cellFormat ? `${cellFormat}-` : ""}${chemistry}-${format ? FORMAT_PLURAL[format] : "batteries"}`;
}

/** A cell format with a stated maker (the make, else the cell maker): broad:samsung-sdi-21700-nmc-cells. */
function makerCellFormatBroadKey(facts: ProductFacts): string | null {
  const cellFormat = cellFormatOf(facts);
  const maker = makeKey(facts.make ?? null) ?? slug(facts.cellMaker ?? null);
  if (!cellFormat || !maker) {return null;}
  return `broad:${maker}-${cellFormat}-${slug(chemistryOf(facts)) ?? "any"}-cells`;
}

/** The broad bucket scoped to a stated make; null when no make is stated. */
function makeScopedBroadKey(facts: ProductFacts): string | null {
  const make = makeKey(facts.make ?? null);
  if (!make) {return null;}
  const chemistry = slug(chemistryOf(facts)) ?? "any";
  const format = formatOf(facts);
  return `broad:${make}-${chemistry}-${format ? FORMAT_PLURAL[format] : "batteries"}`;
}

/** Values in the order the SQL helper orders them: null first, then by text, de-duplicated. */
function statedValues(values: (string | null | undefined)[] | null | undefined, single: string | null): (string | null)[] {
  const unique = new Set<string>();
  for (const value of values ?? []) {
    const text = (value ?? "").trim();
    if (text) {unique.add(text);}
  }
  const stated = [...unique].filter((value): value is string => Boolean(value));
  if (stated.length) {
    return stated.toSorted((a, b) => a.localeCompare(b));
  }
  const fallback = (single ?? "").trim();
  return [fallback || null];
}

/**
 * One fact set per stated make x chemistry x format, capped at `limit`, mirroring buyer_interest_fact_sets()
 * in SQL. `stated` is how many combinations the facts really name, so a caller can record the truncation.
 */
export function expandProductFacts(facts: ProductFacts, limit = PRODUCT_FACT_COMBINATIONS): { facts: ProductFacts[]; stated: number } {
  const makes = statedValues(splitMakes(statedValues(facts.makes, facts.make ?? null)), null);
  let chemistries = statedValues(facts.chemistries, facts.chemistry ?? null);
  // Two or more makes with two or more chemistries are not paired by the source: no cross product (migration 121).
  const statedChemistries = chemistries.filter((value): value is string => Boolean(value));
  const chemistryPreference = makes.filter(Boolean).length >= 2 && statedChemistries.length >= 2 ? statedChemistries.join(" / ") : null;
  if (chemistryPreference) {chemistries = [null];}
  const formats = statedValues(facts.formats, facts.format ?? null);
  const cellFormats = statedCellFormats(facts);
  const expanded: ProductFacts[] = [];
  for (const make of makes) {
    for (const chemistry of chemistries) {
      for (const format of formats) {
        for (const cellFormat of cellFormats) {
          if (expanded.length >= Math.max(limit, 1)) {
            return { facts: expanded, stated: makes.length * chemistries.length * formats.length * cellFormats.length };
          }
          expanded.push({
            ...facts,
            make,
            chemistry,
            format,
            cellFormat,
            ...(chemistryPreference ? { chemistryPreference } : {}),
            makes: make ? [make] : [],
            chemistries: chemistry ? [chemistry] : [],
            formats: format ? [format] : [],
            cellFormats: cellFormat ? [cellFormat] : [],
          });
        }
      }
    }
  }
  return { facts: expanded, stated: makes.length * chemistries.length * formats.length * cellFormats.length };
}

/** Distinct normalised cell formats a source states (null when none), in the order SQL orders them. */
function statedCellFormats(facts: ProductFacts): (CellFormat | null)[] {
  const found = new Set<CellFormat>();
  for (const value of [...(facts.cellFormats ?? []), ...(facts.cellFormats?.length ? [] : [facts.cellFormat])]) {
    const cellFormat = normalCellFormat(value);
    if (cellFormat) {found.add(cellFormat);}
  }
  return found.size ? [...found].toSorted((a, b) => a.localeCompare(b)) : [null];
}

/**
 * The most specific key these facts prove. Uncertain facts fall to the next broader level instead of guessing:
 * a kWh range (50 to 60) is not a model key, and an unknown model is a broad key.
 */
export function productKeyFor(facts: ProductFacts): string {
  return productKeysFor(facts)[0].key;
}

/** The specific key first, then every broader key it also counts as. Always ends with the broad key. */
export function productKeysFor(facts: ProductFacts): ProductKey[] {
  const keys: ProductKey[] = [];
  const add = (key: string | null, level: ProductKeyLevel) => {
    if (key && !keys.some((entry) => entry.key === key)) {keys.push({ key, level });}
  };

  const part = partList(facts)[0];
  if (part) {add(`part:${part}`, "part");}
  add(graphPack(facts), "pack");
  const family = packFamilyFor(facts);
  if (family) {add(`pack:${family.id}`, "pack");}
  add(modelKey(facts), "model");
  // A model with no single kWh is the model-level key; a model with one is also covered by it, so a buyer who asked for
  // "Kia EV3" without a size still counts for a lot "Kia EV3 81.4 kWh pack".
  add(modelWideKey(facts), "model");
  add(cellKey(facts), "cell");
  // The make-scoped bucket is the roll-up of every specific key, so a Tesla model pack still answers a buyer
  // who asked for "Tesla NMC packs", and the plain bucket stays the last, broadest key.
  add(makerCellFormatBroadKey(facts), "broad");
  add(makeScopedBroadKey(facts), "broad");
  add(broadKey(facts, true), "broad");
  add(broadKey(facts), "broad");
  return keys;
}

/** The roll-up: every key these facts cover, most specific first (used by matching and near matches). */
export function broaderKeysFor(facts: ProductFacts): string[] {
  return productKeysFor(facts).map((entry) => entry.key);
}

/** Level of a key, from its prefix. */
export function productKeyLevel(key: string): ProductKeyLevel {
  if (key.startsWith("part:")) {return "part";}
  if (key.startsWith("pack:")) {return "pack";}
  if (key.startsWith("model:")) {return "model";}
  if (key.startsWith("cell:")) {return "cell";}
  return "broad";
}

/**
 * Facts for the builder from the supply-side parser (`buildProductKey` in ./product-key.ts), so a listing's
 * product line and a buyer's ask meet on one key without the listing readers changing. One fact set per
 * product line: a listing that names two products is two keys, never only its first line.
 */
export function productFactsFromKey(key: Pick<import("./product-key").ProductKey, "lines" | "partNumbers" | "chemistry" | "format">): ProductFacts[] {
  if (!key.lines.length) {
    return [{ partNumbers: key.partNumbers, format: key.format, chemistry: key.chemistry }];
  }
  return key.lines.map((line) => ({
    partNumbers: key.partNumbers,
    make: line.make ?? null,
    model: line.model ?? null,
    format: line.format ?? key.format,
    chemistry: line.chemistry ?? key.chemistry,
    kwh: line.kwh ?? null,
    kwhMin: line.kwhMin ?? null,
    kwhMax: line.kwhMax ?? null,
  }));
}
