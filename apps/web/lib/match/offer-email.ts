// The offer emails, built from facts only: deterministic text, no model, no stored copy.
//
// A supply offer goes to a buyer: what we have, where it is (town and country only), the test data exactly
// as the listing records it, and the price only when it is firm. A request stock ask goes to a supplier: what
// we need and one question about their stock, never a price (we ask for theirs). A chase is short and asks
// the same question again. Nothing here invents a fact, names the other party or writes an address.
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
  /** The subject of the last email on this offer, for a chase. */
  previousSubject?: string | null;
  /** Names, contacts and addresses that must never appear in the copy. */
  privateValues?: (string | null | undefined)[];
};

export type OfferEmail = { kind: OfferEmailKind; subject: string; body: string };

/** Thrown instead of returning copy that would identify the other party or an exact address. */
export class OfferEmailRefused extends Error {
  constructor(readonly leaked: string) {
    super(`The email would name ${leaked}, so it was not written.`);
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

const fieldOf = (fields: FieldFact[], key: string) => fields.find((field) => field.field_key === key) ?? null;

/**
 * The test status exactly as recorded. A disputed row shows no value, because picking one would be a guess;
 * nothing recorded says so plainly and never becomes "tested".
 */
export function testStatusLine(fields: FieldFact[]): string {
  const row = fieldOf(fields, "test_data");
  const value = clean(row?.value);
  if (row?.status === "conflict") {
    return "The test data on this lot is disputed.";
  }
  if (!value) {
    return "No test data recorded.";
  }
  return `Test data: ${value.replace(/[.\s]+$/, "")}.`;
}

/** State of health, only when the listing records it as a single figure. */
export function sohLine(fields: FieldFact[]): string | null {
  const row = fieldOf(fields, "soh");
  const value = clean(row?.value);
  if (!value || row?.status === "conflict") {
    return null;
  }
  return `State of health: ${value.replace(/[.\s]+$/, "")}.`;
}

/** The seller price only when it is firm: a single confirmed amount with a unit. Otherwise "price on request". */
export function priceLine(key: ProductKey): string {
  const price = key.sellerPrice;
  if (!price) {
    return "Price on request.";
  }
  const per = price.per === "kwh" ? "kWh" : price.per === "mwh" ? "MWh" : "unit";
  return `The price is ${price.currency} ${round(price.amount)} per ${per}.`;
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

const normalise = (value: string) => ` ${value.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim()} `;

/** The first private value that appears in the copy, as written, or null. Words of four letters or more count. */
export function firstLeak(text: string, values: (string | null | undefined)[]): string | null {
  const haystack = normalise(text);
  for (const raw of values) {
    const value = clean(raw);
    if (value.length < 4) {
      continue;
    }
    const whole = normalise(value);
    if (whole.length > 4 && haystack.includes(whole)) {
      return value;
    }
    for (const word of value.split(/[^A-Za-z0-9&]+/).filter((part) => part.length >= 4 && !GENERIC.has(part.toLowerCase()))) {
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
 * One email, ready to review. Deterministic for the same facts, and it refuses rather than leaking a name or
 * an address: everything private is checked against the finished copy before it is returned.
 */
export function buildOfferEmail(input: OfferEmailInput): OfferEmail {
  const fields = input.fields ?? [];
  const product = productLine(input.key);
  const place = publicPlace(input.location);
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
    const facts = [testStatusLine(fields), sohLine(fields), priceLine(input.key)].filter(Boolean).join(" ");
    const ask = want ? "Is it still of interest?" : "Would you like the full spec sheet?";
    body = `${greeting(input.recipientFirstName)}\n\n${opening}\n\n${facts}\n\n${ask}\n\n${SIGN_OFF}`;
  } else if (input.kind === "request_stock") {
    const short = productPhrase(input.key);
    subject = short ? `Stock enquiry: ${short}` : "Stock enquiry";
    const facts = [sohLine(fields)].filter(Boolean).join(" ");
    body = `${greeting(input.recipientFirstName)}\n\nWe're looking for ${product}${where}.${facts ? ` ${facts}` : ""}\n\nDo you have anything that fits?\n\n${SIGN_OFF}`;
  } else {
    const short = productPhrase(input.key);
    const previous = clean(input.previousSubject);
    subject = previous
      ? (previous.toLowerCase().startsWith("re:") ? previous : `Re: ${previous}`)
      : short ? `Following up: ${short}` : "Following up";
    body = `${greeting(input.recipientFirstName)}\n\nFollowing up on the note I sent about ${product}.\n\nIs it still of interest?\n\n${SIGN_OFF}`;
  }

  const leaked = firstLeak(`${subject}\n${body}`, input.privateValues ?? []);
  if (leaked) {
    throw new OfferEmailRefused(leaked);
  }
  return { kind: input.kind, subject, body };
}
