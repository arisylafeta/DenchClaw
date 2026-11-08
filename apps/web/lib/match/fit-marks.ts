// The request Matches row in words: what the supplier holds, where that comes from, and one fit mark per
// requirement the request states (✓ fits, ≈ close, ? not stated, ✗ misses). Pure: built from the scorer's own checks,
// so the marks and the ranking cannot disagree.
import { cellCodes, countryFromText, makeAndModel, type Candidate, type Check, type CheckState, type Match, type Requirement } from "../demand-match";
import type { FitMark, FitState } from "../matches-types";

const STATE: Record<CheckState, FitState> = { pass: "fits", partial: "close", unknown: "unstated", fail: "misses" };

const count = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 1 });

const UNIT_WORD: Record<string, [string, string]> = {
  Cells: ["cell", "cells"], Modules: ["module", "modules"], Packs: ["pack", "packs"], Systems: ["system", "systems"],
};

/** "1 pack", "12,400 cells", "3 units". */
export function unitsPhrase(units: number, format: Candidate["format"]): string {
  const [one, many] = UNIT_WORD[format ?? ""] ?? ["unit", "units"];
  return `${count(units)} ${units === 1 ? one : many}`;
}

/** "LISHEN" reads "Lishen"; short makes ("BYD", "MG") stay as written. */
const prettyMake = (make: string) => (make.length > 3 && make === make.toUpperCase() ? make[0] + make.slice(1).toLowerCase() : make);

/** A seller reference that is a product code ("INR21700-50E"), not an internal row number or a sentence. */
const codeLike = (value: string | null | undefined) =>
  !!value && value.length >= 4 && value.length <= 32 && !/\s/.test(value) && /[a-z]/i.test(value) && /\d/.test(value) && !/^\d/.test(value);

/** The product a row holds, named from the source: make and model, else the maker its cell code names and the code. */
export function productName(c: Candidate): string {
  const code = codeLike(c.supplierRef) ? c.supplierRef! : null;
  const codeMaker = cellCodes(`${c.title} ${code ?? ""}`.toLowerCase()).makes[0];
  const make = c.make ? prettyMake(c.make) : codeMaker ? codeMaker[0].toUpperCase() + codeMaker.slice(1) : null;
  // Stock lists often repeat the make in the model ("Citroen Citroen Berlingo"): makeAndModel drops the repeat.
  const name = makeAndModel(make, c.model ?? (c.make ? null : code));
  if (!name || (!c.model && !code)) {
    return c.title;
  }
  const word = UNIT_WORD[c.format ?? ""]?.[1];
  return word && word !== "packs" && !name.toLowerCase().includes(word.slice(0, -1)) ? `${name} ${word}` : name;
}

/** What they hold, in one line: "Lishen LR21700LH cells · quantity not stated · SoH 92% · 2021". */
export function holdsLine(c: Candidate): string {
  const name = productName(c);
  const part = c.partNumber && !name.toLowerCase().includes(c.partNumber.toLowerCase()) ? `part ${c.partNumber}` : null;
  return [
    name,
    c.units != null ? unitsPhrase(c.units, c.format) : "quantity not stated",
    c.kwh != null && c.format !== "Cells" && !/kwh/i.test(name) ? `${c.kwhEstimated ? "~" : ""}${Math.round(c.kwh * 10) / 10} kWh` : null,
    c.soh != null ? `SoH ${Math.round(c.soh)}%` : null,
    c.year != null ? String(c.year) : null,
    part,
  ].filter(Boolean).join(" · ");
}

/** "8 Oct", or "8 Oct 2025" once the date is not this year. */
function shortDate(iso: string, now: Date): string | null {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Where the line comes from and when: "Catalogue, 8 Oct", "Marketplace listing, 3 Nov". */
export function sourceLine(c: Candidate, now: Date = new Date()): string | null {
  const when = c.observedOn ?? c.seen;
  const date = when ? shortDate(when, now) : null;
  // "eBay listing" keeps its own capital; every other kind starts with one.
  const kind = c.sourceKind ? (/^e[A-Z]/.test(c.sourceKind) ? c.sourceKind : c.sourceKind[0].toUpperCase() + c.sourceKind.slice(1)) : null;
  if (kind && date) {
    return `${kind}, ${date}`;
  }
  return kind ?? (date ? `Seen ${date}` : null);
}

/** Where the goods are, as a two-letter code: the line's own location first, else the seller's country. */
function countryCode(c: Candidate): string | null {
  const raw = (c.country ?? "").trim();
  return countryFromText(c.location) ?? (/^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : countryFromText(raw));
}

const find = (checks: Check[], key: Check["key"]) => checks.find((check) => check.key === key);

const NOT_STATED = "Not stated";
const title = (word: string) => (word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1));

/** A country code as its English name ("PL" → "Poland"), or the code when the runtime has no name for it. */
export function countryName(code: string | null | undefined): string | null {
  if (!code) {
    return null;
  }
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Where the goods are, by country name, for the row's header ("United States"). */
export function rowCountry(c: Candidate): string | null {
  const code = countryCode(c);
  return code ? countryName(code) : c.country?.trim() || null;
}

/** What the buyer asked for, per requirement, for the "How it fits" table. */
function asked(req: Requirement, key: string): string {
  switch (key) {
    case "model":
      if (req.cellModels.length || req.cellMakers.length) {
        return [req.cellMakers.map(title).join(" or "), req.cellModels.map((m) => m.toUpperCase()).join(" or ")].filter(Boolean).join(" ");
      }
      return req.products.map((p) => p.phrase.replace(/\b\w/g, (ch) => ch.toUpperCase())).join(" / ")
        || req.makeWords.map(title).join(" / ") || "Any";
    case "size":
      return req.cellTokens.filter((tok) => /^\d+$/.test(tok)).join(" / ");
    case "format":
      return [req.cellFormats.join(" / "), req.formats.join(" / ").toLowerCase()].filter(Boolean).join(" ") || "Any";
    case "capacity":
      return req.pinned.find((pin) => /kwh/i.test(pin)) ?? "Any";
    case "chemistry":
      return req.chemistries.join(" / ");
    case "quantity":
      return req.unitsRange ? `${count(req.unitsRange.min)}–${count(req.unitsRange.max)}`
        : req.unitsNeeded ? count(req.unitsNeeded) : req.kwhNeeded ? `${count(req.kwhNeeded)} kWh` : "Any";
    case "price":
      return "Under ceiling";
    case "condition":
      return req.minSoh != null ? `SoH ${req.minSoh}%+` : req.conditions.join(" / ") || (req.wantsNew ? "New" : "Any");
    case "location":
      return countryName(req.country) ?? "Any";
    default:
      return "";
  }
}

const REQUIREMENT_NAME: Record<string, string> = {
  model: "Model", size: "Cell size", format: "Format", capacity: "Capacity", chemistry: "Chemistry",
  quantity: "Quantity", price: "Price", condition: "Condition", location: "Delivery",
};

/** What to ask the seller for, from the requirements they have not stated. */
const ASK_FOR: Record<string, string> = {
  model: "the exact model", size: "the cell size", format: "the format", capacity: "the capacity", chemistry: "the chemistry",
  quantity: "quantity", price: "price per unit", condition: "SoH or test data", location: "where the stock is",
};
export function askFor(marks: FitMark[]): string[] {
  return marks.filter((mark) => mark.state === "unstated").map((mark) => ASK_FOR[mark.key] ?? mark.key);
}

/**
 * One mark per requirement the request states, in a fixed order: model or make, size, format, capacity, chemistry,
 * quantity, price, condition or SoH, delivery. A requirement the request does not state gets no mark. Each mark also
 * carries its "How it fits" row: the requirement, what the buyer asked and what the seller has.
 */
export function fitMarks(req: Requirement, match: Match, opts: { price?: string | null } = {}): FitMark[] {
  const c = match.candidate;
  const marks: FitMark[] = [];
  const add = (key: string, label: string, state: FitState, have: string, name?: string) =>
    marks.push({ key, label, state, name: name ?? REQUIREMENT_NAME[key] ?? key, asked: asked(req, key), have });

  const model = find(match.checks, "model");
  const product = find(match.checks, "product");
  if (model) {
    add("model", model.state === "pass" ? model.detail : /maker not/i.test(model.detail) ? "Maker" : "Model", STATE[model.state],
      model.state === "pass" ? productName(c) : NOT_STATED, "Cell model");
  }
  if (product) {
    if (req.cellTokens.length) {
      add("size", product.state === "pass" ? product.detail.replace(/ cells$/, " size") : "Size", STATE[product.state],
        product.state === "pass" ? product.detail.replace(/ cells$/, "") : NOT_STATED);
    } else {
      const label = product.state === "pass" ? product.detail : product.detail.startsWith("AI:") ? `${product.label} (AI)` : product.label;
      add("model", label.length > 40 ? `${label.slice(0, 39).trimEnd()}…` : label, STATE[product.state],
        product.state === "pass" ? product.detail : product.detail.startsWith("AI:") ? product.detail : NOT_STATED, product.label);
    }
  }
  const format = find(match.checks, "format");
  if (format) {
    add("format", format.state === "pass" ? format.detail : "Format", STATE[format.state], format.state === "pass" ? format.detail : NOT_STATED);
  }
  const capacity = find(match.checks, "capacity");
  if (capacity) {
    const value = capacity.detail.replace(/\s*\(.*\)$/, "");
    add("capacity", capacity.state === "unknown" ? "kWh" : value, STATE[capacity.state], capacity.state === "unknown" ? NOT_STATED : value);
  }
  const chemistry = find(match.checks, "chemistry");
  if (chemistry) {
    add("chemistry", chemistry.state === "pass" ? chemistry.detail : "Chemistry", STATE[chemistry.state],
      chemistry.state === "pass" ? chemistry.detail : c.chemistry ?? NOT_STATED);
  }
  const quantity = find(match.checks, "quantity");
  if (quantity) {
    const label = quantity.state === "unknown" || c.units == null ? "Quantity"
      : req.unitsRange ? `${count(c.units)} available · need ${count(req.unitsRange.min)}–${count(req.unitsRange.max)}`
      : req.unitsNeeded ? `${count(c.units)} of ${count(req.unitsNeeded)}` : quantity.detail;
    const share = c.units != null && req.unitsNeeded && !req.unitsRange && c.units < req.unitsNeeded
      ? ` (${Math.max(0.1, Math.round((c.units / req.unitsNeeded) * 1000) / 10)}%)` : "";
    add("quantity", label, STATE[quantity.state], c.units != null ? `${unitsPhrase(c.units, c.format)}${share}` : NOT_STATED);
  }
  if (req.buyerEurPerKwh != null || req.buyerEurPerUnit != null) {
    const price = find(match.checks, "price");
    const state: FitState = price ? STATE[price.state] : "unstated";
    add("price", state === "unstated" ? "Price" : state === "misses" ? `${opts.price ?? "Price"}, over max` : opts.price ?? "Price", state,
      opts.price ?? NOT_STATED);
  }
  if (req.minSoh != null) {
    add("condition", c.soh != null ? `SoH ${Math.round(c.soh)}%` : "SoH", c.soh != null ? "fits" : "unstated",
      c.soh != null ? `SoH ${Math.round(c.soh)}%` : NOT_STATED);
  } else if (req.conditions.length || req.wantsNew) {
    add("condition", "Condition", "unstated", c.soh != null ? `SoH ${Math.round(c.soh)}%` : NOT_STATED);
  }
  if (req.country) {
    const code = countryCode(c);
    const where = code ? countryName(code) : c.country;
    if (code === req.country) {
      add("location", `In ${req.country}`, "fits", where ?? NOT_STATED);
    } else if (code || c.country) {
      add("location", `${code ?? c.country} → ${req.country}`, "close", `${where}, export needed`);
    } else {
      add("location", "Location", "unstated", NOT_STATED);
    }
  }
  return marks;
}
