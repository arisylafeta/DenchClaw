// The editable criteria behind a request's Matches: one entry per field the matcher filters by. Pure: reads a request's
// own fields (spec keys, price, volume, delivery), validates a draft and builds the PATCH body that saves it through the
// same write path as the Details tab. Buyer or Ours is fixed per criterion: Buyer is what the buyer stated, Ours is a
// filter we add (a floor that suits us, where we are willing to source from).
import type { MatchCriteria } from "./matches-types";
import { countryInText, countryNameOf } from "./demand-regions";

export type Owner = "buyer" | "ours";
export type Kind = "multi" | "num" | "price" | "qty" | "range" | "text" | "country1" | "countries" | "regions";

export type CriterionKey =
  | "formats" | "cell_formats" | "chemistries" | "conditions" | "excludes" | "delivery" | "max_price" | "min_price" | "volume"
  | "min_soh" | "kwh_unit" | "makes" | "min_lot_kwh" | "supplier_regions" | "supplier_countries";

export type Def = {
  key: CriterionKey;
  label: string;
  owner: Owner;
  kind: Kind;
  /** Spec key behind a multi, number, countries or regions criterion. */
  spec?: string;
  /** Shown as "No pouch cells". */
  no?: boolean;
  unit?: string;
  min?: number;
  max?: number;
  sign?: string;
};

/** In display order. */
export const CRITERIA: Def[] = [
  { key: "formats", label: "Format", owner: "buyer", kind: "multi", spec: "formats" },
  { key: "cell_formats", label: "Cell format", owner: "buyer", kind: "multi", spec: "cell_formats" },
  { key: "chemistries", label: "Chemistry", owner: "buyer", kind: "multi", spec: "chemistries" },
  { key: "conditions", label: "Condition", owner: "buyer", kind: "multi", spec: "conditions" },
  { key: "excludes", label: "Exclude", owner: "buyer", kind: "multi", spec: "excludes", no: true },
  { key: "delivery", label: "Delivery", owner: "buyer", kind: "country1" },
  { key: "max_price", label: "Price ceiling", owner: "buyer", kind: "price", sign: "≤" },
  { key: "min_price", label: "Price floor", owner: "ours", kind: "price", sign: "≥" },
  { key: "volume", label: "Total quantity", owner: "buyer", kind: "qty" },
  { key: "min_soh", label: "Min SOH", owner: "buyer", kind: "num", spec: "min_soh", unit: "%", min: 1, max: 100 },
  { key: "kwh_unit", label: "kWh per unit", owner: "buyer", kind: "range" },
  { key: "makes", label: "Makes", owner: "buyer", kind: "text", spec: "makes" },
  { key: "min_lot_kwh", label: "Min lot size", owner: "ours", kind: "num", spec: "min_lot_kwh", unit: "kWh per lot", min: 1 },
  { key: "supplier_regions", label: "Supplier region", owner: "ours", kind: "regions", spec: "supplier_regions" },
  { key: "supplier_countries", label: "Supplier country", owner: "ours", kind: "countries", spec: "supplier_countries" },
];

export const DEFS: Record<CriterionKey, Def> = Object.fromEntries(CRITERIA.map((def) => [def.key, def])) as Record<CriterionKey, Def>;

export type Price = { cur: string; amt: string; unit: string };
export type Qty = { n: string; unit: string };
export type Range = { min: string; max: string };
export type Value = string[] | string | Price | Qty | Range;
export type Values = Partial<Record<CriterionKey, Value>>;

/** What the lists in the editors may offer. */
export type Options = { lists: Record<string, string[]> };

export const PRICE_UNITS = ["kWh", "cell", "pack"];
export const QTY_UNITS = ["kWh", "MWh", "cells", "modules", "packs"];
export const CURRENCIES = ["EUR", "USD", "GBP"];

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const num = (value: unknown): string | null => (typeof value === "number" && Number.isFinite(value) ? String(value) : null);

/** The current value of every criterion the request has. A criterion it does not have is absent (so "Add criterion" offers it). */
export function readCriteria(c: MatchCriteria): Values {
  const out: Values = {};
  const spec = c.spec ?? {};
  for (const def of CRITERIA) {
    if (def.kind === "multi" || def.kind === "countries" || def.kind === "regions") {
      const values = list(spec[def.spec!]);
      if (values.length) out[def.key] = values;
    } else if (def.kind === "num") {
      const value = num(spec[def.spec!]);
      if (value) out[def.key] = value;
    } else if (def.kind === "text") {
      const values = list(spec[def.spec!]);
      if (values.length) out[def.key] = values.join(", ");
    }
  }
  if (c.max_price != null && c.price_currency && c.price_unit) out.max_price = { cur: c.price_currency, amt: String(c.max_price), unit: c.price_unit };
  const floor = spec.price_floor as { amount?: unknown; currency?: unknown; unit?: unknown } | undefined;
  if (floor && typeof floor.amount === "number" && typeof floor.currency === "string" && typeof floor.unit === "string") {
    out.min_price = { cur: floor.currency, amt: String(floor.amount), unit: floor.unit };
  }
  if (c.volume != null && c.volume_unit) out.volume = { n: String(c.volume), unit: c.volume_unit };
  const kwhMin = num(spec.kwh_min);
  const kwhMax = num(spec.kwh_max);
  if (kwhMin || kwhMax) out.kwh_unit = { min: kwhMin ?? "", max: kwhMax ?? "" };
  const place = text(c.location);
  if (place) {
    const code = countryInText(place);
    out.delivery = (code && countryNameOf(code)) || place;
  }
  return out;
}

const empty = (value: unknown) => value == null || value === "" || (Array.isArray(value) && value.length === 0);
const isNum = (value: string) => value.trim() !== "" && Number.isFinite(Number(value));

/** A fresh draft for the editor: the current value, or a blank of the right shape. */
export function draftFor(key: CriterionKey, current: Value | undefined, c: MatchCriteria): Value {
  const def = DEFS[key];
  if (def.kind === "multi" || def.kind === "countries" || def.kind === "regions") return [...((current as string[] | undefined) ?? [])];
  if (def.kind === "price") {
    if (current) return { ...(current as Price) };
    // A new floor starts in the ceiling's currency and unit, so the two compare.
    const other = readCriteria(c)[key === "min_price" ? "max_price" : "min_price"] as Price | undefined;
    return { cur: other?.cur ?? "EUR", amt: "", unit: other?.unit ?? "kWh" };
  }
  if (def.kind === "qty") return current ? { ...(current as Qty) } : { n: "", unit: "kWh" };
  if (def.kind === "range") return current ? { ...(current as Range) } : { min: "", max: "" };
  return (current as string | undefined) ?? "";
}

/** Null when the draft can be saved, "empty" when it holds nothing (the editor then acts as Cancel), else the one error to show. */
export function validateDraft(key: CriterionKey, draft: Value, all: Values, options?: Options): string | null {
  const def = DEFS[key];
  switch (def.kind) {
    case "multi": case "countries": case "regions":
      return (draft as string[]).length ? null : "empty";
    case "country1":
      return draft ? null : "empty";
    case "num": {
      const value = draft as string;
      if (empty(value)) return "empty";
      if (!isNum(value)) return "Enter a number.";
      if (def.min != null && Number(value) < def.min) return `Must be at least ${def.min}.`;
      if (def.max != null && Number(value) > def.max) return `Must be ${def.max} or less.`;
      return null;
    }
    case "price": {
      const price = draft as Price;
      if (empty(price.amt)) return "empty";
      if (!isNum(price.amt) || Number(price.amt) <= 0) return "Enter a price above 0.";
      const other = all[key === "max_price" ? "min_price" : "max_price"] as Price | undefined;
      if (other && other.cur === price.cur && other.unit === price.unit) {
        if (key === "max_price" && Number(price.amt) < Number(other.amt)) return `Ceiling is below the floor (${other.cur} ${other.amt} per ${other.unit}).`;
        if (key === "min_price" && Number(price.amt) > Number(other.amt)) return `Floor is above the ceiling (${other.cur} ${other.amt} per ${other.unit}).`;
      }
      return null;
    }
    case "qty": {
      const qty = draft as Qty;
      if (empty(qty.n)) return "empty";
      return isNum(qty.n) && Number(qty.n) > 0 ? null : "Enter a quantity above 0.";
    }
    case "range": {
      const range = draft as Range;
      if (empty(range.min) && empty(range.max)) return "empty";
      if (!isNum(range.min) || !isNum(range.max)) return "Enter both a minimum and a maximum.";
      if (Number(range.min) <= 0 || Number(range.max) <= 0) return "Values must be above 0.";
      return Number(range.min) <= Number(range.max) ? null : "Minimum is above maximum.";
    }
    case "text": {
      const raw = draft as string;
      if (empty(raw.trim())) return "empty";
      const allowed = options?.lists[def.spec!];
      if (allowed?.length) {
        const unknown = splitMakes(raw).filter((make) => !allowed.some((a) => a.toLowerCase() === make.toLowerCase()));
        if (unknown.length) return `Not a make we list: ${unknown.join(", ")}.`;
      }
      return null;
    }
  }
}

const splitMakes = (raw: string) => raw.split(/[,;]+/).map((make) => make.trim()).filter(Boolean);

/** The one-line pieces a value shows as (one chip each for lists). */
export function describe(key: CriterionKey, value: Value | undefined): string[] | null {
  if (empty(value)) return null;
  const def = DEFS[key];
  const lower = (item: string) => item.charAt(0).toLowerCase() + item.slice(1);
  switch (def.kind) {
    case "multi": return (value as string[]).map((item) => (def.no ? `No ${lower(item)}` : item));
    case "countries": case "regions": return value as string[];
    case "country1": return [value as string];
    case "num": return [`≥ ${Number(value).toLocaleString("en-GB")} ${def.unit}`];
    case "price": { const p = value as Price; return [`${def.sign} ${p.cur} ${p.amt} per ${p.unit}`]; }
    case "qty": { const q = value as Qty; return [`${Number(q.n).toLocaleString("en-GB")} ${q.unit}`]; }
    case "range": { const r = value as Range; return [r.min && r.max ? `${r.min}–${r.max} kWh` : r.min ? `≥ ${r.min} kWh` : `≤ ${r.max} kWh`]; }
    case "text": return [value as string];
  }
}

export type PatchBody = Record<string, unknown>;

const numberOrNull = (value: string) => (isNum(value) ? Number(value) : null);

/**
 * The PATCH body that saves one criterion (`value` null removes it). Spec edits send the whole spec with the one key
 * changed, because the write replaces the spec. Every other field is sent alone, or with the fields it must travel with.
 */
export function patchFor(key: CriterionKey, value: Value | null, c: MatchCriteria, options?: Options): PatchBody {
  const def = DEFS[key];
  const spec: Record<string, unknown> = { ...(c.spec ?? {}) };
  const setSpec = (name: string, next: unknown) => {
    if (next == null || (Array.isArray(next) && !next.length)) delete spec[name];
    else spec[name] = next;
    return { spec };
  };
  if (key === "max_price") {
    const p = value as Price | null;
    return p ? { max_price: Number(p.amt), price_currency: p.cur, price_unit: p.unit } : { max_price: null, price_currency: null, price_unit: null };
  }
  if (key === "min_price") {
    const p = value as Price | null;
    return setSpec("price_floor", p ? { amount: Number(p.amt), currency: p.cur, unit: p.unit } : null);
  }
  if (key === "volume") {
    const q = value as Qty | null;
    return q ? { volume: Number(q.n), volume_unit: q.unit } : { volume: null, volume_unit: null };
  }
  if (key === "kwh_unit") {
    const r = value as Range | null;
    delete spec.kwh_min;
    delete spec.kwh_max;
    if (r) {
      const min = numberOrNull(r.min);
      const max = numberOrNull(r.max);
      if (min != null) spec.kwh_min = min;
      if (max != null) spec.kwh_max = max;
    }
    return { spec };
  }
  if (key === "delivery") return { location: value ? (value as string) : null };
  if (def.kind === "num") return setSpec(def.spec!, value == null ? null : Number(value));
  if (def.kind === "text") {
    const allowed = options?.lists[def.spec!] ?? [];
    const makes = value == null ? [] : splitMakes(value as string).map((make) => allowed.find((a) => a.toLowerCase() === make.toLowerCase()) ?? make);
    return setSpec(def.spec!, [...new Set(makes)]);
  }
  return setSpec(def.spec!, value == null ? null : [...new Set(value as string[])]);
}

/** Criteria the request does not have yet, by owner, for the Add menu. */
export function addable(values: Values): { buyer: Def[]; ours: Def[] } {
  const free = CRITERIA.filter((def) => !(def.key in values));
  return { buyer: free.filter((def) => def.owner === "buyer"), ours: free.filter((def) => def.owner === "ours") };
}
