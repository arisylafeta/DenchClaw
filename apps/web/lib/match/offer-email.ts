// The offer emails, built from facts only: deterministic text, no model, no stored copy.
//
// A supply offer goes to a buyer. A buyer may see only the listing fields whose visibility on
// `crm_bulk_listing_fields` is `teaser`; `after_nda`, `after_loi` and `never` rows are left out, which is why the
// price is always "price on request" here: ReBattery buys at the seller's price and sells on at its own. A request
// stock ask goes to a supplier: what we need and one question about their stock, never the buyer's name, company,
// price ceiling or anything finer than the country. A chase asks the same question again. Nothing here invents a
// fact, names the other party or writes an address.
import { keyLine, type FieldFact, type ProductKey } from "./product-key";

export type OfferEmailKind = "supply_offer" | "request_stock" | "chase";

/** The buyer's own words, read from `buyer_profile`: the derived wants text and the dossier products. */
export type BuyerFacts = {
  wants?: string | null;
  products?: unknown;
};

export type OfferEmailInput = {
  kind: OfferEmailKind;
  /** The lot's product key (supply) or the requested product (request). */
  key: ProductKey;
  /** The listing's field rows, so the test status is quoted exactly as recorded. */
  fields?: FieldFact[];
  /** The recipient's first name, when the CRM has one. */
  recipientFirstName?: string | null;
  /** Where the goods are, as written on the listing. Only the town and country survive. */
  location?: string | null;
  buyer?: BuyerFacts | null;
  /** Which side we are writing for, so a chase asks the right question. */
  side?: "supply" | "demand";
  /** The subject of the last email on this offer, for a chase. */
  previousSubject?: string | null;
  /** Names, contacts and addresses that must never appear in the copy. */
  privateValues?: (string | null | undefined)[];
};

export type OfferEmail = { kind: OfferEmailKind; subject: string; body: string };

/** Thrown instead of returning copy that would identify the other party or an exact address. */
export class OfferEmailRefused extends Error {
  constructor(readonly leaked: string) {
    super(`The email would include ${leaked}, so it was not written.`);
    this.name = "OfferEmailRefused";
  }
}

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

const SIGN_OFF = "Best,\nAlex";

/** A first name for the greeting, or null when what we hold is not one (an email, a number, a sentence). */
export function firstName(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text || text.includes("@") || /\d/.test(text)) {
    return null;
  }
  const first = text.split(/[\s,]+/)[0] ?? "";
  if (!/^[A-Za-z][A-Za-z'’-]{1,19}$/.test(first)) {
    return null;
  }
  return first[0].toUpperCase() + first.slice(1);
}

const round = (value: number) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10));

/** "40 x 50 kWh NMC packs": units, size, chemistry and format, in that order, from the key only. */
export function productPhrase(key: ProductKey): string | null {
  const line = key.lines[0];
  if (!line) {
    return null;
  }
  if (key.mixed) {
    return `a mixed lot of ${key.lines.length} battery products`;
  }
  const bits: string[] = [];
  const units = key.units ?? line.units;
  if (units != null) {
    bits.push(`${units} x`);
  }
  if (line.kwhMin != null && line.kwhMax != null) {
    bits.push(`${round(line.kwhMin)}-${round(line.kwhMax)} kWh`);
  } else if (line.kwh != null) {
    bits.push(`${round(line.kwh)} kWh`);
  }
  const chemistry = line.chemistry ?? key.chemistry;
  if (chemistry) {
    bits.push(chemistry);
  }
  const format = (line.format ?? key.format ?? "").toLowerCase();
  if (format) {
    bits.push(format);
  }
  return bits.length ? bits.join(" ") : null;
}

/** The listing's product line, for the body. Falls back to the key's own summary. */
function productLine(key: ProductKey): string {
  return productPhrase(key) ?? keyLine(key).toLowerCase();
}

const STREET = /\b(street|st\.|road|rd\.|avenue|ave\.?|lane|close|drive|way|unit|plot|suite|floor|building|industrial|estate|park|postcode|zip|po box|no\.|nr\.)\b/i;

const isPlaceWord = (part: string) => part.length >= 3 && part.length <= 40 && !/\d/.test(part) && !STREET.test(part);

/**
 * Town and country only, from however the listing wrote its location. A street, a unit number or a postcode
 * never survives; when nothing safe is left the line is dropped rather than guessed.
 */
export function publicPlace(location: string | null | undefined): string | null {
  const parts = clean(location).split(",").map((part) => part.trim()).filter(Boolean).filter(isPlaceWord);
  if (!parts.length) {
    return null;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
}

/** The country alone: a stock ask to a seller never says more about where the buyer is than that. */
export function publicCountry(location: string | null | undefined): string | null {
  const parts = clean(location).split(",").map((part) => part.trim()).filter(Boolean);
  const country = parts[parts.length - 1];
  return country && isPlaceWord(country) ? country : null;
}

/** The place a buyer may see: town and country, and only when the listing clears its location for a buyer. */
export function buyerPlace(fields: FieldFact[], location: string | null | undefined): string | null {
  const row = buyerField(fields, "location");
  if (!row) {
    return null;
  }
  return publicPlace(clean(row.value) || location);
}

/** The unsafe pieces of a location: a street, a unit number or a postcode. Town and country are not here. */
export function addressParts(location: string | null | undefined): string[] {
  return clean(location).split(",").map((part) => part.trim()).filter((part) => part.length >= 4 && !isPlaceWord(part));
}

const fieldOf = (fields: FieldFact[], key: string) => fields.find((field) => field.field_key === key) ?? null;

/** The only visibility a buyer is allowed to see. Every other value keeps the value out of a buyer email. */
export const BUYER_VISIBLE = "teaser";

/** The row a buyer may see, or null: no row, a missing visibility and every non-teaser value all mean "leave it out". */
export function buyerField(fields: FieldFact[], key: string): FieldFact | null {
  const row = fieldOf(fields, key);
  return row?.visibility === BUYER_VISIBLE ? row : null;
}

/**
 * The test status exactly as recorded, when the buyer may see it. A disputed row shows no value, because picking
 * one would be a guess; nothing recorded says so plainly and never becomes "tested". A row the buyer may not see
 * produces no line at all rather than a false "no test data".
 */
export function testStatusLine(fields: FieldFact[]): string | null {
  const row = fieldOf(fields, "test_data");
  if (!row) {
    return "No test data recorded.";
  }
  if (row.visibility !== BUYER_VISIBLE) {
    return null;
  }
  const value = clean(row.value);
  if (row.status === "conflict") {
    return "The test data on this lot is disputed.";
  }
  if (!value) {
    return "No test data recorded.";
  }
  return `Test data: ${value.replace(/[.\s]+$/, "")}.`;
}

/** On a request, the state of health the buyer has asked for. A requirement, never a fact about the seller's stock. */
export function requirementLine(fields: FieldFact[]): string | null {
  const row = fieldOf(fields, "soh");
  const value = clean(row?.value);
  if (!value || row?.status === "conflict") {
    return null;
  }
  return `The buyer is asking for ${value.replace(/[.\s]+$/, "")} state of health.`;
}

/** State of health, only when the listing records it as a single figure the buyer may see. */
export function sohLine(fields: FieldFact[]): string | null {
  const row = buyerField(fields, "soh");
  const value = clean(row?.value);
  if (!row || !value || row.status === "conflict") {
    return null;
  }
  return `State of health: ${value.replace(/[.\s]+$/, "")}.`;
}

/**
 * The buyer-facing price line. Never the seller's price: ReBattery brokers with a margin, and
 * `seller_price` is `never` visible on every row. The price is quoted on request, full stop.
 */
export function priceLine(): string {
  return "Price on request.";
}

const ACTIVE_STATUS = new Set(["bought", "asked", "said_interested", "interested"]);

const productText = (product: Record<string, unknown>, field: string) => {
  const value = product[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

/** How well one dossier product matches the lot: an identifier or a close size, then chemistry and format. */
function productScore(product: Record<string, unknown>, key: ProductKey): { score: number; identity: boolean } {
  const line = key.lines[0];
  if (!line) {
    return { score: 0, identity: false };
  }
  let score = 0;
  let identity = false;
  const part = productText(product, "part_number");
  if (part && key.partNumbers.some((number) => number.toLowerCase() === part.toLowerCase())) {
    score += 4;
    identity = true;
  }
  for (const field of ["make", "platform", "model"] as const) {
    const value = productText(product, field);
    if (!value) {
      continue;
    }
    const hay = [line.make, line.model, line.platform].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(value.toLowerCase())) {
      score += field === "make" ? 2 : 1;
      identity = true;
    }
  }
  const chemistry = productText(product, "chemistry");
  if (chemistry && (line.chemistry ?? key.chemistry)?.toLowerCase() === chemistry.toLowerCase()) {
    score += 2;
  }
  const format = productText(product, "format");
  if (format && (line.format ?? key.format)?.toLowerCase() === format.toLowerCase()) {
    score += 1;
  }
  const kwh = Array.isArray(product.kwh) ? product.kwh : [product.kwh];
  const sizes = kwh.filter((value): value is number => typeof value === "number" && value > 0);
  if (sizes.length && line.kwh != null) {
    const closest = sizes.reduce((best, value) => (Math.abs(value - line.kwh!) < Math.abs(best - line.kwh!) ? value : best), sizes[0]);
    if (Math.abs(closest - line.kwh) / line.kwh <= 0.2) {
      score += 1;
      identity = true;
    }
  }
  return { score, identity };
}

/** A product's want, in plain words and without its recorded status: "50 kWh NMC packs" or "Samsung 50E". */
function productWant(product: Record<string, unknown>): string | null {
  const kwh = (Array.isArray(product.kwh) ? product.kwh : [product.kwh]).filter((value): value is number => typeof value === "number" && value > 0);
  const bits: string[] = [];
  const label = productText(product, "platform") ?? productText(product, "make") ?? productText(product, "model") ?? productText(product, "part_number");
  if (label) {
    bits.push(label);
  }
  if (kwh.length === 1) {
    bits.push(`${round(kwh[0])} kWh`);
  } else if (kwh.length > 1) {
    bits.push(`${round(Math.min(...kwh))}-${round(Math.max(...kwh))} kWh`);
  }
  const chemistry = productText(product, "chemistry");
  if (chemistry) {
    bits.push(chemistry);
  }
  const format = productText(product, "format");
  if (format) {
    bits.push(format.toLowerCase());
  }
  return bits.length ? bits.join(" ") : null;
}

/**
 * The buyer's want, in their own words where possible: a dossier product that matches this lot, else the
 * derived wants line. Not a status report and never a claim about what they will buy.
 */
export function buyerWant(buyer: BuyerFacts | null | undefined, key: ProductKey): string | null {
  const products = (Array.isArray(buyer?.products) ? buyer.products : [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => !item.status || ACTIVE_STATUS.has(String(item.status)));
  let best: { score: number; text: string } | null = null;
  for (const product of products) {
    const match = productScore(product, key);
    const text = productWant(product);
    if (!text || !match.identity || match.score < 2) {
      continue;
    }
    if (!best || match.score > best.score) {
      best = { score: match.score, text };
    }
  }
  if (best) {
    return best.text;
  }
  const wants = clean(buyer?.wants).split("\n").map((line) => line.trim()).find(Boolean);
  if (!wants) {
    return null;
  }
  return wants.replace(/\s*\((?:bought|asked|said interested|interested)[^)]*\)\s*$/i, "").trim() || null;
}

const GENERIC = new Set([
  "battery", "batteries", "energy", "recycling", "recycle", "metals", "metal", "group", "limited", "ltd", "gmbh",
  "inc", "llc", "bv", "nv", "plc", "company", "solutions", "technologies", "technology", "trading", "materials",
  "services", "automotive", "industrial", "holding", "holdings", "international", "partners", "supply", "supplies",
]);

// Ordinary words the copy itself uses. A three-letter company token (ABZ, AEC) must be refused, but the same match on
// one of these says nothing about who the other party is, so they never count as a leak.
const COMMON = new Set([
  "the", "and", "for", "are", "was", "has", "had", "not", "but", "any", "all", "our", "you", "your", "its", "who",
  "what", "when", "how", "why", "new", "used", "lot", "per", "one", "two", "six", "ten", "off", "out", "can", "may",
  "will", "get", "see", "say", "ask", "now", "day", "way", "more", "than", "with", "from", "this", "that", "there",
]);

const normalise = (value: string) => ` ${value.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim()} `;

/**
 * The first private value that appears in the copy, as written, or null. A value of four letters or more is matched
 * as written. With `shortWords`, each of its words is also matched whole and case-insensitively, so a three-letter
 * company name still refuses the email; words shorter than three letters, trade words and ordinary words are skipped
 * because they cannot be told apart from normal copy. Prices pass `shortWords: false`: their units ("kWh") belong in
 * the copy and only the figures and the written amount are private.
 */
export function firstLeak(
  text: string, values: (string | null | undefined)[], { shortWords = true }: { shortWords?: boolean } = {},
): string | null {
  const haystack = normalise(text);
  const shortest = shortWords ? 3 : 4;
  for (const raw of values) {
    const value = clean(raw);
    if (value.length >= 4 && haystack.includes(normalise(value))) {
      return value;
    }
    for (const word of value.split(/[^A-Za-z0-9&]+/)) {
      const lower = word.toLowerCase();
      if (word.length < shortest || GENERIC.has(lower) || COMMON.has(lower)) {
        continue;
      }
      if (haystack.includes(normalise(word))) {
        return word;
      }
    }
  }
  return null;
}

function greeting(name: string | null | undefined): string {
  const first = firstName(name);
  return first ? `Hi ${first},` : "Hi there,";
}

/**
 * Commercial values that must never reach either side: our cost on a supply offer, and the buyer's ceiling on a
 * stock ask. The template never writes them; this is the check that proves it.
 */
const PRICE_KEYS = new Set(["seller_price", "max_price", "min_price", "target_price", "buyer_price"]);

function priceValues(fields: FieldFact[]): string[] {
  return fields.filter((field) => PRICE_KEYS.has(field.field_key)).map((field) => field.value ?? "");
}

/**
 * One email, ready to review. Deterministic for the same facts, and it refuses rather than leaking a name, an
 * address or a price: everything private is checked against the finished copy before it is returned.
 */
export function buildOfferEmail(input: OfferEmailInput): OfferEmail {
  const fields = input.fields ?? [];
  const product = productLine(input.key);
  // Buyer-facing: town and country, only from a teaser row. Request side: the country alone.
  const place = input.kind === "supply_offer"
    ? buyerPlace(fields, input.location)
    : input.kind === "request_stock" ? publicCountry(input.location) : null;
  const want = buyerWant(input.buyer, input.key);
  const where = place ? ` in ${place}` : "";
  let subject: string;
  let body: string;

  if (input.kind === "supply_offer") {
    const short = productPhrase(input.key);
    subject = short ? short[0].toUpperCase() + short.slice(1) : "Used EV batteries available";
    const opening = want
      ? `You were looking for ${want}. We have ${product} available${where}.`
      : `We have ${product} available${where}.`;
    const facts = [testStatusLine(fields), sohLine(fields), priceLine()].filter(Boolean).join(" ");
    const ask = want ? "Is it still of interest?" : "Would you like the full spec sheet?";
    body = `${greeting(input.recipientFirstName)}\n\n${opening}\n\n${facts}\n\n${ask}\n\n${SIGN_OFF}`;
  } else if (input.kind === "request_stock") {
    const short = productPhrase(input.key);
    subject = short ? `Stock enquiry: ${short}` : "Stock enquiry";
    const facts = [requirementLine(fields)].filter(Boolean).join(" ");
    body = `${greeting(input.recipientFirstName)}\n\nWe're looking for ${product}${where}.${facts ? ` ${facts}` : ""}\n\nDo you have anything that fits?\n\n${SIGN_OFF}`;
  } else {
    const short = productPhrase(input.key);
    const previous = clean(input.previousSubject);
    subject = previous
      ? (previous.toLowerCase().startsWith("re:") ? previous : `Re: ${previous}`)
      : short ? `Following up: ${short}` : "Following up";
    const ask = input.side === "demand" ? "Do you have anything that fits?" : "Is it still of interest?";
    body = `${greeting(input.recipientFirstName)}\n\nFollowing up on the note I sent about ${product}.\n\n${ask}\n\n${SIGN_OFF}`;
  }

  const leaked = firstLeak(`${subject}\n${body}`, input.privateValues ?? [])
    ?? firstLeak(`${subject}\n${body}`, priceValues(fields), { shortWords: false });
  if (leaked) {
    throw new OfferEmailRefused(leaked);
  }
  return { kind: input.kind, subject, body };
}
