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

/**
 * One mark per requirement the request states, in a fixed order: model or make, size, format, capacity, chemistry,
 * quantity, price, condition or SoH, delivery. A requirement the request does not state gets no mark.
 */
export function fitMarks(req: Requirement, match: Match, opts: { price?: string | null } = {}): FitMark[] {
  const c = match.candidate;
  const marks: FitMark[] = [];
  const add = (key: string, label: string, state: FitState) => marks.push({ key, label, state });

  const model = find(match.checks, "model");
  const product = find(match.checks, "product");
  if (model) {
    add("model", model.state === "pass" ? model.detail : /maker not/i.test(model.detail) ? "Maker" : "Model", STATE[model.state]);
  }
  if (product) {
    if (req.cellTokens.length) {
      add("size", product.state === "pass" ? product.detail.replace(/ cells$/, " size") : "Size", STATE[product.state]);
    } else {
      const label = product.state === "pass" ? product.detail : product.detail.startsWith("AI:") ? `${product.label} (AI)` : product.label;
      add("model", label.length > 40 ? `${label.slice(0, 39).trimEnd()}…` : label, STATE[product.state]);
    }
  }
  const format = find(match.checks, "format");
  if (format) {
    add("format", format.state === "pass" ? format.detail : "Format", STATE[format.state]);
  }
  const capacity = find(match.checks, "capacity");
  if (capacity) {
    add("capacity", capacity.state === "unknown" ? "kWh" : capacity.detail.replace(/\s*\(.*\)$/, ""), STATE[capacity.state]);
  }
  const chemistry = find(match.checks, "chemistry");
  if (chemistry) {
    add("chemistry", chemistry.state === "pass" ? chemistry.detail : "Chemistry", STATE[chemistry.state]);
  }
  const quantity = find(match.checks, "quantity");
  if (quantity) {
    const label = quantity.state === "unknown" || c.units == null ? "Quantity"
      : req.unitsRange ? `${count(c.units)} available · need ${count(req.unitsRange.min)}–${count(req.unitsRange.max)}`
      : req.unitsNeeded ? `${count(c.units)} of ${count(req.unitsNeeded)}` : quantity.detail;
    add("quantity", label, STATE[quantity.state]);
  }
  if (req.buyerEurPerKwh != null || req.buyerEurPerUnit != null) {
    const price = find(match.checks, "price");
    const state: FitState = price ? STATE[price.state] : "unstated";
    add("price", state === "unstated" ? "Price" : state === "misses" ? `${opts.price ?? "Price"}, over max` : opts.price ?? "Price", state);
  }
  if (req.minSoh != null) {
    add("condition", c.soh != null ? `SoH ${Math.round(c.soh)}%` : "SoH", c.soh != null ? "fits" : "unstated");
  } else if (req.conditions.length || req.wantsNew) {
    add("condition", "Condition", "unstated");
  }
  if (req.country) {
    const code = countryCode(c);
    if (code === req.country) {
      add("location", `In ${req.country}`, "fits");
    } else if (code || c.country) {
      add("location", `${code ?? c.country} → ${req.country}`, "close");
    } else {
      add("location", "Location", "unstated");
    }
  }
  return marks;
}
