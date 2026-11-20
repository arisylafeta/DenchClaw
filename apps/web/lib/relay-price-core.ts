import { KWH_TOLERANCE, lineFor, parseLines, type DemandLine, type LineCandidate } from "./demand-lines";
import { requirementFor, type DemandAsk, type Requirement } from "./demand-match";
import { PACK_FAMILIES } from "./match/pack-families";
import { fillGaps, segments } from "./relay-ways-core";
import type { Money, PriceFill, StockFit } from "./relay-price-types";

/**
 * Relay's prices, the pure part: what a buyer's email asks for, which stock fits it best, what Relay would charge for
 * each fit and how it got there, and how those prices fill the price gaps in a draft. relay-price.ts does the reading.
 *
 * A price is never invented: supplier stock is its cost plus Alex's margin, marketplace stock is its listed price
 * (which already holds our commission), and anything with neither stays a gap that blocks sending. Delivery has no
 * rates yet, so every price is for collection and a delivered ask is flagged for a transport quote.
 */

/** Alex's margin on supplier stock: 12% of cost with a £300 minimum, the same for returning buyers, rounded to £10. */
export const MARGIN = { share: 0.12, minimumGbp: 300, roundToGbp: 10 } as const;
/** An exchange rate older than this is still used, with a warning. */
export const FX_STALE_DAYS = 14;
/** How many fits Relay offers for one email. */
export const MAX_FITS = 6;

/** Pounds per euro and per dollar, and where and when the rate comes from. */
export type Fx = { gbpPerEur: number; gbpPerUsd: number | null; date: string; source: string };

/** The latest Penny card for one battery (`crm_price_cards`): GBP per usable kWh, quick to patient. */
export type PennyCard = {
  battery_key: string; battery: string; segment: string; kwh_usable: number;
  quick_gbp_kwh: number | null; expected_gbp_kwh: number | null; patient_gbp_kwh: number | null;
  confidence: string; created_at: string;
};

export type PriceOptions = {
  /** The Penny card for this battery (pennyCardFor), or null when Penny has none. */
  penny: PennyCard | null;
  fx: Fx;
  now: Date;
  /** The buyer asked for a delivered price. */
  askedDelivered: boolean;
};

const DAY_MS = 86_400_000;
const gbp = (amount: number, pence = false) => `£${amount.toLocaleString("en-GB", { minimumFractionDigits: pence ? 2 : 0, maximumFractionDigits: pence ? 2 : 0 })}`;
const money = (m: Money) => {
  const sign = m.currency === "GBP" ? "£" : m.currency === "EUR" ? "€" : "$";
  const pence = !Number.isInteger(m.amount);
  return `${sign}${m.amount.toLocaleString("en-GB", { minimumFractionDigits: pence ? 2 : 0, maximumFractionDigits: 2 })}`;
};
const longDay = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Money in pounds, with the working line for the exchange; null (and a working line) when there is no rate for it. */
function inGbp(m: Money, fx: Fx, now: Date, working: string[], warnings: string[]): number | null {
  if (m.currency === "GBP") return m.amount;
  const rate = m.currency === "EUR" ? fx.gbpPerEur : fx.gbpPerUsd;
  const sign = m.currency === "EUR" ? "€" : "$";
  if (!rate || !(rate > 0)) {
    working.push(`No exchange rate for ${m.currency}, so Relay can't put it in pounds.`);
    return null;
  }
  const out = m.amount * rate;
  working.push(`At ${sign}1 = £${rate.toFixed(5).replace(/\.?0+$/, "")} (${fx.source}, ${longDay(fx.date)}): ${gbp(Math.round(out * 100) / 100, !Number.isInteger(Math.round(out * 100) / 100))}.`);
  const age = Math.floor((now.getTime() - Date.parse(`${fx.date.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
  if (!(age <= FX_STALE_DAYS)) warnings.push(`The exchange rate is ${Number.isFinite(age) ? `${age} days` : "of unknown"} old (${fx.date.slice(0, 10)}).`);
  return out;
}

/** Penny's quick to patient range for one pack, in whole pounds, or null when the card has no prices. */
export function pennyRange(card: PennyCard | null): { low: number; expected: number | null; high: number } | null {
  if (!card || card.quick_gbp_kwh == null || card.patient_gbp_kwh == null || !(card.kwh_usable > 0)) return null;
  const round = (perKwh: number) => Math.round((perKwh * card.kwh_usable) / MARGIN.roundToGbp) * MARGIN.roundToGbp;
  return { low: round(card.quick_gbp_kwh), expected: card.expected_gbp_kwh == null ? null : round(card.expected_gbp_kwh), high: round(card.patient_gbp_kwh) };
}

const VALUE_WARNING = /is below cost|Penny's (quick|patient) price/;

/** What a value says against cost and Penny's range. Shown, never blocking. */
export function valueWarnings(value: number | null, floor: number | null | undefined, range: { low: number; high: number } | null | undefined): string[] {
  if (value == null) return [];
  const out: string[] = [];
  if (floor != null && value < floor) out.push(`${gbp(value)} is below cost (${gbp(floor)}).`);
  if (range && value < range.low) out.push(`${gbp(value)} is below Penny's quick price (${gbp(range.low)}).`);
  if (range && value > range.high) out.push(`${gbp(value)} is above Penny's patient price (${gbp(range.high)}).`);
  return out;
}

/**
 * Relay's price for one fit, collected, with its working in order: cost, exchange rate, margin, delivery, Penny.
 * Supplier stock: cost in pounds plus MARGIN, rounded to £10 and never below cost. Marketplace stock: the listed
 * price, which already holds our commission, rounded up to the pound. No cost and no listed price: value is null.
 */
export function priceFor(fit: StockFit, { penny, fx, now, askedDelivered }: PriceOptions): PriceFill {
  const working: string[] = [];
  const warnings: string[] = [];
  let value: number | null = null;
  let floor: number | null = null;
  if (fit.kind === "marketplace") {
    if (!fit.listed || !(fit.listed.amount > 0)) {
      working.push("The listing has no price, so Relay has nothing to work from.");
    } else {
      working.push(`Listed on the marketplace at ${money(fit.listed)}, which already includes our commission.`);
      const listed = inGbp(fit.listed, fx, now, working, warnings);
      if (listed != null) value = floor = Math.ceil(listed - 1e-9);
    }
  } else if (!fit.cost || !(fit.cost.amount > 0)) {
    working.push("The supplier hasn't given a price, so Relay has nothing to work from.");
  } else {
    working.push(`The supplier wants ${money(fit.cost)}.`);
    const cost = inGbp(fit.cost, fx, now, working, warnings);
    if (cost != null) {
      floor = Math.ceil(cost - 1e-9);
      const margin = Math.max(cost * MARGIN.share, MARGIN.minimumGbp);
      value = Math.max(Math.round((cost + margin) / MARGIN.roundToGbp) * MARGIN.roundToGbp, floor);
      const rule = `${Math.round(MARGIN.share * 100)}% of cost, at least ${gbp(MARGIN.minimumGbp)}`;
      working.push(`Plus margin ${gbp(Math.round(margin))} (${rule}): ${gbp(value)} to the nearest ${gbp(MARGIN.roundToGbp)}.`);
    }
  }
  if (askedDelivered) working.push("Delivery isn't included: it needs a quote from the transport partner.");
  const range = pennyRange(penny);
  if (!penny) {
    working.push("No Penny price yet.");
  } else if (!range) {
    working.push(`Penny has a card for ${penny.battery} but no price yet.`);
  } else {
    const expected = range.expected != null ? `, ${gbp(range.expected)} expected` : "";
    working.push(`Penny: ${gbp(range.low)} quick${expected}, ${gbp(range.high)} patient (${penny.battery}, ${penny.confidence.toLowerCase()} confidence, ${longDay(penny.created_at)}).`);
  }
  warnings.push(...valueWarnings(value, floor, range));
  return {
    key: fit.key, label: fit.label, value, basis: "collected", working, warnings,
    needsDeliveryQuote: askedDelivered, by: "relay", floor, pennyRange: range ? { low: range.low, high: range.high } : null,
  };
}

/** Alex's own value on a fill: his, with the value warnings worked out again for it. Null clears it (the gap reopens). */
export function alexFill(fill: PriceFill, value: number | null): PriceFill {
  return { ...fill, value, by: "alex", warnings: [...fill.warnings.filter((w) => !VALUE_WARNING.test(w)), ...valueWarnings(value, fill.floor, fill.pennyRange)] };
}

/** A fill for a price gap Relay has no stock for (the stock went, or the key is unknown): an open gap, saying why. */
export function missingFill(key: string, label: string, askedDelivered: boolean): PriceFill {
  return {
    key, label, value: null, basis: "collected", working: ["Relay can't find this stock any more, so it has no price for it."],
    warnings: [], needsDeliveryQuote: askedDelivered, by: "relay", floor: null, pennyRange: null,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const wholeOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

/** Fills as stored on relay_draft.fills, with anything malformed dropped. */
export function parseFills(raw: unknown): PriceFill[] {
  if (!Array.isArray(raw)) return [];
  const out: PriceFill[] = [];
  for (const f of raw) {
    if (!isRecord(f) || typeof f.key !== "string" || !REF_KEY.test(f.key) || out.some((x) => x.key === f.key)) continue;
    const range = isRecord(f.pennyRange) && typeof f.pennyRange.low === "number" && typeof f.pennyRange.high === "number" ? { low: f.pennyRange.low, high: f.pennyRange.high } : null;
    out.push({
      key: f.key, label: typeof f.label === "string" ? f.label : "", value: wholeOrNull(f.value), basis: f.basis === "delivered" ? "delivered" : "collected",
      working: strings(f.working), warnings: strings(f.warnings), needsDeliveryQuote: f.needsDeliveryQuote === true, by: f.by === "alex" ? "alex" : "relay",
      floor: wholeOrNull(f.floor), pennyRange: range,
    });
  }
  return out;
}

/** The largest price Alex can type, in whole pounds. */
export const MAX_FILL_GBP = 10_000_000;
/** A value Alex sends for a fill: whole pounds from 1, or null to clear it. */
export function fillValue(raw: unknown): { value: number | null } | { error: string } {
  if (raw === null) return { value: null };
  const n = typeof raw === "string" && /^\s*£?\s*[\d,]+\s*$/.test(raw) ? Number(raw.replace(/[£,\s]/g, "")) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_FILL_GBP) return { error: "The price must be whole pounds, from £1." };
  return { value: n };
}

// ---------- price gaps in a draft ----------

/** A stock key in a marker: "stock:sto_…" or "market:<listing id>". */
const REF_KEY = /^(stock|market):[\w.:-]{1,120}$/;
const REF = /\(ref ((?:stock|market):[\w.:-]{1,120})\)/;

/** The gap marker a writer puts where a price goes: [BLANK: price for <label> (ref <key>)]. */
export function priceGapMarker(fit: Pick<StockFit, "key" | "label">): string {
  const label = fit.label.replace(/[[\]()]/g, " ").replace(/\s+/g, " ").trim();
  return `[BLANK: price for ${label} (ref ${fit.key})]`;
}

/** The stock key a price gap names, from the whole marker or its label; null for any other gap. */
export function priceGapRef(markerText: string): string | null {
  return markerText.match(REF)?.[1] ?? null;
}

/** The price gaps in a draft, in order and once each: their key and the label without "price for" and the ref. */
export function priceGaps(body: string): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  for (const s of segments(body)) {
    if (!("gap" in s)) continue;
    const key = priceGapRef(s.gap);
    if (key && !out.some((g) => g.key === key)) out.push({ key, label: s.gap.replace(REF, "").replace(/^price (?:for|of)\s+/i, "").trim() });
  }
  return out;
}

/** "£4,500": how a filled price reads in the email. */
export const fillText = (value: number) => gbp(value);

const filledValue = (gap: string, byKey: Map<string, number>) => {
  const key = priceGapRef(gap);
  return key != null && byKey.has(key) ? fillText(byKey.get(key)!) : undefined;
};

/** The draft with every price gap whose fill has a value written in. Other gaps, and price gaps with no value, stay. */
export function applyFills(body: string, fills: readonly PriceFill[]): string {
  const byKey = new Map(fills.filter((f) => f.value != null).map((f) => [f.key, f.value!]));
  return fillGaps(body, segments(body).flatMap((s) => ("gap" in s ? [filledValue(s.gap, byKey)] : [])));
}

/** The gaps applyFills would leave open, as their labels: everything that still blocks sending. */
export function unfilledGaps(body: string, fills: readonly PriceFill[]): string[] {
  const byKey = new Map(fills.filter((f) => f.value != null).map((f) => [f.key, f.value!]));
  return segments(body).flatMap((s) => ("gap" in s && filledValue(s.gap, byKey) == null ? [s.gap] : []));
}

/** True when the values Alex's page showed for the draft's price gaps are the ones stored now. */
export function sameFills(body: string, stored: readonly PriceFill[], seen: readonly { key: string; value: number | null }[]): boolean {
  return priceGaps(body).every(({ key }) => (stored.find((f) => f.key === key)?.value ?? null) === (seen.find((f) => f.key === key)?.value ?? null));
}

/** Fills after a re-price: Alex's are kept whatever Relay works out; Relay's are replaced, in the draft's order. */
export function mergeFills(current: readonly PriceFill[], fresh: readonly PriceFill[]): PriceFill[] {
  const alex = current.filter((f) => f.by === "alex");
  return [...fresh.map((f) => alex.find((a) => a.key === f.key) ?? f), ...alex.filter((a) => !fresh.some((f) => f.key === a.key))];
}

// ---------- what the email asks for ----------

/** What Relay reads from a buyer's email: the requirement Matcha's matching judges stock by, their pack types, and how. */
export type Ask = {
  requirement: Requirement;
  lines: DemandLine[];
  /** The words read, for the working: the ask's sentences, not the whole email. */
  text: string;
  /** They want it delivered (a delivered price needs a transport quote). */
  delivered: boolean;
  /** "Reasonably new", "recent": newer stock ranks first. */
  recent: boolean;
  /** Marketplace listings the email links to (their slugs): those rank first. */
  listings: string[];
};

const ASK_SENTENCE = /\?|\b(price|prices|quote|cost|how much|looking for|need|needs|want|wants|wanted|interested|after|buy|source|require|requirement)\b/i;
const KWH_LIST = /((?:\d+(?:[.,]\d+)?\s*(?:kwh)?\s*(?:\/|,|or|and|&)\s*)*\d+(?:[.,]\d+)?)\s*kwh/gi;
const RANGE = /(\d+(?:\.\d+)?)\s*(?:kwh)?\s*(?:–|-|to)\s*(\d+(?:\.\d+)?)\s*kwh/i;
const DELIVERED = /\b(deliver(?:y|ed|ing)?|ship(?:ped|ping)? (?:it )?to|ddp|dap|sent to|send (?:it )?to)\b/i;
const RECENT = /\b(new|newer|newest|recent|young|latest|low mileage|low miles)\b/i;
// One make under two names, so "VW" in an ask still takes a stock line that says "Volkswagen".
const MAKE_SYNONYMS: string[][] = [["vw", "volkswagen"], ["mercedes", "mercedes-benz"], ["skoda", "škoda"]];

const LIST_LINE = /^\s*(?:[-*•–]\s*(?=[a-z0-9£€$])|\d+\s*(?:x|×)\s)/i;
const LISTING_URL = /rebattery\.io\/marketplace\/([a-z0-9][a-z0-9-]{2,120})/gi;

/**
 * The sentences that ask for something, and the lines of any list (what follows "a quote for the following:"); the
 * whole text when none does. "I couldn't fit all the modules from an 82kWh pack" is not the ask.
 */
export function askSentences(text: string): string {
  const lines = text.replace(/\r/g, "").split(/\n+/);
  const listed = lines.filter((l) => LIST_LINE.test(l)).map((l) => l.replace(LIST_LINE, "").trim());
  const sentences = lines.filter((l) => !LIST_LINE.test(l)).join("\n").split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const asking = [...sentences.filter((s) => ASK_SENTENCE.test(s)), ...listed];
  return (asking.length ? asking : sentences).join(" ");
}

/**
 * Words that are English, not a model, though some stock line's model or description uses them ("as", "long",
 * "listed"). Read from an email, they would each become a product the stock must name.
 */
const NOT_MODELS = new Set(`a am an and are as at be been but by can could do does for from go had has have he her his how i if in into is it its
  me my no not of on or our out over please so than that the their them then there these they this those to too up us was we were what when where
  which who why will with would you your yours also just only very more most less such same other another each every both either some many much few
  long short big small first last next per via about above below after again further once off own here all any may might must should shall
  listed list listing listings price prices pricing quote quotes quoted total include including included includes thank thanks regards hello hi
  dear kind current currently reasonably style type conversion conversions project replacement available availability condition used tested
  test testing warranty workshop installation install installed fitting fit fitted vehicle vehicles price delivery delivered transport shipping
  container deposit motor motors pump pumps waterpumps pedal pedals connector connectors kit kits sport line edition best confirm send details
  detail mileage age year years month months week weeks day days today tomorrow interest interested looking need needs want wants wanted buy
  buying sell selling source sourcing supply supplier customer customers order orders unit units piece pieces item items number full whole half
  part parts spare spares working work works good great fine ok okay yes thing things way ways time times one two three four five six seven eight
  nine ten`.split(/\s+/).filter(Boolean));
// "Model S" and "Model 3" are models in two words, which the requirement would read as just "model".
const TWO_WORD_MODEL = /\bmodel\s+([sxy3])\b/gi;
// An enclosure, casing or lid is not a battery, unless that is what they ask for.
const NOT_A_BATTERY = /\b(enclosure|casing|housing|empty|no cells|without cells|lid|cover|tray|frame|junction box|bms only)\b/i;

/** True when a stock line is a part of a pack's shell rather than a battery, and the ask is not for one. */
export function shellOnly(title: string, ask: Pick<Ask, "text">): boolean {
  return NOT_A_BATTERY.test(title) && !NOT_A_BATTERY.test(ask.text);
}

/** Every capacity an ask names: "55kWh or 62kWh" and "55/62 kWh" are both 55 and 62; "60–80 kWh" is a range. */
export function askKwh(text: string): Requirement["kwh"] {
  const t = text.replace(/(\d),(\d{3})\b/g, "$1$2");
  const range = t.match(RANGE);
  if (range && Number(range[2]) > Number(range[1])) return { min: Number(range[1]), max: Number(range[2]) };
  const options = new Set<number>();
  for (const m of t.matchAll(KWH_LIST)) {
    for (const n of m[1].split(/kwh|\/|,(?!\d)|\bor\b|\band\b|&/i)) {
      const v = Number(n.trim().replace(",", "."));
      if (v > 0.5 && v < 5000) options.add(v);
    }
  }
  return options.size ? { options: [...options] } : null;
}

/**
 * What a buyer's email asks for, read the way Matcha reads a request (requirementFor), from the sentences that ask.
 * `texts`: their newest emails' own words and the item's headline. `vocab`: the make and model words stock uses.
 */
export function readAsk(texts: string[], vocab: Set<string>): Ask {
  const all = texts.join("\n");
  const text = askSentences(all).replace(/([a-z])\/([a-z])/gi, "$1 / $2").slice(0, 2000);
  const demand: DemandAsk = {
    wants: text, spec: {}, product_family: null, quantity: null, location: null, volume: null, volume_unit: null,
    max_price: null, price_currency: null, price_unit: null,
  };
  const words = new Set([...vocab].filter((w) => !NOT_MODELS.has(w)));
  const requirement = requirementFor(demand, words);
  const two = [...new Set([...text.matchAll(TWO_WORD_MODEL)].map((m) => `model ${m[1].toLowerCase()}`))];
  if (two.length) {
    const named = requirement.products.length > 0;
    requirement.products = [...two.map((phrase) => ({ phrase, anyOf: [phrase], not: [] })), ...requirement.products.filter((p) => p.phrase !== "model")];
    const shown = requirement.products.map((p) => p.phrase.replace(/\b\w/g, (c) => c.toUpperCase())).join(" / ");
    requirement.pinned = [shown, ...requirement.pinned.slice(named ? 1 : 0)];
  }
  const kwhAsked = askKwh(text);
  if (kwhAsked) {
    // requirementFor reads one figure of "55kWh or 62kWh"; the ask names both, and what it pins down says so.
    requirement.kwh = kwhAsked;
    const said = "options" in kwhAsked ? `${kwhAsked.options.join(" / ")} kWh` : `${kwhAsked.min}–${kwhAsked.max} kWh`;
    const at = requirement.pinned.findIndex((p) => /kWh$/.test(p));
    if (at >= 0) requirement.pinned[at] = said;
    else requirement.pinned.splice(requirement.products.length ? 1 : 0, 0, said);
  }
  for (const names of MAKE_SYNONYMS) {
    if (names.some((n) => requirement.makeWords.includes(n))) for (const n of names) if (!requirement.makeWords.includes(n)) requirement.makeWords.push(n);
  }
  const products = [...new Set([...requirement.products.map((p) => p.phrase.toLowerCase()), ...requirement.makeWords])].slice(0, 10);
  const kwh = requirement.kwh && "options" in requirement.kwh ? requirement.kwh.options.slice(0, 6) : [];
  const parsed = products.length || kwh.length
    ? parseLines([{ label: (requirement.pinned.join(", ") || "What they asked for").slice(0, 80), products, kwh, qty_min: requirement.unitsNeeded ?? 1 }])
    : { value: [] };
  return {
    requirement, lines: "value" in parsed ? parsed.value : [], text,
    listings: [...new Set([...all.matchAll(LISTING_URL)].map((m) => m[1].toLowerCase()))],
    delivered: DELIVERED.test(all) && !/\b(collect|collection|pick(?:ing)? (?:it )?up)\b/i.test(askSentences(all)), recent: RECENT.test(text),
  };
}

// ---------- ranking ----------

const fold = (v: string | null | undefined) => (v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The capacities that mean the same physical pack: the stated one, plus its reviewed family's (gross and usable, so an
 * ID.3 sold as 58 kWh and its 62 kWh label are one pack). Only families in match/pack-families.ts count.
 */
export function packKwhs(make: string | null, model: string | null, kwh: number): number[] {
  const name = fold(model).replace(new RegExp(`^${fold(make)}`), "");
  const family = PACK_FAMILIES.find((f) => f.modelPrefixes.some((p) => name.startsWith(p)) && f.kwh.some((k) => Math.abs(k - kwh) <= 1.5));
  return [...new Set([kwh, ...(family?.kwh ?? [])])];
}

/** How well a stock line fits the buyer's pack types: 0 fits (within 5%), 1 close (kWh not stated), 2 matched only loosely. */
export function lineTier(lines: DemandLine[], c: LineCandidate): 0 | 1 | 2 {
  if (!lines.length) return 2;
  const kwhs = c.kwh != null && !c.kwhEstimated ? packKwhs(c.make, c.model, c.kwh) : [null];
  let best: 0 | 1 | 2 = 2;
  for (const kwh of kwhs) {
    const fit = lineFor({ ...c, kwh }, lines);
    if (fit?.state === "fits") return 0;
    if (fit?.state === "close") best = 1;
  }
  return best;
}

export type RankedFit = {
  fit: StockFit;
  /** A listing the email links to. */
  named: boolean;
  tier: 0 | 1 | 2;
  /** Matcha's verdict: exact when everything the ask names is confirmed. */
  exact: boolean;
  /** Rough pounds, for ordering only. */
  roughGbp: number | null;
};

/** A pack under this state of health ranks after the others: few buyers of one pack want it. */
export const WORN_SOH = 70;

/**
 * Best fit first: the buyer's pack type, then Matcha's verdict, then a price to quote, then a state of health of at
 * least WORN_SOH, then newer stock (when they asked for new) or the cheaper. One per supplier comes first, so Alex sees his options before a second pack from
 * the same seller.
 */
export function rankFits(rows: RankedFit[], recent: boolean, limit = MAX_FITS): StockFit[] {
  const year = (r: RankedFit) => r.fit.year ?? 0;
  const price = (r: RankedFit) => r.roughGbp ?? Number.MAX_SAFE_INTEGER;
  const worn = (r: RankedFit) => r.fit.soh != null && r.fit.soh < WORN_SOH;
  const sorted = rows.toSorted((a, b) => Number(b.named) - Number(a.named)
    || a.tier - b.tier
    || Number(b.exact) - Number(a.exact)
    || Number(b.roughGbp != null) - Number(a.roughGbp != null)
    || Number(worn(a)) - Number(worn(b))
    || (recent ? year(b) - year(a) || price(a) - price(b) : price(a) - price(b) || year(b) - year(a))
    || (b.fit.soh ?? 0) - (a.fit.soh ?? 0)
    || a.fit.key.localeCompare(b.fit.key));
  const picked: RankedFit[] = [];
  const sellers = new Set<string>();
  for (const r of sorted) {
    if (picked.length >= limit) break;
    const seller = fold(r.fit.supplier.name) || r.fit.key;
    if (sellers.has(seller)) continue;
    sellers.add(seller);
    picked.push(r);
  }
  for (const r of sorted) if (picked.length < limit && !picked.includes(r)) picked.push(r);
  return picked.toSorted((a, b) => sorted.indexOf(a) - sorted.indexOf(b)).map((r) => r.fit);
}

// ---------- labels and Penny cards ----------

/** A stock line's year: the stated one, else the one year its title gives ("… 0Z1915911M 2020 37805019", "(2021)"). */
export function yearFrom(stated: number | null, title: string): number | null {
  if (stated != null) return stated;
  const bracketed = title.match(/\((20[0-3]\d)\)/);
  if (bracketed) return Number(bracketed[1]);
  const years = [...new Set([...title.matchAll(/(?<![\d.-])(20[0-3]\d)(?![\d-])/g)].map((m) => Number(m[1])))];
  return years.length === 1 ? years[0] : null;
}

/** A model as a buyer reads it: no chassis codes ("E11", "5AC"), shouting words in title case ("BORN" → "Born"). */
export function tidyModel(model: string): string {
  const words = model.split(/,/)[0].split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const [i, w] of words.entries()) {
    if (i > 0 && /^(?=.*[a-z])(?=.*\d)[a-z\d]{2,4}$/i.test(w) && !/^(mk|gen)\d$/i.test(w)) break;
    kept.push(/^[A-Z]{4,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w);
    if (kept.length >= 4) break;
  }
  return kept.join(" ");
}

/** "Volkswagen ID.3 62 kWh, 2020": what the buyer would read, with nothing about the supplier. */
export function fitLabel(make: string | null, model: string | null, kwh: number | null, year: number | null, title: string): string {
  const name = [make, model ? tidyModel(model) : null].filter(Boolean).join(" ") || title.replace(/[[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const size = kwh != null ? ` ${Math.round(kwh * 10) / 10} kWh` : "";
  return `${name}${size}${year ? `, ${year}` : ""}`;
}

const cardWords = (text: string) => new Set(text.split(/[\s/,()+]+/).map(fold).filter(Boolean));
const cardKwhs = (card: PennyCard) => [card.kwh_usable, ...[...card.battery.matchAll(/(\d+(?:\.\d+)?)\s*(?:kwh|usable)/gi)].map((m) => Number(m[1]))];

/**
 * Penny's latest card for a fit's battery: one that names its model ("ID.3", "Model S") and a capacity within 5% of
 * the fit's (or its pack family's). Null when none does, which is normal: Penny has cards for only some batteries.
 */
export function pennyCardFor(fit: Pick<StockFit, "label" | "kwh">, cards: readonly PennyCard[]): PennyCard | null {
  if (fit.kwh == null) return null;
  const name = fit.label.replace(/\s+\d+(?:\.\d+)?\s*kWh.*$/i, "").replace(/,.*$/, "");
  const [make, ...model] = name.split(/\s+/);
  if (!model.length) return null;
  const words = model.map(fold).filter(Boolean);
  const wanted = words[0] === "model" ? words.slice(0, 2) : words.slice(0, 1);
  const kwhs = packKwhs(make, model.join(" "), fit.kwh);
  const hits = cards.filter((card) => {
    const text = cardWords(card.battery);
    return wanted.every((w) => text.has(w)) && cardKwhs(card).some((k) => kwhs.some((v) => Math.abs(v - k) / k <= KWH_TOLERANCE));
  });
  const priced = (c: PennyCard) => Number(c.quick_gbp_kwh != null && c.patient_gbp_kwh != null);
  return hits.toSorted((a, b) => priced(b) - priced(a) || b.created_at.localeCompare(a.created_at))[0] ?? null;
}
