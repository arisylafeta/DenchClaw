// One supply lot as the product it actually is: part number, make, model, platform, kWh per unit, format,
// chemistry and units. Deterministic and pure: built on read from the listing's own field text, nothing stored.
//
// The field text is human, not a schema. These rules come from the real values in `crm_bulk_listing_fields`:
// "10 packs at 60 kWh, 14 at 44 kWh, 42 modules at 20.7 kWh" is three products, not one; "37 kWh nominal
// (35 kWh usable) · 355 V · 104 Ah" is 37 kWh; "Minimum 5,020 mAh; typical 5,220 mAh at 3.6 V" is a cell of
// 5,220 mAh x 3.6 V. A field whose status is `conflict` shows both values and counts as unknown for rule-outs,
// because a disputed figure must never rule a buyer out or order the list.
import { CELL_MAKERS, EUR_PER, MAKE_WORDS, PLATFORMS } from "../demand-match";

export type KeyFormat = "Cells" | "Modules" | "Packs" | "Systems";
export type FieldStatus = "confirmed" | "unverified" | "conflict" | "missing" | string;

/** One row of `crm_bulk_listing_fields`. `alternatives` holds the values a conflicting row replaced. */
export type FieldFact = {
  field_key: string;
  value: string | null;
  status: FieldStatus | null;
  alternatives?: unknown;
  /** Who may see the value: `teaser` is buyer-facing, everything else is not. Absent means not cleared for a buyer. */
  visibility?: string | null;
};

export type ProductLine = {
  format: KeyFormat | null;
  chemistry: string | null;
  /** Energy per unit in kWh. Null when a range is stated or the figure is unknown. */
  kwh: number | null;
  /** A stated range ("55-84 kWh per pack") stays a range. */
  kwhMin: number | null;
  kwhMax: number | null;
  /** Units of this line in a mixed lot. Null when not stated. */
  units: number | null;
  partNumber: string | null;
  make: string | null;
  makeGroup: string | null;
  model: string | null;
  platform: string | null;
  moduleSeries: string | null;
  /** A fact that is stated but must not rule anyone out (a conflict, or a figure that did not parse). */
  unknown: { kwh: boolean; format: boolean; chemistry: boolean };
  /** How the energy figure was read: "37 kWh per pack", "5,220 mAh x 3.6 V", "55-84 kWh per pack". */
  basis: string | null;
};

export type SellerPrice = {
  amount: number;
  currency: string;
  /** What the amount buys. */
  per: "kwh" | "mwh" | "unit";
  eurPerKwh: number | null;
  eurPerUnit: number | null;
  field: string;
};

export type ProductKey = {
  lines: ProductLine[];
  /** Several products in one lot. Never first-number-wins. */
  mixed: boolean;
  units: number | null;
  partNumbers: string[];
  /** Stated chemistries across the lot; more than one means the lot is mixed. */
  chemistries: string[];
  format: KeyFormat | null;
  chemistry: string | null;
  sellerPrice: SellerPrice | null;
  /** Why a stated price was not used, in plain words. */
  priceNote: string | null;
  /** Both values of every conflicting field, for display. */
  conflicts: { field: string; values: string[] }[];
  /** Anything the reader should know before trusting the key. */
  notes: string[];
  /** The text the key came from, for the "Matched on" line. */
  source: { model: string | null; capacity: string | null; chemistry: string | null; format: string | null; quantity: string | null; title: string | null };
};

const FORMAT_WORDS: [RegExp, KeyFormat][] = [
  [/\bmodules?\b/i, "Modules"],
  [/\bpacks?\b|\bbatter(?:y|ies)\b/i, "Packs"],
  [/\bcells?\b|\bprismatic\b|\bpouch\b|\bcylindrical\b|\b18650\b|\b21700\b|\b2170\b|\b4680\b/i, "Cells"],
  [/\bcontainers?\b|\bcabinets?\b|\bbess\b|\bsystems?\b|\bracks?\b/i, "Systems"],
];

const CHEM_WORDS: [RegExp, string][] = [
  [/\blfp\b|\blifepo4\b|\bli-?fe-?po4\b/i, "LFP"],
  [/\bnmc\b/i, "NMC"],
  [/\bnca\b/i, "NCA"],
  [/\blto\b/i, "LTO"],
  [/\blmo\b/i, "LMO"],
  [/\bnimh\b|nickel metal hydride/i, "NiMH"],
  [/\blead[- ]acid\b|\bflooded\b|\bvrla\b|\bagm\b|\bdeep[- ]cycle\b/i, "Lead-acid"],
  [/\bli-?ion\b|\blithium[- ]ion\b/i, "Li-ion"],
];

/** Words that mean the figure is a lot total, not one unit. */
const TOTAL_AFTER = /\b(total|combined|overall|in total|for all|at full)\b/i;
const TOTAL_BEFORE = /\b(total|combined|overall)\b/i;
/** A price that is not a seller's ask. Price ordering is off unless both sides are firm. */
const PRICE_BLOCKERS = /\b(offered|offer|guide|target|indicative|estimate|estimated|not accepted|unresolved|not confirmed|seeking|invited|invites|expected|hoped|reserve|not firm|earlier)\b/i;

const num = (text: string) => Number(text.replace(/,/g, ""));
const clean = (text: string) => text.replace(/\u00a0/g, " ").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const asText = (value: string | null | undefined) => (value ?? "").trim();

/** The value of one field row, or "" when it is missing. */
const fieldValue = (fields: Map<string, FieldFact>, key: string) => asText(fields.get(key)?.value);
const fieldStatus = (fields: Map<string, FieldFact>, key: string): FieldStatus => fields.get(key)?.status ?? "missing";
/** A fact may be shown but not used to rule anyone out when the field is disputed or missing. */
const trusted = (status: FieldStatus) => status === "confirmed" || status === "unverified";

function formatFrom(text: string): KeyFormat | null {
  for (const [re, format] of FORMAT_WORDS) {
    if (re.test(text)) {
      return format;
    }
  }
  return null;
}

/** The format a unit word names: "per module" -> Modules. */
function formatFromUnitWord(word: string): KeyFormat | null {
  const key = word.toLowerCase().replace(/s$/, "");
  if (key === "pack" || key === "battery") {
    return "Packs";
  }
  if (key === "module") {
    return "Modules";
  }
  if (key === "cell") {
    return "Cells";
  }
  if (key === "container" || key === "cabinet" || key === "system" || key === "rack") {
    return "Systems";
  }
  return null;
}

/** Every chemistry the text states, in the order it states them. A chemistry after "not" is an exclusion. */
export function chemistriesIn(text: string): string[] {
  const found: { at: number; value: string }[] = [];
  for (const [re, value] of CHEM_WORDS) {
    const global = new RegExp(re.source, "gi");
    for (const match of text.matchAll(global)) {
      const at = match.index ?? 0;
      const before = text.slice(Math.max(0, at - 14), at).toLowerCase();
      if (/\bnot\s*$|\bno\s*$|rather than\s*$/.test(before)) {
        continue;
      }
      found.push({ at, value });
    }
  }
  const out: string[] = [];
  for (const hit of found.toSorted((a, b) => a.at - b.at)) {
    if (!out.includes(hit.value)) {
      out.push(hit.value);
    }
  }
  // "Li-ion" is what a text says when it names no chemistry: keep it only when nothing else was named.
  return out.length > 1 ? out.filter((value) => value !== "Li-ion") : out;
}

/** Part numbers only from a label ("part no.", "OE", "P/N") or an unmistakable code. Anything unsure stays null. */
export function partNumberIn(text: string): string | null {
  const source = clean(text);
  const labelled = source.match(/\b(?:part\s+(?:no\.?\s*|number\s*|#\s*)?|p\/n\s*[:#]?\s*|oe\s*(?:no\.?|number|ref)?\s*[:#]?\s*|oem\s*(?:no\.?|number)?\s*[:#]?\s*)([A-Za-z0-9][A-Za-z0-9\-/.]{3,})/i);
  if (labelled) {
    return labelled[1].replace(/[.,;:]$/, "");
  }
  // A code: at least six characters, letters and digits, starting with a letter. "SU001B5189", "KCL255103EN1".
  const code = source.match(/\b(?=[A-Z0-9-]{6,}\b)(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z][A-Z0-9-]{4,}[A-Z0-9]\b/);
  if (!code || /^(?:AH|KWH|MWH|VDC|VAC|BESS|LFP|NMC|NCA|ISO|DOD|SOH)$/.test(code[0])) {
    return null;
  }
  // A serial or VIN identifies one unit, not a part.
  const before = source.slice(Math.max(0, (code.index ?? 0) - 24), code.index ?? 0);
  if (/serial|s\/n|\bvin\b/i.test(before)) {
    return null;
  }
  return code[0];
  return null;
}

const MAKE_ACRONYMS: Record<string, string> = { mg: "MG", bmw: "BMW", vw: "VW", byd: "BYD", catl: "CATL", lg: "LG", ds: "DS", fpt: "FPT", jlr: "JLR", gm: "GM", saic: "SAIC" };

const displayMake = (word: string) => MAKE_ACRONYMS[word] ?? word.replace(/\b\w/g, (c) => c.toUpperCase());

function brandIn(text: string): { make: string | null; group: string | null } {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  let best: { at: number; make: string; group: string } | null = null;
  const consider = (word: string, group: string | null) => {
    const at = hay.indexOf(` ${word} `);
    if (at < 0 || (best && best.at <= at)) {
      return;
    }
    best = { at, make: displayMake(word), group: group ?? word };
  };
  for (const [group, words] of Object.entries(MAKE_WORDS)) {
    for (const word of words) {
      consider(word, group);
    }
    // "Stellantis" is both the group's name and what a seller writes.
    const phrase = group.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (phrase && !phrase.includes(" or ")) {
      consider(phrase, group);
    }
  }
  if (best) {
    return { make: (best as { make: string }).make, group: (best as { group: string }).group };
  }
  // "Panasonic NCR2170", "CALB L135F72H", "LG Energy Solution": the cell maker is the make.
  const cell = CELL_MAKERS.find((word) => hay.includes(` ${word} `));
  return cell ? { make: cell.toUpperCase(), group: null } : { make: null, group: null };
}

const PLATFORM_LABEL: Record<string, string> = {
  meb: "MEB", "e-k9": "e-K9", k9: "e-K9", "e-cmp": "e-CMP", "stla-m": "STLA-M", stla: "STLA", proace: "K0", ze1: "ZE1",
};

function platformIn(text: string): string | null {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const [alias, platform] of Object.entries(PLATFORMS)) {
    if (hay.includes(` ${alias} `) || hay.includes(` ${alias.replace("-", " ")} `)) {
      return PLATFORM_LABEL[alias] ?? alias.toUpperCase();
    }
    if (platform.models.some((model) => hay.includes(` ${model} `) && !(platform.not ?? []).some((not) => hay.includes(` ${not} `)))) {
      return PLATFORM_LABEL[alias] ?? alias.toUpperCase();
    }
  }
  return text.match(/\b(stla[- ]m|e-?cmp|e-?k9|k0|egmp|ze1|meb)\b/i)?.[1]?.toUpperCase() ?? null;
}

function moduleSeriesIn(text: string): string | null {
  return text.match(/\b(\d{1,3}s\d{0,3}p?)\b/i)?.[1] ?? null;
}

type Figure = { kwh: number; kwhMin: number | null; kwhMax: number | null; units: number | null; format: KeyFormat | null; basis: string };

/** A lot total, not a unit: "32.2 MWh at full 85,000-cell quantity", "2.52 MWh combined". */
function isTotal(text: string, start: number, end: number): boolean {
  // The clause the figure sits in: "1.75 MWh per container, 3.50 MWh total" is a unit and a total, not two totals.
  const after = text.slice(end, end + 40).split(/[,;]/)[0];
  const before = text.slice(Math.max(0, start - 24), start).split(/[,;]/).pop() ?? "";
  if (TOTAL_AFTER.test(after)) {
    return true;
  }
  if (TOTAL_BEFORE.test(before)) {
    return true;
  }
  // "about 1,165 kWh nominal for 5" and "for 1,400 modules".
  return /\bfor\s+\d/i.test(after);
}

const usableFig = (text: string, start: number) => /\busable\b/i.test(text.slice(Math.max(0, start - 20), start));

/** The unit word that says what one figure is per: "kWh per pack", "6.6 kWh per module". */
function unitWordAfter(text: string, end: number): string | null {
  const after = text.slice(end, end + 46);
  const per = after.match(/\bper\s+(pack|module|cell|container|cabinet|system|unit|battery)\b/i);
  if (per) {
    return per[1];
  }
  const nearby = after.match(/^\s*(?:,|;|·|\()?\s*(packs?|modules?|cells?|containers?|cabinets?|systems?)\b/i);
  return nearby ? nearby[1] : null;
}

/** Energy figures written as kWh, MWh or Wh, with lot totals dropped. `usable` marks "(35 kWh usable)". */
function directFigures(text: string): (Figure & { usable: boolean })[] {
  const out: (Figure & { usable: boolean })[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(kwh|mwh|wh)\b/gi;
  for (const match of text.matchAll(re)) {
    const value = num(match[1]);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const unit = match[2].toLowerCase();
    const kwh = unit === "mwh" ? value * 1000 : unit === "wh" ? value / 1000 : value;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (isTotal(text, start, end)) {
      continue;
    }
    const word = unitWordAfter(text, end);
    out.push({
      kwh: Math.round(kwh * 1e6) / 1e6, kwhMin: null, kwhMax: null, units: null,
      format: word ? formatFromUnitWord(word) : null,
      basis: `${unit === "wh" ? `${value} Wh` : `${value} ${unit.toLowerCase()}`} per ${word ?? "unit"}`,
      usable: usableFig(text, start),
    });
  }
  return out;
}

/** "10 packs at 60 kWh, 14 packs at 44 kWh, 42 modules at 20.7 kWh": several products, each with its count. */
function mixedFigures(text: string): Figure[] {
  const out: Figure[] = [];
  const re = /(\d[\d,]*)\s*(packs?|modules?|cells?|units?|containers?|cabinets?|systems?)\s+(?:at|of|@)\s*(\d+(?:\.\d+)?)\s*(kwh|mwh)\b/gi;
  for (const match of text.matchAll(re)) {
    const units = num(match[1]);
    const value = Number(match[3]);
    const kwh = match[4].toLowerCase() === "mwh" ? value * 1000 : value;
    const format = formatFromUnitWord(match[2]);
    // The same product restated with a different count is one line, with the count it states.
    const twin = out.find((line) => line.kwh === kwh && line.format === format);
    if (twin) { twin.units = (twin.units ?? 0) + units; continue; }
    out.push({ kwh, kwhMin: null, kwhMax: null, units, format, basis: `${units} x ${kwh} kWh` });
  }
  return out;
}

/** "55-84 kWh per pack": a range stays a range. */
function rangeFigure(text: string): Figure | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*kwh\b/i);
  if (!match) {
    return null;
  }
  const lo = Number(match[1]);
  const hi = Number(match[2]);
  if (!(hi > lo) || lo <= 0) {
    return null;
  }
  // "37 kWh nominal (35 kWh usable)" is not a range; a dash between two kWh figures is.
  if (/usable|nominal/i.test(text.slice(Math.max(0, (match.index ?? 0) - 18), (match.index ?? 0) + match[0].length))) {
    return null;
  }
  const word = unitWordAfter(text, (match.index ?? 0) + match[0].length);
  return { kwh: lo, kwhMin: lo, kwhMax: hi, units: null, format: word ? formatFromUnitWord(word) : null, basis: `${lo}-${hi} kWh` };
}

function energyFromAh(text: string): Figure | null {
  const v = text.match(/(?<![a-z])(\d+(?:\.\d+)?)\s*(?:v|vdc|vac)\b/i);
  if (!v) {
    return null;
  }
  const volts = Number(v[1]);
  if (!(volts > 0.5 && volts < 1500)) {
    return null;
  }
  const mah = [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*mah\b/gi)];
  let ampHours: number | null = null;
  if (mah.length) {
    const typical = mah.find((match) => /typical/i.test(text.slice(Math.max(0, (match.index ?? 0) - 30), match.index ?? 0)));
    ampHours = num((typical ?? mah[0])[1]) / 1000;
  } else {
    const ah = text.match(/(?<![a-z])(\d[\d,]*(?:\.\d+)?)\s*ah\b/i);
    if (ah) {
      ampHours = num(ah[1]);
    }
  }
  if (ampHours == null || !(ampHours > 0)) {
    return null;
  }
  const kwh = (ampHours * volts) / 1000;
  const word = unitWordAfter(text, (v.index ?? 0) + v[0].length) ?? text.match(/\bper\s+(cell|module|pack)\b/i)?.[1] ?? null;
  return {
    kwh: Math.round(kwh * 1e6) / 1e6, kwhMin: null, kwhMax: null, units: null,
    format: word ? formatFromUnitWord(word) : null, basis: `${ampHours >= 1 ? ampHours : Math.round(ampHours * 1000)} ${ampHours >= 1 ? "Ah" : "mAh"} x ${volts} V`,
  };
}

/** Every product line a capacity field states. */
function figuresIn(text: string): { figures: Figure[]; note: string | null } {
  if (!text) {
    return { figures: [], note: null };
  }
  const source = clean(text);
  const mixed = mixedFigures(source);
  if (mixed.length >= 2) {
    return { figures: mixed, note: null };
  }
  const range = rangeFigure(source);
  if (range) {
    return { figures: [range], note: null };
  }
  const direct = directFigures(source);
  // "37 kWh nominal (35 kWh usable)": the nominal figure is what one pack holds.
  const nominal = direct.filter((figure) => !figure.usable);
  const chosen = nominal[0] ?? direct[0] ?? null;
  if (chosen) {
    return { figures: [chosen], note: null };
  }
  const ah = energyFromAh(source);
  if (ah) {
    return { figures: [ah], note: null };
  }
  return { figures: [], note: /total|combined|for \d/i.test(source) ? "Capacity is stated as a lot total, not per unit" : "Capacity text has no energy figure" };
}

/** "100,000 cells; smaller quantities possible" -> 100000. A disputed count stays unknown. */
function unitsIn(text: string): number | null {
  if (!text) {
    return null;
  }
  const match = clean(text).match(/(\d[\d,]*)\s*(packs?|modules?|cells?|units?|containers?|cabinets?|systems?)\b/i);
  return match ? num(match[1]) : null;
}

/** A seller price, only when it is one firm amount in one currency with a unit. */
function priceOf(text: string, status: FieldStatus): { price: SellerPrice | null; note: string | null } {
  if (!text) {
    return { price: null, note: null };
  }
  if (status === "missing") {
    return { price: null, note: "No seller price stated" };
  }
  if (status === "conflict") {
    return { price: null, note: "Seller price is disputed, so it is not used" };
  }
  if (status !== "confirmed") {
    return { price: null, note: "Seller price is not confirmed, so it is not used" };
  }
  const source = clean(text);
  const blocked = source.match(PRICE_BLOCKERS);
  if (blocked) {
    return { price: null, note: `Seller price is not firm ("${blocked[1]}")` };
  }
  const values: { amount: number; currency: string; at: number }[] = [];
  const symbols: Record<string, string> = { "£": "GBP", "€": "EUR", $: "USD" };
  const add = (amount: number, currency: string, at: number) => {
    if (!Number.isFinite(amount)) {
      return;
    }
    // "USD 0.76 per cell, USD 516,800 total": the same amount seen twice is one amount.
    if (values.some((value) => value.at === at || (value.amount === amount && value.currency === currency))) {
      return;
    }
    values.push({ amount, currency, at });
  };
  for (const match of source.matchAll(/([£€$])\s*(\d[\d,]*(?:\.\d+)?)/g)) {
    add(num(match[2]), symbols[match[1]], match.index ?? 0);
  }
  for (const match of source.matchAll(/\b(GBP|EUR|USD)\s*(\d[\d,]*(?:\.\d+)?)/gi)) {
    add(num(match[2]), match[1].toUpperCase(), match.index ?? 0);
  }
  for (const match of source.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(GBP|EUR|USD)\b/gi)) {
    add(num(match[1]), match[2].toUpperCase(), match.index ?? 0);
  }
  const currencies = new Set(values.map((value) => value.currency));
  if (!values.length) {
    return { price: null, note: "Seller price has no amount in a known currency" };
  }
  if (currencies.size > 1) {
    return { price: null, note: "Seller price mixes currencies" };
  }
  if (values.length > 1) {
    return { price: null, note: "Seller price states more than one amount" };
  }
  const value = values[0];
  const per = source.match(/\bper\s*(kwh|mwh|pack|module|cell|unit|kg)\b/i)?.[1]?.toLowerCase();
  const unitPrice = per === "pack" || per === "module" || per === "cell" || per === "unit";
  if (!per) {
    return { price: null, note: "Seller price has no unit, so it is not used" };
  }
  const fx = EUR_PER[value.currency] ?? null;
  if (fx == null) {
    return { price: null, note: `Seller price is in ${value.currency}, which has no FX rate` };
  }
  const eur = value.amount * fx;
  if (per === "kwh") {
    return { price: { amount: value.amount, currency: value.currency, per: "kwh", eurPerKwh: eur, eurPerUnit: null, field: "seller_price" }, note: null };
  }
  if (per === "mwh") {
    return { price: { amount: value.amount, currency: value.currency, per: "mwh", eurPerKwh: eur / 1000, eurPerUnit: null, field: "seller_price" }, note: null };
  }
  if (!unitPrice) {
    return { price: null, note: `Seller price is per ${per}, which cannot be compared` };
  }
  return { price: { amount: value.amount, currency: value.currency, per: "unit", eurPerKwh: null, eurPerUnit: eur, field: "seller_price" }, note: null };
}

/**
 * The product key for one listing: its field rows plus the title/summary text.
 * Nothing here calls a model; the same input always yields the same key.
 */
export function buildProductKey(input: { fields: FieldFact[]; title?: string | null }): ProductKey {
  const fields = new Map(input.fields.map((row) => [row.field_key, row]));
  const title = asText(input.title);
  const modelText = fieldValue(fields, "model");
  const capacityText = fieldValue(fields, "capacity") || fieldValue(fields, "energy");
  const capacityStatus = fieldValue(fields, "capacity") ? fieldStatus(fields, "capacity") : fieldStatus(fields, "energy");
  const chemistryText = fieldValue(fields, "chemistry");
  const formatText = fieldValue(fields, "format");
  const quantityText = fieldValue(fields, "quantity");
  const notes: string[] = [];
  const conflicts: { field: string; values: string[] }[] = [];

  for (const key of ["model", "capacity", "chemistry", "format", "quantity", "seller_price"]) {
    const row = fields.get(key);
    if (!row || row.status !== "conflict") {
      continue;
    }
    const values = [asText(row.value), ...(Array.isArray(row.alternatives) ? row.alternatives : [])]
      .map((item) => (typeof item === "string" ? item : typeof item === "object" && item && "value" in item ? String((item as { value: unknown }).value ?? "") : ""))
      .filter(Boolean);
    conflicts.push({ field: key, values: [...new Set(values)] });
  }

  const searchText = [modelText, title].filter(Boolean).join(" ");
  const partNumber = partNumberIn(searchText);
  const brand = brandIn(`${modelText} ${title}`);
  const platform = platformIn(`${modelText} ${title}`);
  const series = moduleSeriesIn(modelText) ?? moduleSeriesIn(capacityText);
  const chemistries = chemistriesIn(chemistryText || `${modelText} ${title}`);
  const chemStatus = chemistryText ? fieldStatus(fields, "chemistry") : "missing";
  const chemKnown = trusted(chemStatus) && chemistries.length === 1;
  const formatField = formatText ? formatFrom(formatText) : null;
  const formatKnown = !!formatText && trusted(fieldStatus(fields, "format"));
  const format = formatField ?? formatFrom(`${capacityText} ${modelText} ${title}`);

  const parsed = figuresIn(capacityText);
  if (parsed.note) {
    notes.push(parsed.note);
  }
  const capacityTrusted = capacityStatus !== "missing" && trusted(capacityStatus);
  const figures = parsed.figures;

  const lines: ProductLine[] = figures.length
    ? figures.map((figure) => ({
      format: figure.format ?? format,
      chemistry: chemKnown ? chemistries[0] : null,
      kwh: figure.kwhMin != null ? null : figure.kwh,
      kwhMin: figure.kwhMin,
      kwhMax: figure.kwhMax,
      units: figure.units,
      partNumber, make: brand.make, makeGroup: brand.group,
      model: modelText || title || null,
      platform, moduleSeries: series,
      unknown: {
        // A disputed kWh figure is shown but never compared.
        kwh: !capacityTrusted || (figure.kwhMin == null && !(figure.kwh > 0)),
        format: !formatKnown && !figure.format,
        chemistry: !chemKnown,
      },
      basis: figure.basis,
    }))
    : [{
      format, chemistry: chemKnown ? chemistries[0] : null, kwh: null, kwhMin: null, kwhMax: null, units: null,
      partNumber, make: brand.make, makeGroup: brand.group, model: modelText || title || null, platform, moduleSeries: series,
      unknown: { kwh: true, format: !formatKnown, chemistry: !chemKnown }, basis: null,
    }];

  const mixed = figures.length > 1;
  const unitsField = unitsIn(quantityText);
  const quantityStatus = fieldStatus(fields, "quantity");
  const units = quantityStatus === "conflict" || quantityStatus === "missing" ? null : unitsField;
  if (quantityStatus === "conflict") {
    notes.push("Quantity is disputed, so the unit count is left open");
  }
  const lineUnits = lines.reduce<number | null>((total, line) => (line.units == null ? total : (total ?? 0) + line.units), null);
  if (lineUnits != null && units != null && lineUnits !== units) {
    notes.push(`Mixed lot counts add up to ${lineUnits}; the quantity field says ${units}`);
  }

  const price = priceOf(fieldValue(fields, "seller_price"), fieldStatus(fields, "seller_price"));
  if (price.note) {
    notes.push(price.note);
  }

  return {
    lines,
    mixed,
    units: lineUnits ?? units,
    partNumbers: partNumber ? [partNumber] : [],
    chemistries,
    format,
    chemistry: chemKnown ? chemistries[0] : null,
    sellerPrice: price.price,
    priceNote: price.note,
    conflicts,
    notes,
    source: {
      model: modelText || null, capacity: capacityText || null, chemistry: chemistryText || null,
      format: formatText || null, quantity: quantityText || null, title: title || null,
    },
  };
}

const kwhLabel = (value: number) => `${Math.round(value * 1000) / 1000} kWh`;

/** "37 kWh per pack · Packs · NMC · 40 units": the one-line "Matched on" the tab shows collapsed. */
export function keyLine(key: ProductKey): string {
  const line = key.lines[0];
  if (!line) {
    return "No product facts";
  }
  const parts: string[] = [];
  if (key.mixed) {
    parts.push(`${key.lines.length} products`);
  }
  if (key.partNumbers.length) {
    parts.push(`part ${key.partNumbers[0]}`);
  }
  if (line.make) {
    parts.push(line.make);
  }
  if (key.mixed) {
    for (const item of key.lines) {
      const size = item.kwhMin != null ? `${item.kwhMin}-${item.kwhMax} kWh` : item.kwh != null ? kwhLabel(item.kwh) : "kWh unknown";
      parts.push(`${item.units ?? "?"} x ${size} ${(item.format ?? "units").toLowerCase()}`);
    }
  } else {
    const model = line.make && line.model ? line.model.replace(new RegExp(`^${line.make}\\s+`, "i"), "") : line.model;
    if (model && model !== line.make) {
      parts.push(model);
    }
    if (line.kwhMin != null) {
      parts.push(`${line.kwhMin}-${line.kwhMax} kWh`);
    }
    else if (line.kwh != null) {
      parts.push(kwhLabel(line.kwh));
    }
    else {
      parts.push("kWh unknown");
    }
    if (line.format) {
      parts.push(line.format);
    }
    if (line.chemistry) {
      parts.push(line.chemistry);
    }
    if (key.units != null) {
      parts.push(`${key.units} units`);
    }
  }
  return parts.join(" · ");
}
