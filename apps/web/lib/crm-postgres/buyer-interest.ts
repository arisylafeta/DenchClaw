import { randomUUID } from "node:crypto";
import { queryPg } from "../postgres";
import { todayInLondon } from "../bulk-trades";
import { productKeyFor, productKeyLevel, type ProductFacts } from "../match/product-key-for";

/**
 * A buyer's wants, read and written for the Buyer tab.
 *
 * Mastered lines (standing, interest, inferred) are edited here. Synced lines (ask, saved_search, bought,
 * declined) are copies of their source row and are read-only: they change only at the source, and the link
 * on the line opens it.
 */

export const MASTERED_KINDS = ["standing", "interest", "inferred"] as const;
export type MasteredKind = typeof MASTERED_KINDS[number];
export const SYNCED_KINDS = ["ask", "saved_search", "bought", "declined"] as const;

export const KIND_LABEL: Record<string, string> = {
  ask: "Ask", standing: "Standing", interest: "Interest", saved_search: "Saved search",
  inferred: "Inferred", bought: "Bought", declined: "Declined",
};

/** How long a mastered want stays current without being seen again (plan section 1). */
const DEFAULT_EXPIRY_DAYS: Record<MasteredKind, number> = { standing: 90, interest: 180, inferred: 180 };

const QUANTITY_UNITS = ["packs", "modules", "cells", "systems", "kWh", "MWh", "tonnes"];
const CURRENCIES = ["EUR", "USD", "GBP"];
const PRICE_UNITS = ["kWh", "pack", "cell"];
const PRICE_BASES = ["paid", "bid", "target"];

export type BuyerInterest = {
  id: string;
  company_id: string;
  person_id: string | null;
  kind: string;
  ownership: "mastered" | "synced";
  product_key: string;
  product_key_level: string | null;
  make: string | null;
  model: string | null;
  format: string | null;
  chemistry: string | null;
  kwh_min: number | null;
  kwh_max: number | null;
  first_seen: string;
  last_seen: string;
  quantity: number | null;
  quantity_unit: string | null;
  quantity_basis: string | null;
  price: number | null;
  price_currency: string | null;
  price_unit: string | null;
  price_basis: string | null;
  source_refs: string[];
  expires_on: string | null;
  demand_id: string | null;
  offer_id: string | null;
  offer_listing_id: string | null;
  saved_search_id: string | null;
  decline_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type BuyerInterestLine = BuyerInterest & {
  kind_label: string;
  label: string;
  expired: boolean;
  /** Where a synced line comes from; mastered lines have no source until an agent cites one. */
  source: { label: string; href: string | null } | null;
};

const SELECT = `select interest.id, interest.company_id, interest.person_id, interest.kind, interest.ownership,
  interest.product_key, interest.product_key_level, interest.make, interest.model, interest.format, interest.chemistry,
  interest.kwh_min::float8 as kwh_min, interest.kwh_max::float8 as kwh_max,
  interest.first_seen::text, interest.last_seen::text, interest.quantity::float8 as quantity, interest.quantity_unit,
  interest.quantity_basis, interest.price::float8 as price, interest.price_currency, interest.price_unit, interest.price_basis,
  interest.source_refs, interest.expires_on::text, interest.demand_id, interest.offer_id, offer.bulk_listing_id as offer_listing_id,
  interest.saved_search_id, interest.decline_reason, interest.created_at::text, interest.updated_at::text
  from buyer_interest interest left join crm_bulk_offers offer on offer.id = interest.offer_id`;

/** "NMC packs 50-60 kWh" / "Hyundai Ioniq 5 77.4 kWh" from the stored facts, never from the key. */
export function interestLabel(row: Pick<BuyerInterest, "make" | "model" | "format" | "chemistry" | "kwh_min" | "kwh_max" | "product_key">): string {
  const parts: string[] = [];
  const vehicle = [row.make, row.model].filter(Boolean).join(" ");
  if (vehicle) {parts.push(vehicle);}
  if (row.format) {parts.push(row.format === "cell" ? "cells" : row.format === "module" ? "modules" : row.format === "system" ? "systems" : "packs");}
  if (row.chemistry) {parts.push(row.chemistry);}
  if (row.kwh_min !== null && row.kwh_max !== null) {
    parts.push(row.kwh_min === row.kwh_max ? `${row.kwh_min} kWh` : `${row.kwh_min}-${row.kwh_max} kWh`);
  } else if (row.kwh_min !== null) {
    parts.push(`${row.kwh_min}+ kWh`);
  } else if (row.kwh_max !== null) {
    parts.push(`up to ${row.kwh_max} kWh`);
  }
  if (!parts.length) {parts.push(row.product_key.replace(/^[a-z]+:/, "").replace(/-/g, " "));}
  return parts.join(", ");
}

function sourceFor(row: BuyerInterest): { label: string; href: string | null } | null {
  if (row.demand_id) {return { label: "Demand", href: `/?path=bulk_trade&demand=${encodeURIComponent(row.demand_id)}` };}
  if (row.offer_listing_id) {return { label: "Offer", href: `/?path=bulk_trade&supply=${encodeURIComponent(row.offer_listing_id)}` };}
  if (row.saved_search_id) {return { label: "Saved search", href: "https://www.rebattery.io/marketplace/listings" };}
  return null;
}

function toLine(row: BuyerInterest, today: string): BuyerInterestLine {
  return {
    ...row,
    kind_label: KIND_LABEL[row.kind] ?? row.kind,
    label: interestLabel(row),
    expired: row.expires_on !== null && row.expires_on <= today,
    source: row.ownership === "synced" ? sourceFor(row) : null,
  };
}

/** Every line for one buyer: live first, then newest, with the source of each synced line. */
export async function listBuyerInterests(companyId: string, today = todayInLondon()): Promise<BuyerInterestLine[]> {
  const rows = await queryPg<BuyerInterest>(
    `${SELECT} where interest.company_id = $1
     order by (interest.expires_on is not null and interest.expires_on <= $2::date), interest.last_seen desc, interest.product_key, interest.kind`,
    [companyId, today]);
  return rows.map((row) => toLine(row, today));
}

export class InterestInvalid extends Error {}
export class InterestReadOnly extends Error {}

export type InterestInput = {
  kind?: string;
  person_id?: string | null;
  make?: string | null;
  model?: string | null;
  format?: string | null;
  chemistry?: string | null;
  kwh?: number | null;
  kwh_min?: number | null;
  kwh_max?: number | null;
  cell_maker?: string | null;
  part_numbers?: string[] | null;
  quantity?: number | null;
  quantity_unit?: string | null;
  quantity_basis?: string | null;
  price?: number | null;
  price_currency?: string | null;
  price_unit?: string | null;
  price_basis?: string | null;
  expires_on?: string | null;
  source_refs?: string[] | null;
};

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) {return null;}
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
};

const number = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined || value === "") {return null;}
  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) {throw new InterestInvalid(`${field} must be a positive number.`);}
  return parsed;
};

/** pack, Packs, "PACK" and systems all reach the stored singular. */
const normalFormat = (value: unknown): string | null => {
  const text_ = (text(value) ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (text_.startsWith("pack")) {return "pack";}
  if (text_.startsWith("module")) {return "module";}
  if (text_.startsWith("cell")) {return "cell";}
  if (text_.startsWith("system")) {return "system";}
  return null;
};

const oneOf = (value: unknown, allowed: string[], field: string): string | null => {
  const parsed = text(value);
  if (parsed === null) {return null;}
  if (!allowed.includes(parsed)) {throw new InterestInvalid(`${field} must be one of ${allowed.join(", ")}.`);}
  return parsed;
};

const isoDate = (value: unknown, field: string): string | null => {
  const parsed = text(value);
  if (parsed === null) {return null;}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {throw new InterestInvalid(`${field} must be a date (YYYY-MM-DD).`);}
  return parsed;
};

function factsOf(input: InterestInput): ProductFacts {
  return {
    partNumbers: input.part_numbers ?? null,
    make: input.make ?? null,
    model: input.model ?? null,
    format: input.format ?? null,
    chemistry: input.chemistry ?? null,
    kwh: input.kwh ?? null,
    kwhMin: input.kwh_min ?? null,
    kwhMax: input.kwh_max ?? null,
    cellMaker: input.cell_maker ?? null,
  };
}

type Clean = Required<Pick<InterestInput, "kind">> & Omit<InterestInput, "kind"> & { product_key: string; product_key_level: string };

/** Validates a want and computes its key. A want must say what product it is about, not only that it exists. */
function clean(input: InterestInput, creating: boolean): Clean {
  const kind = text(input.kind) ?? (creating ? "standing" : null);
  if (creating && !kind) {throw new InterestInvalid("Say what kind of want this is.");}
  if (kind !== null && !(MASTERED_KINDS as readonly string[]).includes(kind)) {
    throw new InterestReadOnly(`A ${kind} line is synced from its source and cannot be edited here.`);
  }
  const facts = factsOf(input);
  const productKey = productKeyFor(facts);
  if (productKey === "broad:any-batteries") {
    throw new InterestInvalid("State the product: a part number, make and model with kWh, a cell, or a chemistry and format.");
  }
  const kwhMin = number(input.kwh_min, "Minimum kWh");
  const kwhMax = number(input.kwh_max, "Maximum kWh");
  if (kwhMin !== null && kwhMax !== null && kwhMin > kwhMax) {throw new InterestInvalid("Minimum kWh is above maximum kWh.");}
  const quantity = number(input.quantity, "Quantity");
  const price = number(input.price, "Price");
  const empty = (value: string | null) => value === null;
  if (empty(text(input.quantity_unit)) !== (quantity === null)) {
    throw new InterestInvalid("Give a quantity and its unit together, or neither.");
  }
  if (empty(text(input.price_currency)) !== (price === null) || empty(text(input.price_unit)) !== (price === null)) {
    throw new InterestInvalid("Give a price with its currency and unit, or none.");
  }
  const refs = (input.source_refs ?? []).map((ref) => String(ref).trim()).filter(Boolean);
  for (const ref of refs) {
    if (!/^[a-z_]+:.+$/.test(ref)) {throw new InterestInvalid("Source references are prefixed ids, such as crm:btd_123.");}
  }
  return {
    kind: kind as MasteredKind,
    person_id: text(input.person_id),
    make: text(input.make),
    model: text(input.model),
    format: normalFormat(input.format),
    chemistry: text(input.chemistry),
    kwh: number(input.kwh, "kWh"),
    kwh_min: kwhMin,
    kwh_max: kwhMax,
    cell_maker: text(input.cell_maker),
    part_numbers: (input.part_numbers ?? []).map((part) => String(part).trim()).filter(Boolean),
    quantity,
    quantity_unit: oneOf(input.quantity_unit, QUANTITY_UNITS, "Quantity unit"),
    quantity_basis: oneOf(input.quantity_basis, ["stated", "not_stated"], "Quantity basis") ?? (quantity === null ? "not_stated" : "stated"),
    price,
    price_currency: oneOf(input.price_currency, CURRENCIES, "Currency"),
    price_unit: oneOf(input.price_unit, PRICE_UNITS, "Price unit"),
    price_basis: oneOf(input.price_basis, PRICE_BASES, "Price basis") ?? (price === null ? null : "target"),
    expires_on: isoDate(input.expires_on, "Expires on"),
    source_refs: refs,
    product_key: productKey,
    product_key_level: productKeyLevel(productKey),
  };
}

async function assertCompany(companyId: string): Promise<void> {
  const [row] = await queryPg<{ id: string }>("select id from crm_companies where id = $1", [companyId]);
  if (!row) {throw new InterestInvalid("Company not found.");}
}

async function assertPerson(companyId: string, personId: string | null): Promise<void> {
  if (!personId) {return;}
  const [row] = await queryPg<{ id: string }>(
    "select id from crm_people where id = $1 and (company_id = $2 or company_id is null)", [personId, companyId]);
  if (!row) {throw new InterestInvalid("That person is not at this company.");}
}

function expiryFor(kind: MasteredKind, today: string, stated: string | null): string | null {
  if (stated) {return stated;}
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + DEFAULT_EXPIRY_DAYS[kind]);
  return date.toISOString().slice(0, 10);
}

/** Adds a mastered want. A repeated want for the same product and kind merges: last_seen moves, facts fill gaps. */
export async function createBuyerInterest(companyId: string, input: InterestInput, today = todayInLondon()): Promise<BuyerInterestLine> {
  const value = clean(input, true);
  await assertCompany(companyId);
  await assertPerson(companyId, value.person_id ?? null);
  const [row] = await queryPg<BuyerInterest>(
    `insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
       make, model, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit, quantity_basis,
       price, price_currency, price_unit, price_basis, source_refs, expires_on)
     values ($1, $2, $3, $4, 'mastered', $5, $6, $7, $8, $9, $10, $11, $12, $13::date, $13::date, $14, $15, $16, $17, $18, $19, $20, $21, $22::date)
     on conflict (company_id, product_key, kind) where ownership = 'mastered' do update set
       person_id = coalesce(excluded.person_id, buyer_interest.person_id),
       make = coalesce(excluded.make, buyer_interest.make),
       model = coalesce(excluded.model, buyer_interest.model),
       format = coalesce(excluded.format, buyer_interest.format),
       chemistry = coalesce(excluded.chemistry, buyer_interest.chemistry),
       kwh_min = coalesce(excluded.kwh_min, buyer_interest.kwh_min),
       kwh_max = coalesce(excluded.kwh_max, buyer_interest.kwh_max),
       quantity = coalesce(excluded.quantity, buyer_interest.quantity),
       quantity_unit = coalesce(excluded.quantity_unit, buyer_interest.quantity_unit),
       quantity_basis = coalesce(excluded.quantity_basis, buyer_interest.quantity_basis),
       price = coalesce(excluded.price, buyer_interest.price),
       price_currency = coalesce(excluded.price_currency, buyer_interest.price_currency),
       price_unit = coalesce(excluded.price_unit, buyer_interest.price_unit),
       price_basis = coalesce(excluded.price_basis, buyer_interest.price_basis),
       source_refs = coalesce((select array_agg(distinct ref order by ref) from unnest(buyer_interest.source_refs || excluded.source_refs) ref), '{}'),
       expires_on = greatest(coalesce(excluded.expires_on, buyer_interest.expires_on), buyer_interest.expires_on),
       last_seen = greatest(buyer_interest.last_seen, excluded.last_seen),
       updated_at = now()
     returning id, company_id, person_id, kind, ownership, product_key, product_key_level, make, model, format, chemistry,
       kwh_min::float8 as kwh_min, kwh_max::float8 as kwh_max, first_seen::text, last_seen::text, quantity::float8 as quantity,
       quantity_unit, quantity_basis, price::float8 as price, price_currency, price_unit, price_basis, source_refs,
       expires_on::text, demand_id, offer_id, null::text as offer_listing_id, saved_search_id, decline_reason,
       created_at::text, updated_at::text`,
    [randomUUID(), companyId, value.person_id, value.kind, value.product_key, value.product_key_level,
      value.make, value.model, value.format, value.chemistry, value.kwh_min, value.kwh_max,
      today, value.quantity, value.quantity_unit, value.quantity_basis, value.price, value.price_currency,
      value.price_unit, value.price_basis, value.source_refs, expiryFor(value.kind as MasteredKind, today, value.expires_on ?? null)]);
  return toLine(row, today);
}

/** Facts a patch may change; changing any of them recomputes the key. Part numbers are key-only, never stored as a column. */
const FACT_KEYS = ["make", "model", "format", "chemistry", "kwh", "kwh_min", "kwh_max", "cell_maker", "part_numbers"] as const;

/** Edits a mastered want: facts, quantity, price, expiry. Omitted fields keep their value; a synced line is refused. */
export async function updateBuyerInterest(companyId: string, id: string, input: InterestInput, today = todayInLondon()): Promise<BuyerInterestLine | null> {
  const [current] = await queryPg<BuyerInterest>(`${SELECT} where interest.id = $1 and interest.company_id = $2`, [id, companyId]);
  if (!current) {return null;}
  if (current.ownership !== "mastered") {throw new InterestReadOnly("This line is synced from its source; change it there.");}

  const pick = <K extends keyof InterestInput>(key: K, fallback: InterestInput[K]): InterestInput[K] =>
    Object.prototype.hasOwnProperty.call(input, key) ? input[key] : fallback;
  const merged: InterestInput = {
    kind: current.kind,
    person_id: pick("person_id", current.person_id),
    make: pick("make", current.make),
    model: pick("model", current.model),
    format: pick("format", current.format),
    chemistry: pick("chemistry", current.chemistry),
    kwh: pick("kwh", null),
    kwh_min: pick("kwh_min", current.kwh_min),
    kwh_max: pick("kwh_max", current.kwh_max),
    cell_maker: pick("cell_maker", null),
    part_numbers: pick("part_numbers", null),
    quantity: pick("quantity", current.quantity),
    quantity_unit: pick("quantity_unit", current.quantity_unit),
    quantity_basis: pick("quantity_basis", current.quantity_basis),
    price: pick("price", current.price),
    price_currency: pick("price_currency", current.price_currency),
    price_unit: pick("price_unit", current.price_unit),
    price_basis: pick("price_basis", current.price_basis),
    expires_on: pick("expires_on", current.expires_on),
    source_refs: pick("source_refs", current.source_refs),
  };
  const value = clean(merged, false);
  await assertPerson(companyId, value.person_id ?? null);
  // A patch that names no fact keeps the proven key (a part-number key has no column to rebuild it from).
  const factsChanged = FACT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(input, key));
  const [row] = await queryPg<BuyerInterest>(
    `update buyer_interest set person_id = $3, make = $4, model = $5, format = $6, chemistry = $7, kwh_min = $8, kwh_max = $9,
       quantity = $10, quantity_unit = $11, quantity_basis = $12, price = $13, price_currency = $14, price_unit = $15,
       price_basis = $16, expires_on = $17::date, source_refs = $18,
       product_key = $19, product_key_level = $20, last_seen = greatest(last_seen, $21::date), updated_at = now()
     where id = $1 and company_id = $2 and ownership = 'mastered'
     returning id, company_id, person_id, kind, ownership, product_key, product_key_level, make, model, format, chemistry,
       kwh_min::float8 as kwh_min, kwh_max::float8 as kwh_max, first_seen::text, last_seen::text, quantity::float8 as quantity,
       quantity_unit, quantity_basis, price::float8 as price, price_currency, price_unit, price_basis, source_refs,
       expires_on::text, demand_id, offer_id, null::text as offer_listing_id, saved_search_id, decline_reason,
       created_at::text, updated_at::text`,
    [id, companyId, value.person_id, value.make, value.model, value.format, value.chemistry, value.kwh_min,
      value.kwh_max, value.quantity, value.quantity_unit, value.quantity_basis, value.price, value.price_currency,
      value.price_unit, value.price_basis, expiryFor(value.kind as MasteredKind, today, value.expires_on ?? null),
      value.source_refs, factsChanged ? value.product_key : current.product_key,
      factsChanged ? value.product_key_level : current.product_key_level, today]);
  return row ? toLine(row, today) : null;
}

/** Expires a want today, keeping it as history. */
export async function expireBuyerInterest(companyId: string, id: string, today = todayInLondon()): Promise<BuyerInterestLine | null> {
  const [row] = await queryPg<BuyerInterest>(
    `update buyer_interest set expires_on = $3::date, updated_at = now()
     where id = $1 and company_id = $2 and ownership = 'mastered'
     returning id, company_id, person_id, kind, ownership, product_key, product_key_level, make, model, format, chemistry,
       kwh_min::float8 as kwh_min, kwh_max::float8 as kwh_max, first_seen::text, last_seen::text, quantity::float8 as quantity,
       quantity_unit, quantity_basis, price::float8 as price, price_currency, price_unit, price_basis, source_refs,
       expires_on::text, demand_id, offer_id, null::text as offer_listing_id, saved_search_id, decline_reason,
       created_at::text, updated_at::text`,
    [id, companyId, today]);
  if (row) {return toLine(row, today);}
  const [synced] = await queryPg<{ ownership: string }>("select ownership from buyer_interest where id = $1 and company_id = $2", [id, companyId]);
  if (synced) {throw new InterestReadOnly("This line is synced from its source; change it there.");}
  return null;
}
