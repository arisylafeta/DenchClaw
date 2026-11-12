// The offer emails, built from facts only: deterministic text, no model, no stored copy.
//
// A supply offer goes to a buyer. A buyer may see only the listing fields whose visibility on
// `crm_bulk_listing_fields` is `teaser`; `after_nda`, `after_loi` and `never` rows are left out, which is why the
// price is always "price on request" here: ReBattery buys at the seller's price and sells on at its own. A request
// stock ask goes to a supplier: what we need and one question about their stock, never the buyer's name, company,
// price ceiling or anything finer than the country. A chase asks the same question again. Nothing here invents a
// fact, names the other party or writes an address.
import { keyLine, type FieldFact, type ProductKey } from "./product-key";

export type OfferEmailKind = "supply_offer" | "request_stock" | "chase" | "stock_confirm" | "seller_reconfirm";

/** The buyer's own words, read from `buyer_profile`: the derived wants text and the dossier products. */
export type BuyerFacts = {
  wants?: string | null;
  products?: unknown;
};

/**
 * A request's own facts, from `crm_bulk_demand`: what the buyer wants, how many and by when. Requests have no
 * listing field rows, so this is where a stock ask gets its product, quantity and timing. The ceiling is here only so
 * the finished copy can be checked against it; the template never writes it.
 */
export type RequestFacts = {
  productFamily?: string | null;
  volume?: number | null;
  volumeUnit?: string | null;
  /** The quantity as written, used only when there is no volume. */
  quantity?: string | null;
  /** ISO date. */
  neededBy?: string | null;
  spec?: Record<string, unknown> | null;
  /** The buyer's price ceiling. Private: never in the copy. */
  maxPrice?: number | null;
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
  /** On a request: the request's own facts, for the stock ask and its chase. */
  request?: RequestFacts | null;
  /** Which side we are writing for, so a chase asks the right question. */
  side?: "supply" | "demand";
  /** The subject of the last email on this offer, for a chase. */
  previousSubject?: string | null;
  /** Names, contacts and addresses that must never appear in the copy. */
  privateValues?: (string | null | undefined)[];
  /** A stock confirm: what the supplier holds, in our words from their own stock line ("Stellantis 50 kWh pack x 23"). */
  holds?: string | null;
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

/** True when two names are the same once case, spaces and punctuation are ignored ("ro cell" and "Ro Cell"). */
export const sameName = (a: string | null | undefined, b: string | null | undefined) => {
  const key = (value: string | null | undefined) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  return !!key(a) && key(a) === key(b);
};

/**
 * A first name for the greeting, or null when what we hold is not one (an email, a number, a sentence). A "person"
 * whose name is the company's ("ro cell" at Ro Cell) is a mailbox, not a person, so it has no first name either.
 */
export function firstName(value: string | null | undefined, companyNames: (string | null | undefined)[] = []): string | null {
  const text = clean(value);
  if (!text || text.includes("@") || /\d/.test(text)) {
    return null;
  }
  if (companyNames.some((company) => sameName(company, text))) {
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
  // "Poland (delivery site tbc)": an aside in brackets is not part of the country.
  const parts = clean(clean(location).replace(/\([^)]*\)/g, " ")).split(",").map((part) => part.trim()).filter(Boolean);
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
  return first ? `Hi ${first},` : "Hello,";
}

const asStrings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : []);

/** What the request wants, in its own short words: the product family, else what the structured spec says. */
export function requestProduct(request: RequestFacts | null | undefined): string | null {
  const family = clean(request?.productFamily);
  if (family) {
    return family;
  }
  const spec = request?.spec ?? {};
  const bits = [
    ...asStrings(spec.cell_makers).slice(0, 1),
    ...asStrings(spec.makes).slice(0, 2),
    typeof spec.kwh_min === "number" && typeof spec.kwh_max === "number" ? `${round(spec.kwh_min)}-${round(spec.kwh_max)} kWh`
      : typeof spec.kwh_min === "number" ? `${round(spec.kwh_min)}+ kWh` : null,
    ...asStrings(spec.chemistries).slice(0, 2),
    asStrings(spec.formats)[0]?.toLowerCase() ?? null,
  ].filter((bit): bit is string => !!bit);
  return bits.length ? bits.join(" ") : null;
}

/** "500,000 cells", from the volume, else the quantity as written when it is short and has a figure. */
export function requestQuantity(request: RequestFacts | null | undefined): string | null {
  if (request?.volume != null && request.volume > 0) {
    const lower = clean(request.volumeUnit).toLowerCase();
    const unit = ({ kwh: "kWh", mwh: "MWh", gwh: "GWh" } as Record<string, string>)[lower] ?? lower;
    return `${request.volume.toLocaleString("en-GB")}${unit ? ` ${unit}` : ""}`;
  }
  const written = clean(request?.quantity);
  return written && /\d/.test(written) && written.length <= 40 ? written : null;
}

/** "31 January 2027", from the needed-by date. */
export function requestTiming(request: RequestFacts | null | undefined): string | null {
  const iso = clean(request?.neededBy).slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00Z`) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : null;
}

const COUNT_UNITS = new Set(["cell", "pack", "module", "system", "unit"]);

/** "500,000 x Samsung 50E-equivalent 21700 cells", or the product with its quantity in brackets. */
function requestPhrase(request: RequestFacts, product: string): string {
  const quantity = requestQuantity(request);
  if (!quantity) {
    return product;
  }
  const unit = clean(request.volumeUnit).toLowerCase().replace(/s$/, "");
  const amount = request.volume != null && request.volume > 0 ? request.volume.toLocaleString("en-GB") : null;
  // "500,000 x … cells" only for a count; an energy volume ("1,000 kWh") goes in brackets after the product.
  if (amount && COUNT_UNITS.has(unit) && product.toLowerCase().includes(unit)) {
    return `${amount} x ${product}`;
  }
  return `${product} (${quantity})`;
}

/** The state of health a request asks for, from its spec. A requirement, never a fact about the seller's stock. */
function requestSohLine(request: RequestFacts | null | undefined): string | null {
  const soh = request?.spec?.min_soh;
  return typeof soh === "number" && soh > 0 ? `We need at least ${round(soh)}% state of health.` : null;
}

/** The ceiling as it might be written, so the finished copy can be checked against every form of it. */
function ceilingValues(request: RequestFacts | null | undefined): string[] {
  const max = request?.maxPrice;
  if (max == null || !(max > 0)) {
    return [];
  }
  return [String(max), max.toFixed(2), `EUR ${max}`, `EUR ${max.toFixed(2)}`, `€${max}`, `€${max.toFixed(2)}`];
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
    : input.kind === "request_stock" || input.kind === "stock_confirm" ? publicCountry(input.location) : null;
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
    // A request's own facts first: requests have no field rows, so the key alone says nothing about them.
    const asked = requestProduct(input.request);
    if (input.request && asked) {
      const phrase = requestPhrase(input.request, asked);
      const timing = requestTiming(input.request);
      subject = `Stock enquiry: ${phrase}`;
      const facts = [timing ? `They're needed by ${timing}.` : null, requestSohLine(input.request) ?? requirementLine(fields)].filter(Boolean).join(" ");
      body = `${greeting(input.recipientFirstName)}\n\nWe're looking for ${phrase}${where}.${facts ? ` ${facts}` : ""}\n\n`
        + `Do you have anything that fits? If so, how many do you have, and when could they ship?\n\n${SIGN_OFF}`;
    } else {
      const short = productPhrase(input.key);
      subject = short ? `Stock enquiry: ${short}` : "Stock enquiry";
      const facts = [requirementLine(fields)].filter(Boolean).join(" ");
      body = `${greeting(input.recipientFirstName)}\n\nWe're looking for ${product}${where}.${facts ? ` ${facts}` : ""}\n\nDo you have anything that fits?\n\n${SIGN_OFF}`;
    }
  } else if (input.kind === "stock_confirm") {
    // A stored match on a request: the supplier is asked to confirm their own stock and quote. Their price is asked for,
    // never offered, and the request is described by its facts only, as in the stock ask.
    const asked = requestProduct(input.request);
    const phrase = input.request && asked ? requestPhrase(input.request, asked) : productLine(input.key);
    const timing = requestTiming(input.request);
    const facts = [timing ? `They're needed by ${timing}.` : null, requestSohLine(input.request)].filter(Boolean).join(" ");
    const holds = clean(input.holds);
    subject = `Stock check: ${phrase}`;
    body = `${greeting(input.recipientFirstName)}\n\nWe're looking for ${phrase}${where}.${facts ? ` ${facts}` : ""}\n\n`
      + `${holds ? `Is your ${holds} still available?` : "Is your stock still available?"} If so, how many can you offer, at what price, `
      + `and until when does that price hold?\n\n${SIGN_OFF}`;
  } else if (input.kind === "seller_reconfirm") {
    // A supply deal whose seller quote is missing or out of date: buyers are asked only once the seller confirms it again.
    const short = productPhrase(input.key);
    subject = short ? `Still available? ${short}` : "Still available?";
    body = `${greeting(input.recipientFirstName)}\n\nIs your ${product} still available?\n\n`
      + `Could you confirm how many you have, your price, and until when that price holds?\n\n${SIGN_OFF}`;
  } else {
    const short = productPhrase(input.key);
    const previous = clean(input.previousSubject);
    subject = previous
      ? (previous.toLowerCase().startsWith("re:") ? previous : `Re: ${previous}`)
      : short ? `Following up: ${short}` : "Following up";
    const ask = input.side === "demand" ? "Do you have anything that fits?" : "Is it still of interest?";
    const asked = input.side === "demand" && input.request ? requestProduct(input.request) : null;
    const about = asked ? requestPhrase(input.request!, asked) : product;
    body = `${greeting(input.recipientFirstName)}\n\nFollowing up on the note I sent about ${about}.\n\n${ask}\n\n${SIGN_OFF}`;
  }

  const leaked = firstLeak(`${subject}\n${body}`, input.privateValues ?? [])
    ?? firstLeak(`${subject}\n${body}`, [...priceValues(fields), ...ceilingValues(input.request)], { shortWords: false });
  if (leaked) {
    throw new OfferEmailRefused(leaked);
  }
  return { kind: input.kind, subject, body };
}
