/**
 * The front door: how big a new lead is, which route it takes, and what "Qualified" means. Decided by Alex on
 * 12 Nov 2026; everything that sizes, routes or qualifies a lead reads it from here.
 *
 * - BULK: 300 kWh or more, or a deal value over USD 20,000. Either is enough. When the facts do not settle it, the size
 *   is "unknown" (ask), never a guess.
 * - ROUTE: every lead gets exactly one: a bulk deal; the marketplace (small: single packs, and buyers also get a demand
 *   alert); Jules (medium: the marketplace's guided listing or commercial buyer flow); or recycling.
 * - QUALIFIED: the route's checklist is answered (or marked "they cannot provide it") and each item checked by a person,
 *   and a person ticked Qualified. Price and timeline are asked for every time but are not needed for the tick: the
 *   deal then shows "No price" or "No date" until they are filled. A deal opens on what and how many alone.
 *   The same rule runs in SQL as bulk_listing_qualified() (migration 112); relay-front-door.test.ts keeps the two in step.
 */

export const BULK_MIN_KWH = 300;
/** Over this, in US dollars, is bulk. Exactly USD 20,000 is not. */
export const BULK_OVER_USD = 20_000;
/** The plain-English rule, for titles and prompts. */
export const BULK_RULE_TEXT = "300 kWh or more, or a deal value over USD 20,000";

export type Currency = "USD" | "EUR" | "GBP";
/**
 * US dollars per unit of each currency, fixed on 12 Nov 2026. They are the CRM's standing EUR rates (GBP 1.15 and
 * USD 0.86 to EUR, CRM-TABLES.md) put in dollars: EUR 1 = USD 1/0.86 = 1.16, GBP 1 = USD 1.15/0.86 = 1.34. No exchange
 * rate service is called; change them here.
 */
export const USD_PER: Record<Currency, number> = { USD: 1, EUR: 1.16, GBP: 1.34 };
export const RATES_SET_ON = "2026-11-12";

export const toUsd = (amount: number, currency: Currency) => Math.round(amount * USD_PER[currency] * 100) / 100;

/** Under the bulk line: this many units or fewer is "small" (single packs, the marketplace); more is "medium" (Jules). */
export const SMALL_MAX_UNITS = 1;

/** The one setting for item 3: "off" stops Relay queueing "Update deal from this reply" by itself. On unless set. */
export const AUTO_DEAL_UPDATE_SETTING = "RELAY_AUTO_DEAL_UPDATE";
export const autoDealUpdateOn = (env: Record<string, string | undefined> = process.env) =>
  !/^(off|false|0|no)$/i.test((env[AUTO_DEAL_UPDATE_SETTING] ?? "").trim());
/** An automatic update only looks at replies this recent, so switching it on does not queue a backlog. */
export const AUTO_DEAL_UPDATE_DAYS = 3;

// ---------- sizing ----------

export type LeadSize = "bulk" | "medium" | "small" | "unknown";
/** A figure as the email gives it: one number, a range, or a floor (max Infinity). */
export type Range = { min: number; max: number };
export type Sizing = { size: LeadSize; kwh: Range | null; usd: Range | null; units: Range | null; why: string };
export type SizingFact = { key: string; value: string };

const WORD_NUMBERS: Record<string, number> = { one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };
const UNIT_WORD = /\b(?:packs?|modules?|cells?|units?|batter(?:y|ies)|containers?|systems?|cabinets?|racks?|pcs|pieces?|vehicles?|cars?|vans?|buses?)\b/i;
const NUM = "(\\d+(?:[.,]\\d+)?)(?:\\s*(k|m|thousand|million)\\b)?";

/** "1,000" and "1 000" are one thousand; "1.5k" is 1,500. Dot thousands ("1.000") only for counts. */
function number(raw: string, scale: string | undefined, count: boolean): number {
  let text = raw;
  if (count && /^\d{1,3}\.\d{3}$/.test(text)) text = text.replace(".", "");
  const n = Number(text.replace(",", "."));
  const s = (scale ?? "").toLowerCase();
  return n * (s === "k" || s === "thousand" ? 1_000 : s === "m" || s === "million" ? 1_000_000 : 1);
}
const ungroup = (text: string) => text.replace(/(\d)[,  ](?=\d{3}\b)/g, "$1");

/** One figure, a range ("10-20", "10 to 20"), or a floor ("10+", "over 10", "at least 10"). Null when there is none. */
function rangeIn(text: string, after: string, count: boolean): Range | null {
  const t = ungroup(text);
  const range = new RegExp(`${NUM}\\s*(?:-|–|to)\\s*${NUM}\\s*${after}`, "i").exec(t);
  if (range) {
    const a = number(range[1], range[2] ?? range[4], count), b = number(range[3], range[4], count);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const one = new RegExp(`(\\b(?:over|above|more than|at least|min(?:imum)?|from|up to|max(?:imum)?|under|below|less than)\\s+)?${NUM}\\s*(\\+)?\\s*${after}`, "i").exec(t);
  if (!one) return null;
  const n = number(one[2], one[3], count);
  const lead = (one[1] ?? "").trim().toLowerCase();
  if (one[4] || /^(over|above|more than|at least|min|minimum|from)$/.test(lead)) return { min: n, max: Infinity };
  if (/^(up to|max|maximum|under|below|less than)$/.test(lead)) return { min: 0, max: n };
  return { min: n, max: n };
}

const scaleRange = (r: Range, k: number): Range => ({ min: r.min * k, max: r.max * k });
const times = (a: Range, b: Range): Range => ({ min: a.min * b.min, max: a.max * b.max });

/** The whole lot's energy in kWh, when "how many" states it ("500 kWh", "2 MWh", "1-2 MWh"). */
export function totalKwh(howMany: string): Range | null {
  const mwh = rangeIn(howMany, "mwh\\b", false);
  if (mwh) return scaleRange(mwh, 1_000);
  const gwh = rangeIn(howMany, "gwh\\b", false);
  if (gwh) return scaleRange(gwh, 1_000_000);
  return rangeIn(howMany, "kwh\\b", false);
}

/** How many units, when "how many" is a count ("1,000 modules", "20 packs", "one pack", "10+"). */
export function unitCount(howMany: string): Range | null {
  if (totalKwh(howMany) || /\b(?:tonnes?|tons?|kg|kilos?)\b/i.test(howMany)) return null;
  const word = new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join("|")})\\b\\s+(?:\\w+\\s+){0,3}?${UNIT_WORD.source}`, "i").exec(howMany);
  const digits = rangeIn(howMany, "", true);
  if (digits) return digits;
  return word ? { min: WORD_NUMBERS[word[1].toLowerCase()], max: WORD_NUMBERS[word[1].toLowerCase()] } : null;
}

/** One unit's capacity, from "what" ("Nissan Leaf 40kWh", "62 kWh packs"). Null when not stated. */
export function unitKwh(what: string): Range | null {
  return rangeIn(what, "kwh\\b", false);
}

export type Price = { amount: Range; currency: Currency; per: "kwh" | "unit" | "total" };

const CURRENCY: [RegExp, Currency][] = [[/€|\beur(?:os?)?\b/i, "EUR"], [/£|\bgbp\b|\bpounds?\b|\bquid\b/i, "GBP"], [/\$|\busd\b|\bdollars?\b/i, "USD"]];

/** A price with its currency and what it is per. Null when any of the three is missing: no unit, no sum. */
export function parsePrice(text: string): Price | null {
  const currency = CURRENCY.find(([re]) => re.test(text))?.[1];
  if (!currency) return null;
  const bare = text.replace(/[€£$]/g, " ").replace(/\b(?:eur(?:os?)?|gbp|usd|pounds?|dollars?|quid)\b/gi, " ");
  const amount = rangeIn(bare, "", false);
  if (!amount || amount.max === Infinity) return null;
  const mwh = /(?:\/|\bper|\ban?)\s*mwh\b/i.test(text);
  const per = /(?:\/|\bper|\ban?|\beach)\s*(?:usable\s+)?(?:kwh|mwh)\b/i.test(text) ? "kwh"
    : new RegExp(`(?:/|\\bper|\\ban?|\\beach)\\s*(?:\\w+\\s+)?${UNIT_WORD.source}|\\beach\\b|\\bper\\s+(?:unit|piece|pc)\\b|/\\s*(?:pc|unit)\\b`, "i").test(text) ? "unit"
    : /\b(?:total|in total|overall|for the (?:lot|lot as a whole|whole lot)|for (?:all|everything)|the lot|whole lot|lump sum)\b/i.test(text) ? "total" : null;
  if (!per) return null;
  return { amount: mwh ? scaleRange(amount, 1 / 1_000) : amount, currency, per };
}

const fmt = (n: number) => (n === Infinity ? "more" : Math.round(n).toLocaleString("en-GB"));
const fmtRange = (r: Range, unit: string) => (r.min === r.max ? `${fmt(r.min)} ${unit}` : r.max === Infinity ? `${fmt(r.min)}+ ${unit}` : `${fmt(r.min)}-${fmt(r.max)} ${unit}`);

/**
 * How big the lead is, from the facts read off their email (FACT_KEYS in relay-lead-core: what, how_many, price).
 * Bulk when the lowest reading is 300 kWh or more, or over USD 20,000. Under the line only when both are known and
 * even the highest reading is under. Anything else is "unknown": the reply asks.
 */
export function sizeLead(facts: SizingFact[]): Sizing {
  const fact = (key: string) => facts.find((f) => f.key === key)?.value ?? "";
  const howMany = fact("how_many"), what = fact("what");
  const units = unitCount(howMany);
  const perUnit = unitKwh(what);
  const kwh = totalKwh(howMany) ?? (units && perUnit ? times(units, perUnit) : null);
  const price = parsePrice(fact("price"));
  const base = price?.per === "kwh" ? kwh : price?.per === "unit" ? units : price?.per === "total" ? { min: 1, max: 1 } : null;
  const usd = price && base ? scaleRange(times(price.amount, base), USD_PER[price.currency]) : null;

  const shown = [kwh && fmtRange(kwh, "kWh"), usd && `USD ${fmtRange(usd, "").trim()}`].filter(Boolean).join(", ");
  if (kwh && kwh.min >= BULK_MIN_KWH) return { size: "bulk", kwh, usd, units, why: `Bulk: ${fmtRange(kwh, "kWh")}, ${BULK_MIN_KWH} kWh or more` };
  if (usd && usd.min > BULK_OVER_USD) return { size: "bulk", kwh, usd, units, why: `Bulk: about USD ${fmtRange(usd, "").trim()}, over USD ${fmt(BULK_OVER_USD)}` };
  if (kwh && usd && kwh.max < BULK_MIN_KWH && usd.max <= BULK_OVER_USD) {
    const small = !!units && units.max <= SMALL_MAX_UNITS;
    return { size: small ? "small" : "medium", kwh, usd, units, why: `Under the bulk line: ${shown}` };
  }
  const missing = [!kwh && (what || howMany ? "the kWh" : "how many"), !usd && "a price with its unit"].filter(Boolean).join(" and ");
  return { size: "unknown", kwh, usd, units, why: `Size unknown: ask${missing ? ` for ${missing}` : ""}${shown ? ` (have ${shown})` : ""}` };
}

// ---------- routing ----------

export const ROUTES = ["bulk", "marketplace", "jules", "recycling"] as const;
export type RouteKey = (typeof ROUTES)[number];
export const ROUTE_LABEL: Record<RouteKey, string> = { bulk: "Bulk deal", marketplace: "Marketplace", jules: "Jules", recycling: "Recycling" };
/** What Relay suggests (`suggested`) or Alex picked on the card (`chosen`), with a one-line reason. */
export type LeadRoute = { route: RouteKey; size: LeadSize; reason: string; chosen?: boolean };

/** The one route for a lead. Recycling wins; then size: bulk or unknown go to a bulk deal, small to the marketplace,
 * medium to Jules. */
export function routeLead(input: { facts: SizingFact[]; recycling: string | null }): LeadRoute {
  const sizing = sizeLead(input.facts);
  if (input.recycling) return { route: "recycling", size: sizing.size, reason: `Recycling: "${input.recycling.slice(0, 80)}". ${sizing.why}` };
  if (sizing.size === "small") return { route: "marketplace", size: "small", reason: `Marketplace: single packs. ${sizing.why}` };
  if (sizing.size === "medium") return { route: "jules", size: "medium", reason: `Jules: more than single packs. ${sizing.why}` };
  return { route: "bulk", size: sizing.size, reason: sizing.why };
}

/** The route as Alex left it: his pick from the card wins over Relay's suggestion. */
export function chooseRoute(suggested: LeadRoute, picked: unknown): LeadRoute {
  if (typeof picked !== "string" || !(ROUTES as readonly string[]).includes(picked) || picked === suggested.route) return suggested;
  return { route: picked as RouteKey, size: suggested.size, chosen: true, reason: `${ROUTE_LABEL[picked as RouteKey]}, chosen on the card (Relay suggested ${ROUTE_LABEL[suggested.route]}: ${suggested.reason})`.slice(0, 300) };
}

/** Sending the first reply opens a deal for a bulk or recycling lead, unless it is under the bulk line and Alex left
 * Relay's suggestion as it was. A deal opens on what and how many alone. */
export function opensDeal(route: LeadRoute, have: { what: boolean; how_many: boolean }): boolean {
  if (route.route !== "bulk" && route.route !== "recycling") return false;
  if (!route.chosen && (route.size === "small" || route.size === "medium")) return false;
  return have.what && have.how_many;
}

/**
 * The fixed wording that points a small or medium lead to the right place. Not yet approved by Alex: change it here.
 * No figures (checkLeadReply refuses any digit outside his own answers) and no link beyond rebattery.io itself.
 */
export const POINTERS: Record<"seller" | "buyer", Partial<Record<RouteKey, string>>> = {
  seller: {
    marketplace: "For a single pack, the quickest way to sell it is to list it on our marketplace at rebattery.io, where buyers can find it and make you an offer.",
    jules: "For a lot this size, the best route is our guided listing at rebattery.io: Jules takes you through it step by step and puts the lot in front of our buyers.",
  },
  buyer: {
    marketplace: "For single packs, the quickest route is our marketplace at rebattery.io, where you can buy directly. If nothing there fits yet, set up a demand alert with what you need and your price, and you will hear as soon as matching stock is listed.",
    jules: "For an order this size, the best route is Jules on rebattery.io: it takes your requirements step by step, and we come back to you with matching stock.",
  },
};

// ---------- qualification ----------

export type ChecklistKind = "supply" | "demand";
export type ChecklistRoute = "resale" | "recycling";
export const checklistRoute = (route: string | null | undefined, recyclingFlag?: unknown): ChecklistRoute =>
  route === "recycling" || recyclingFlag === true || recyclingFlag === "true" ? "recycling" : "resale";

/** The items the Qualified tick needs answered (or "they cannot provide it") and checked. Price and when are asked every
 * time but are not needed for the tick. Mirrored in SQL as bulk_listing_check_keys() (migration 112). */
export const QUALIFY_KEYS: Record<ChecklistRoute, Record<ChecklistKind, string[]>> = {
  resale: { supply: ["what", "how_many", "where", "health"], demand: ["what", "how_many", "where"] },
  recycling: { supply: ["what", "how_many", "where", "condition"], demand: ["what", "how_many", "where"] },
};
/** On every checklist, asked in the first and the second ask. */
export const ALWAYS_ASKED = ["price", "when"] as const;
/** Tier 1 ("must, to start"): two asks without one of these, and Relay proposes parking the deal. */
export const TIER_ONE = ["what", "how_many"];

/** Where each checklist item's state is kept: the crm_bulk_listing_fields row with this field_key. Mirrored in SQL as
 * bulk_listing_check_field() (migration 112). */
export const CHECK_FIELD: Record<ChecklistKind, Record<string, string>> = {
  supply: { what: "model", how_many: "quantity", where: "location", health: "soh", condition: "condition", price: "seller_price", when: "clear_by" },
  demand: { what: "product_family", how_many: "quantity", where: "location", condition: "condition", price: "max_price", when: "needed_by", health: "min_soh" },
};

export type CheckState = { answered: boolean; cannot: boolean; checked: boolean; asked: number };
export type QualifyView = {
  /** Every item the tick needs is answered or cannot be provided, and checked. */
  ready: boolean;
  /** A person ticked Qualified. */
  ticked: boolean;
  qualified: boolean;
  /** What still stops the tick, as labels. */
  missing: string[];
  noPrice: boolean;
  noDate: boolean;
  /** Two asks with a tier 1 item still unanswered: a suggestion on the card, never an automatic change. */
  park: string | null;
};

/** The Qualified rule on one deal's checklist state (the TS twin of bulk_listing_qualified). */
export function qualifyView(kind: ChecklistKind, route: ChecklistRoute, items: Record<string, CheckState | undefined>, ticked: boolean, labels: Record<string, string> = {}): QualifyView {
  const label = (key: string) => (labels[key] ?? key.replace("_", " ")).toLowerCase();
  const missing = QUALIFY_KEYS[route][kind].flatMap((key) => {
    const s = items[key];
    if (!s || (!s.answered && !s.cannot)) return [`${label(key)} (not answered)`];
    return s.checked ? [] : [`${label(key)} (not checked)`];
  });
  const stuck = TIER_ONE.filter((key) => { const s = items[key]; return !!s && s.asked >= 2 && !s.answered && !s.cannot; });
  const ready = !missing.length;
  return {
    ready, ticked, qualified: ready && ticked, missing,
    noPrice: !items.price?.answered, noDate: !items.when?.answered,
    park: stuck.length ? `Two asks and still no ${stuck.map(label).join(" or ")}: propose parking it, with that as the reason.` : null,
  };
}

/** A test or QC document is flagged when it is more than 12 calendar months older than `now`. */
export function docTooOld(sourceDate: string | null | undefined, now = new Date()): boolean {
  const at = sourceDate ? new Date(sourceDate) : null;
  if (!at || Number.isNaN(at.getTime())) return false;
  const limit = new Date(now);
  limit.setUTCMonth(limit.getUTCMonth() - 12);
  return at.getTime() < limit.getTime();
}
