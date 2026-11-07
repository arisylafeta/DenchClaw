/**
 * Buyer dossier: parse, validate and derive the flat `buyer_profile` today's readers use.
 *
 * A buyer dossier is Markdown with YAML frontmatter (schema: workspace/buyer-dossiers-pilot/TEMPLATE.md).
 * `crm_companies.buyer_profile` is a derived copy of that frontmatter: existing readers keep reading
 * `chemistries`, `formats`, `makes`, `cell_makers`, `part_numbers`, `kwh_min`, `kwh_max`, `origins`,
 * `min_soh` and `wants`, while the whole frontmatter travels under `dossier`.
 *
 * This module is the only validator and deriver that runs at runtime. `scripts/rebattery/buyer_dossier.py`
 * stays for offline validation and the replay; both are pinned to the same fixtures in
 * `scripts/rebattery/fixtures/buyer_dossier/`, so they cannot drift silently.
 *
 * Everything here is pure: text in, data out. No database access.
 */
import { parse as parseYaml } from "yaml";

// --- controlled values ---------------------------------------------------------------------------
// Format values are Title Case and chemistry values upper case because that is what the readers
// compare: scoreBuyer upper-cases chemistries and compares formats case-insensitively, demand-match
// compares formats exactly and chemistries upper-cased.
export const CHEMISTRIES = ["LFP", "NMC", "NCA", "LMO", "LMFP", "LTO", "Sodium-ion", "Lead-acid", "Mixed"];
export const FORMATS = ["Cells", "Modules", "Packs", "Systems"];
// `origins` is the battery's application origin in the buy box (attribute key `origins`, kind 'set'),
// not the country the goods come from: that is `source_countries`, which stays dossier-only.
export const ORIGINS = ["Passenger EV", "Bus or truck", "Stationary storage", "Industrial", "Consumer or other"];
export const MAKES = [
  "Tesla", "VW Group", "Renault", "Nissan", "Hyundai or Kia", "BMW or Mini", "Mercedes-Benz",
  "Stellantis", "Ford", "GM", "BYD", "MG or SAIC", "Volvo or Polestar", "JLR", "Toyota or Lexus",
];
export const CELL_MAKERS = [
  "CATL", "LG", "Samsung SDI", "SK On", "Panasonic", "BYD", "EVE", "CALB", "Gotion",
  "Northvolt", "AESC",
];
// Not in the registry yet but named by real dossiers; matching is plain text so they still help.
export const EXTRA_CELL_MAKERS = ["Kokam", "Svolt", "Farasis", "Lishen"];

const BUYER_TYPES = ["integrator", "trader", "recycler", "module_builder", "rnd", "oem", "other"];
const INTENTS = ["reuse", "repair", "cells", "recycling"];
const PRODUCT_STATUSES = ["bought", "asked", "said_interested", "declined"];
const ACTIVE_STATUSES = new Set(["bought", "asked", "said_interested"]);
// What they want now, as opposed to what they once bought: the kWh range prefers these.
const ASK_STATUSES = new Set(["asked", "said_interested"]);
const CELL_FORMATS = ["18650", "21700", "prismatic", "pouch", "Cylindrical"];
const CADENCES = ["one_off", "repeat", "standing"];
const COLLECTS = ["own_haulier", "needs_delivery", "either"];
const DECISION_SPEEDS = ["fast", "normal", "slow"];
const PRICE_BASES = ["paid", "quoted_by_buyer", "stated_target"];
const EVIDENCE_REQUIRED = [
  "tested_soh", "bms_access", "bms_data", "label_photos", "pack_photos", "interior_photos",
  "sds", "un383", "test_report", "sample_pack", "provenance", "waste_code",
];

export const TOP_LEVEL_KEYS = [
  "company_id", "company", "buyer_type", "intent", "countries", "products", "rules_out",
  "substitution", "price", "evidence_required", "quantity", "logistics", "capability",
  "decision_speed", "last_verified", "conflicts", "alerts",
  "needs_continuity", "timing", "origins", "source_countries", "min_soh",
];
const PRODUCT_KEYS = [
  "part_number", "platform", "make", "model", "format", "chemistry", "kwh", "module_series",
  "cell_format", "status", "seen", "src",
];
const PRICE_KEYS = ["eur_per_kwh", "eur_per_unit", "currency_original", "basis", "incoterm", "seen", "src"];
const RULES_OUT_KEYS = ["chemistries", "formats", "damaged", "bess_systems", "other"];
const ALERT_KEYS = ["label", "filters", "status", "seen", "src"];
const TIMING_KEYS = ["max_lead_days", "notes"];
// A list entry is a plain value, or a mapping that dates the evidence for it.
const ENTRY_KEYS = ["value", "seen", "src"];

/** The flat keys derived from the dossier. Existing copies of these are replaced, never merged. */
export const DERIVED_KEYS = [
  "chemistries", "formats", "makes", "cell_makers", "part_numbers", "kwh_min", "kwh_max", "wants", "dossier",
  "origins", "min_soh",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SPLIT_RE = /[/,;|]|\band\b/i;

type Json = Record<string, unknown>;

// --- Python-compatible helpers -------------------------------------------------------------------
// Error messages are compared against the Python module through the shared fixtures, so the shapes
// below match Python's repr(), type names and number formatting.

function pyTypeOf(value: unknown): string {
  if (value === null || value === undefined) {
    return "NoneType";
  }
  if (Array.isArray(value)) {
    return "list";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  if (typeof value === "string") {
    return "str";
  }
  return "dict";
}

function pyRepr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(pyRepr).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Json).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`);
    return `{${entries.join(", ")}}`;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  if (text.includes("'") && !text.includes('"')) {
    return `"${text}"`;
  }
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Python's `f"{value:g}"`: six significant digits, no trailing zeros. */
function pyGeneral(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (value === 0) {
    return "0";
  }
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 1e-4) {
    return value
      .toExponential(5)
      .replace(/\.?0+e/, "e")
      .replace(/e\+?(-?)0*(\d+)/, "e$1$2");
  }
  return String(Number(value.toPrecision(6)));
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDict(value: unknown): Json {
  return isRecord(value) ? value : {};
}

/** YAML gives strings and numbers here; this keeps shapes predictable for JSONB and diffs. */
function jsonable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(jsonable);
  }
  if (isRecord(value)) {
    const out: Json = {};
    for (const [key, item] of Object.entries(value)) {
      out[String(key)] = jsonable(item);
    }
    return out;
  }
  return value === undefined ? null : value;
}

/** JS has no maxsplit for String.split; Python's `text.split(sep, n)` keeps the tail whole. */
function splitMax(text: string, sep: string, maxSplit: number): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < maxSplit; i += 1) {
    const at = text.indexOf(sep, from);
    if (at === -1) {
      break;
    }
    parts.push(text.slice(from, at));
    from = at + sep.length;
  }
  parts.push(text.slice(from));
  return parts;
}

// --- parsing -------------------------------------------------------------------------------------
export type ParsedDossier = { frontmatter: Json; body: string };

/** (frontmatter, body). Missing or broken frontmatter yields ({}, whole text). */
export function parseDossier(markdown: string | null | undefined): ParsedDossier {
  const text = (markdown ?? "").replace(/^\ufeff/, "");
  if (!text.startsWith("---")) {
    return { frontmatter: {}, body: text };
  }
  const parts = splitMax(text, "---", 2);
  if (parts.length < 3) {
    return { frontmatter: {}, body: text };
  }
  const body = parts[2].replace(/^[\r\n]+/, "");
  let data: unknown;
  try {
    data = parseYaml(parts[1]);
  } catch {
    return { frontmatter: {}, body: text };
  }
  if (!isRecord(data)) {
    return { frontmatter: {}, body: text };
  }
  return { frontmatter: asDict(jsonable(data)), body };
}

// --- validation ----------------------------------------------------------------------------------
function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

/** null when the value is a valid YYYY-MM-DD date, else a short reason. */
function dateError(value: unknown): string | null {
  if (typeof value === "string" && !value.trim()) {
    return null;
  }
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    return `${pyRepr(value)} is not a YYYY-MM-DD date`;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return `${pyRepr(value)} is not a real date`;
  }
  return null;
}

function checkEnum(errors: string[], where: string, value: unknown, allowed: string[], label: string): void {
  // An empty YAML value left from the template means "not stated", not a wrong value.
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string" && !value.trim()) {
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${where}: ${label} must be a string, got ${pyTypeOf(value)}`);
    return;
  }
  const lowered = new Set(allowed.map((item) => item.toLowerCase()));
  if (!lowered.has(value.toLowerCase())) {
    errors.push(`${where}: ${pyRepr(value)} is not a valid ${label} (${allowed.join(", ")})`);
  }
}

function checkList(errors: string[], where: string, value: unknown, allowed: string[] | null, label = "value"): void {
  if (value === null || value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${where}: must be a list, got ${pyTypeOf(value)}`);
    return;
  }
  if (!allowed) {
    return;
  }
  value.forEach((item, index) => checkEnum(errors, `${where}[${index}]`, item, allowed, label));
}

/** An ISO-2 country-code list (dossier `source_countries`), or nothing stated. */
function checkCountryList(errors: string[], where: string, value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${where}: must be a list of ISO-2 country codes`);
    return;
  }
  value.forEach((code, index) => {
    if (typeof code !== "string" || !/^[A-Za-z]{2}$/.test(code.trim())) {
      errors.push(`${where}[${index}]: ${pyRepr(code)} is not an ISO-2 country code`);
    }
  });
}

/** The value of a rules_out or evidence_required entry: a plain string, or its {value, ...} mapping. */
function entryValue(item: unknown): string | null {
  if (isRecord(item)) {
    const value = item.value;
    return typeof value === "string" ? value : null;
  }
  return typeof item === "string" ? item : null;
}

/**
 * A list whose items are plain values, or {value, seen, src} mappings that date the evidence.
 * The plain form stays valid, so existing dossiers need no edit.
 */
function checkEntryList(errors: string[], where: string, value: unknown, allowed: string[] | null, label = "value"): void {
  if (value === null || value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${where}: must be a list, got ${pyTypeOf(value)}`);
    return;
  }
  value.forEach((item, index) => {
    const itemWhere = `${where}[${index}]`;
    if (isRecord(item)) {
      for (const key of Object.keys(item).filter((key) => !ENTRY_KEYS.includes(key)).toSorted()) {
        errors.push(`${itemWhere}.${key}: unknown key (allowed: ${ENTRY_KEYS.join(", ")})`);
      }
      if (typeof item.value !== "string" || !item.value.trim()) {
        errors.push(`${itemWhere}.value: required text`);
      }
      if ("seen" in item) {
        const reason = dateError(item.seen);
        if (reason) {
          errors.push(`${itemWhere}.seen: ${reason}`);
        }
      }
      if ("src" in item && typeof item.src !== "string") {
        errors.push(`${itemWhere}.src: must be text`);
      }
      if (allowed) {
        checkEnum(errors, itemWhere, item.value, allowed, label);
      }
      return;
    }
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`${itemWhere}: must be text or a mapping with value (and seen, src)`);
      return;
    }
    if (allowed) {
      checkEnum(errors, itemWhere, item, allowed, label);
    }
  });
}

/** Human-readable errors; an empty list means the dossier can be synced. */
export function validateDossier(frontmatter: unknown): string[] {
  if (!isRecord(frontmatter)) {
    return ["frontmatter: not a mapping"];
  }
  const fm = frontmatter;
  const errors: string[] = [];
  for (const key of Object.keys(fm).filter((key) => !TOP_LEVEL_KEYS.includes(key)).toSorted()) {
    errors.push(`${key}: unknown top-level key (allowed: ${TOP_LEVEL_KEYS.join(", ")})`);
  }

  const companyId = fm.company_id === undefined || fm.company_id === null ? "" : fm.company_id;
  if (typeof companyId === "string" && !companyId.trim()) {
    errors.push("company_id: required (the company the dossier belongs to)");
  } else if (typeof companyId !== "string" && typeof companyId !== "number") {
    errors.push("company_id: must be a string");
  }
  checkEnum(errors, "buyer_type", fm.buyer_type, BUYER_TYPES, "buyer_type");
  checkList(errors, "intent", fm.intent, INTENTS, "intent");
  checkEntryList(errors, "evidence_required", fm.evidence_required, EVIDENCE_REQUIRED, "evidence_required");
  checkEnum(errors, "decision_speed", fm.decision_speed, DECISION_SPEEDS, "decision_speed");
  if ("last_verified" in fm) {
    const reason = dateError(fm.last_verified);
    if (reason) {
      errors.push(`last_verified: ${reason}`);
    }
  }

  const continuity = fm.needs_continuity;
  if (continuity !== null && continuity !== undefined && typeof continuity !== "boolean") {
    errors.push(`needs_continuity: must be true, false or null, got ${pyRepr(continuity)}`);
  }

  const timing = fm.timing;
  if (timing !== null && timing !== undefined && !isRecord(timing)) {
    errors.push("timing: must be a mapping");
  } else if (isRecord(timing)) {
    for (const key of Object.keys(timing).filter((key) => !TIMING_KEYS.includes(key)).toSorted()) {
      errors.push(`timing.${key}: unknown key (allowed: ${TIMING_KEYS.join(", ")})`);
    }
    const lead = timing.max_lead_days;
    if (lead !== null && lead !== undefined && (!Number.isInteger(lead) || (lead as number) < 0)) {
      errors.push(`timing.max_lead_days: must be a whole number of days, got ${pyRepr(lead)}`);
    }
    const notes = timing.notes;
    if (notes !== null && notes !== undefined && typeof notes !== "string") {
      errors.push(`timing.notes: must be text, got ${pyTypeOf(notes)}`);
    }
  }

  const origins = fm.origins;
  checkList(errors, "origins", origins, ORIGINS, "origin");
  checkCountryList(errors, "source_countries", fm.source_countries);

  const minSoh = fm.min_soh;
  if (minSoh !== null && minSoh !== undefined) {
    if (!isNumber(minSoh)) {
      errors.push(`min_soh: must be a number 0-100, got ${pyRepr(minSoh)}`);
    } else if (minSoh < 0 || minSoh > 100) {
      errors.push(`min_soh: ${pyRepr(minSoh)} is outside 0-100`);
    }
  }

  const quantity = fm.quantity || {};
  if (!isRecord(quantity)) {
    errors.push("quantity: must be a mapping");
  } else {
    for (const key of ["min_units", "typical_units"]) {
      const value = quantity[key];
      if (value !== null && value !== undefined && !isNumber(value)) {
        errors.push(`quantity.${key}: must be a number, got ${pyRepr(value)}`);
      }
    }
    checkEnum(errors, "quantity.cadence", quantity.cadence, CADENCES, "cadence");
    const wholeBatch = quantity.whole_batch_ok;
    if (wholeBatch !== null && wholeBatch !== undefined && typeof wholeBatch !== "boolean") {
      errors.push(`quantity.whole_batch_ok: must be true, false or null, got ${pyRepr(wholeBatch)}`);
    }
  }

  const substitution = fm.substitution || {};
  if (!isRecord(substitution)) {
    errors.push("substitution: must be a mapping");
  } else {
    const tolerance = substitution.kwh_tolerance;
    if (tolerance !== null && tolerance !== undefined && !isNumber(tolerance)) {
      errors.push(`substitution.kwh_tolerance: must be a number, got ${pyRepr(tolerance)}`);
    }
  }

  const logistics = fm.logistics || {};
  if (!isRecord(logistics)) {
    errors.push("logistics: must be a mapping");
  } else {
    checkEnum(errors, "logistics.collects", logistics.collects, COLLECTS, "collects");
  }

  const rulesOut = fm.rules_out || {};
  if (!isRecord(rulesOut)) {
    errors.push("rules_out: must be a mapping");
  } else {
    for (const key of Object.keys(rulesOut).filter((key) => !RULES_OUT_KEYS.includes(key)).toSorted()) {
      errors.push(`rules_out.${key}: unknown key (allowed: ${RULES_OUT_KEYS.join(", ")})`);
    }
    checkEntryList(errors, "rules_out.chemistries", rulesOut.chemistries, CHEMISTRIES, "chemistry");
    checkEntryList(errors, "rules_out.formats", rulesOut.formats, FORMATS, "format");
    for (const key of ["damaged", "bess_systems"]) {
      const value = rulesOut[key];
      if (value !== null && value !== undefined && typeof value !== "boolean") {
        errors.push(`rules_out.${key}: must be true, false or null, got ${pyRepr(value)}`);
      }
    }
    checkEntryList(errors, "rules_out.other", rulesOut.other, null);
  }

  const products = fm.products || [];
  if (!Array.isArray(products)) {
    errors.push("products: must be a list");
  } else {
    products.forEach((product, index) => {
      const where = `products[${index}]`;
      if (!isRecord(product)) {
        errors.push(`${where}: must be a mapping`);
        return;
      }
      for (const key of Object.keys(product).filter((key) => !PRODUCT_KEYS.includes(key)).toSorted()) {
        errors.push(`${where}.${key}: unknown key (allowed: ${PRODUCT_KEYS.join(", ")})`);
      }
      if (!product.status) {
        errors.push(`${where}.status: required (one of ${PRODUCT_STATUSES.join(", ")})`);
      }
      checkEnum(errors, `${where}.status`, product.status, PRODUCT_STATUSES, "status");
      if (!product.format) {
        errors.push(`${where}.format: required (one of ${FORMATS.join(", ")})`);
      }
      checkEnum(errors, `${where}.format`, product.format, FORMATS, "format");
      checkEnum(errors, `${where}.chemistry`, product.chemistry, CHEMISTRIES, "chemistry");
      checkEnum(errors, `${where}.cell_format`, product.cell_format, CELL_FORMATS, "cell_format");
      const kwh = product.kwh;
      if (kwh !== null && kwh !== undefined) {
        const values = Array.isArray(kwh) ? kwh : [kwh];
        values.forEach((value, kwhIndex) => {
          if (!isNumber(value)) {
            errors.push(`${where}.kwh[${kwhIndex}]: must be a number, got ${pyRepr(value)}`);
          }
        });
      }
      if ("seen" in product) {
        const reason = dateError(product.seen);
        if (reason) {
          errors.push(`${where}.seen: ${reason}`);
        }
      }
    });
  }

  const prices = fm.price || [];
  if (!Array.isArray(prices)) {
    errors.push("price: must be a list");
  } else {
    prices.forEach((price, index) => {
      const where = `price[${index}]`;
      if (!isRecord(price)) {
        errors.push(`${where}: must be a mapping`);
        return;
      }
      for (const key of Object.keys(price).filter((key) => !PRICE_KEYS.includes(key)).toSorted()) {
        errors.push(`${where}.${key}: unknown key (allowed: ${PRICE_KEYS.join(", ")})`);
      }
      for (const key of ["eur_per_kwh", "eur_per_unit"]) {
        const value = price[key];
        if (value !== null && value !== undefined && !isNumber(value)) {
          errors.push(`${where}.${key}: must be a number, got ${pyRepr(value)}`);
        }
      }
      checkEnum(errors, `${where}.basis`, price.basis, PRICE_BASES, "basis");
      if ("seen" in price) {
        const reason = dateError(price.seen);
        if (reason) {
          errors.push(`${where}.seen: ${reason}`);
        }
      }
    });
  }

  const alerts = fm.alerts;
  if (alerts !== null && alerts !== undefined) {
    if (!Array.isArray(alerts)) {
      errors.push("alerts: must be a list");
    } else {
      alerts.forEach((alert, index) => {
        const where = `alerts[${index}]`;
        if (!isRecord(alert)) {
          errors.push(`${where}: must be a mapping`);
          return;
        }
        for (const key of Object.keys(alert).filter((key) => !ALERT_KEYS.includes(key)).toSorted()) {
          errors.push(`${where}.${key}: unknown key (allowed: ${ALERT_KEYS.join(", ")})`);
        }
        if (!alert.label) {
          errors.push(`${where}.label: required`);
        }
        if (!isRecord(alert.filters)) {
          errors.push(`${where}.filters: required mapping of platform filters`);
        }
        if ("seen" in alert) {
          const reason = dateError(alert.seen);
          if (reason) {
            errors.push(`${where}.seen: ${reason}`);
          }
        }
      });
    }
  }
  return errors;
}

// --- mapping to buyer_profile --------------------------------------------------------------------
function canonical(value: unknown, allowed: string[]): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const lookup = new Map(allowed.map((item) => [item.toLowerCase(), item]));
  return lookup.get(value.trim().toLowerCase()) ?? null;
}

const MAKE_ALIASES = new Map<string, string>();
for (const [group, words] of Object.entries({
  "Tesla": ["tesla"],
  "VW Group": ["vw", "vw group", "volkswagen", "volkswagen group", "audi", "skoda", "seat",
    "cupra", "porsche", "bentley", "lamborghini"],
  "Renault": ["renault", "dacia", "alpine"],
  "Nissan": ["nissan", "infiniti"],
  "Hyundai or Kia": ["hyundai", "kia", "genesis"],
  "BMW or Mini": ["bmw", "mini"],
  "Mercedes-Benz": ["mercedes", "mercedes-benz", "mercedes benz", "smart"],
  "Stellantis": ["stellantis", "psa", "peugeot", "citroen", "citroën", "opel", "vauxhall",
    "fiat", "jeep", "ds", "alfa romeo", "alfa", "abarth", "lancia", "fpt",
    "fpt industrial"],
  "Ford": ["ford"],
  "GM": ["gm", "general motors", "chevrolet", "cadillac", "gmc", "buick", "opel gm"],
  "BYD": ["byd", "findreams"],
  "MG or SAIC": ["mg", "saic", "maxus", "roewe"],
  "Volvo or Polestar": ["volvo", "polestar", "lynk", "lynk & co"],
  "JLR": ["jlr", "jaguar", "land rover", "range rover"],
  "Toyota or Lexus": ["toyota", "lexus"],
})) {
  for (const word of words) {
    MAKE_ALIASES.set(word, group);
  }
}

const CELL_MAKER_ALIASES = new Map<string, string>();
for (const [maker, words] of Object.entries({
  "CATL": ["catl"],
  "LG": ["lg", "lg chem", "lg energy solution", "lg energy"],
  "Samsung SDI": ["samsung", "samsung sdi"],
  "SK On": ["sk on", "sk innovation"],
  "Panasonic": ["panasonic", "sanyo"],
  "BYD": ["byd", "findreams"],
  "EVE": ["eve", "eve energy"],
  "CALB": ["calb"],
  "Gotion": ["gotion", "gotion high-tech"],
  "Northvolt": ["northvolt"],
  "AESC": ["aesc", "envision aesc"],
  "Kokam": ["kokam"],
  "Svolt": ["svolt"],
  "Farasis": ["farasis"],
  "Lishen": ["lishen"],
})) {
  for (const word of words) {
    CELL_MAKER_ALIASES.set(word, maker);
  }
}

/**
 * (vehicle make groups, cell makers) named by one product `make` string.
 *
 * Product makes are sometimes lists ("MG, Stellantis, Tesla") or compound ("Stellantis / FPT /
 * Kokam"), so each token is mapped on its own. FPT and PSA belong to the Stellantis group in the
 * dossiers' own wording. Unrecognised tokens map to nothing rather than inventing a group.
 */
function makeGroups(make: unknown): { groups: string[]; cells: string[] } {
  const groups: string[] = [];
  const cells: string[] = [];
  const makeText = typeof make === "string" ? make : "";
  for (const raw of makeText.split(SPLIT_RE)) {
    const token = raw.trim();
    if (!token) {
      continue;
    }
    const key = token.toLowerCase().split(/\s+/).join(" ");
    const group = MAKE_ALIASES.get(key);
    if (group) {
      if (!groups.includes(group)) {
        groups.push(group);
      }
      continue;
    }
    const maker = CELL_MAKER_ALIASES.get(key);
    if (maker && !cells.includes(maker)) {
      cells.push(maker);
    }
  }
  return { groups, cells };
}

function kwhValues(product: Json): number[] {
  const kwh = product.kwh;
  if (kwh === null || kwh === undefined) {
    return [];
  }
  const values = Array.isArray(kwh) ? kwh : [kwh];
  return values.filter(isNumber);
}

function productLabel(product: Json): string {
  for (const key of ["platform", "make", "model"]) {
    const value = product[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().split(/\s+/).join(" ");
      if (["other", "mixed"].includes(text.toLowerCase())) {
        continue;
      }
      return text.length <= 60 ? text : `${text.slice(0, 57).replace(/[ ,;]+$/, "")}...`;
    }
  }
  return canonical(product.chemistry, CHEMISTRIES) ?? "";
}

function wantsLine(product: Json): string {
  const kwh = kwhValues(product);
  let capacity = "";
  if (kwh.length === 1) {
    capacity = `${pyGeneral(kwh[0])} kWh`;
  } else if (kwh.length > 1) {
    capacity = `${pyGeneral(Math.min(...kwh))}-${pyGeneral(Math.max(...kwh))} kWh`;
  }
  const format = canonical(product.format, FORMATS);
  const formatWord = format ? format.toLowerCase() : "";
  const seen = product.seen;
  const status = typeof product.status === "string" ? product.status.replaceAll("_", " ") : "";
  const suffix = [status, typeof seen === "string" || typeof seen === "number" ? String(seen) : ""]
    .filter(Boolean)
    .join(" ");
  const line = [productLabel(product), capacity, formatWord].filter(Boolean).join(" ") || "Batteries";
  return suffix ? `${line} (${suffix})` : line;
}

/**
 * The derived flat profile: only what current readers compare, plus the full dossier.
 *
 * Products that are bought, asked or said_interested drive the buy box. Declined products are
 * history and are excluded. `rules_out` removes a chemistry or format; its entries are plain values
 * or {value, seen, src} mappings, and only the value matters here.
 *
 * The kWh range comes from what they asked for or said they were interested in; only when no such
 * product states a capacity does it fall back to what they bought, so an older, smaller purchase
 * does not lower the minimum they now ask for. `origins` is the battery's application origin, one
 * of the registry's origin values, and flattens under the same name; `source_countries` is where the
 * goods come from and stays in the dossier copy only. `min_soh` also passes through flat.
 * Deterministic: same frontmatter, same output.
 */
export function deriveProfile(frontmatter: unknown): Json {
  const fm = asDict(jsonable(frontmatter ?? {}));
  const products = (Array.isArray(fm.products) ? fm.products : []).filter(isRecord);
  const active = products.filter((product) => ACTIVE_STATUSES.has(String(product.status)));

  const rulesOut = asDict(fm.rules_out);
  const blockedChems = new Set(
    (Array.isArray(rulesOut.chemistries) ? rulesOut.chemistries : [])
      .map((entry) => canonical(entryValue(entry), CHEMISTRIES))
      .filter(Boolean),
  );
  const blockedFormats = new Set(
    (Array.isArray(rulesOut.formats) ? rulesOut.formats : [])
      .map((entry) => canonical(entryValue(entry), FORMATS))
      .filter(Boolean),
  );

  const chemistries: string[] = [];
  const formats: string[] = [];
  const makes: string[] = [];
  const cellMakers: string[] = [];
  const partNumbers: string[] = [];
  const wants: string[] = [];

  for (const product of active) {
    const chemistry = canonical(product.chemistry, CHEMISTRIES);
    if (chemistry && !blockedChems.has(chemistry) && !chemistries.includes(chemistry)) {
      chemistries.push(chemistry);
    }
    const format = canonical(product.format, FORMATS);
    if (format && !blockedFormats.has(format) && !formats.includes(format)) {
      formats.push(format);
    }
    const groups = makeGroups(product.make);
    for (const group of groups.groups) {
      if (!makes.includes(group)) {
        makes.push(group);
      }
    }
    for (const maker of groups.cells) {
      if (!cellMakers.includes(maker)) {
        cellMakers.push(maker);
      }
    }
    const partNumber = product.part_number;
    if (typeof partNumber === "string" && partNumber.trim() && !partNumbers.includes(partNumber.trim())) {
      partNumbers.push(partNumber.trim());
    }
    const line = wantsLine(product);
    if (!wants.includes(line)) {wants.push(line);}
  }

  const askedKwh = products
    .filter((product) => ASK_STATUSES.has(String(product.status)))
    .flatMap(kwhValues);
  const kwh = askedKwh.length
    ? askedKwh
    : products.filter((product) => String(product.status) === "bought").flatMap(kwhValues);

  const makeOrder = new Map(MAKES.map((value, index) => [value, index]));
  makes.sort((a, b) => (makeOrder.get(a) ?? MAKES.length) - (makeOrder.get(b) ?? MAKES.length));
  const cellOrder = new Map([...CELL_MAKERS, ...EXTRA_CELL_MAKERS].map((value, index) => [value, index]));
  const cellCount = CELL_MAKERS.length + EXTRA_CELL_MAKERS.length;
  cellMakers.sort((a, b) => (cellOrder.get(a) ?? cellCount) - (cellOrder.get(b) ?? cellCount));
  const chemOrder = new Map(CHEMISTRIES.map((value, index) => [value, index]));
  chemistries.sort((a, b) => (chemOrder.get(a) ?? CHEMISTRIES.length) - (chemOrder.get(b) ?? CHEMISTRIES.length));
  const formatOrder = new Map(FORMATS.map((value, index) => [value, index]));
  formats.sort((a, b) => (formatOrder.get(a) ?? FORMATS.length) - (formatOrder.get(b) ?? FORMATS.length));

  // Whole numbers read better in JSON and in the old columns.
  const whole = (value: number) => (Number.isInteger(value) ? value : value);
  const profile: Json = {
    chemistries,
    formats,
    makes,
    cell_makers: cellMakers,
    part_numbers: partNumbers,
    kwh_min: kwh.length ? whole(Math.min(...kwh)) : null,
    kwh_max: kwh.length ? whole(Math.max(...kwh)) : null,
    wants: wants.join("\n"),
    dossier: fm,
  };

  // Application origin and a minimum SoH have flat names the readers already look for.
  // Only registry values survive; anything else is a validation error before a save.
  const origins: string[] = [];
  for (const origin of Array.isArray(fm.origins) ? fm.origins : []) {
    const value = canonical(origin, ORIGINS);
    if (value && !origins.includes(value)) {origins.push(value);}
  }
  if (origins.length) {
    const originOrder = new Map(ORIGINS.map((value, index) => [value, index]));
    profile.origins = origins.toSorted(
      (a, b) => (originOrder.get(a) ?? ORIGINS.length) - (originOrder.get(b) ?? ORIGINS.length),
    );
  }
  const minSoh = fm.min_soh;
  if (isNumber(minSoh)) {profile.min_soh = Number.isInteger(minSoh) ? minSoh : minSoh;}
  return profile;
}

// --- derive as a merge ---------------------------------------------------------------------------
export type DerivedMerge = {
  /** The profile to store: pass-through keys first, then the keys derived from this dossier. */
  profile: Json;
  /** Keys this dossier derived (the ones a reader looks for). */
  derived: string[];
  /** Keys that came from the existing profile untouched; they survive a dossier save. */
  passedThrough: string[];
};

/**
 * Derived keys overwrite; every other existing key passes through and is listed.
 *
 * A derived key the dossier no longer states is dropped rather than kept stale: `origins` that the
 * dossier stopped asserting must not survive from an intake merge.
 */
export function mergeDerivedProfile(existing: unknown, frontmatter: unknown): DerivedMerge {
  const current = asDict(existing ?? {});
  const derivedProfile = deriveProfile(frontmatter);
  const passedThrough: string[] = [];
  const profile: Json = {};
  for (const [key, value] of Object.entries(current)) {
    if ((DERIVED_KEYS as readonly string[]).includes(key)) {continue;}
    profile[key] = value;
    passedThrough.push(key);
  }
  for (const [key, value] of Object.entries(derivedProfile)) {profile[key] = value;}
  return { profile, derived: Object.keys(derivedProfile), passedThrough };
}

/** Key-order-independent JSON, for "did the derived profile actually change" checks. */
export function stableStringify(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) {return item.map(sort);}
    if (isRecord(item)) {
      const out: Json = {};
      for (const key of Object.keys(item).toSorted()) {out[key] = sort(item[key]);}
      return out;
    }
    return item;
  };
  return JSON.stringify(sort(value));
}
