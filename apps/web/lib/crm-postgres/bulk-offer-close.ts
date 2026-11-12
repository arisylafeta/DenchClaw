import "server-only";

// Offer to close, the reads and writes: the quote gate for one offer, the margin staff see, the price sheets stored with
// the deal's documents, and the price-of-record check. The rules themselves are in lib/bulk-offer-close.ts,
// lib/bulk-price-sheet.ts and lib/bulk-price-of-record.ts. Nothing here sends anything.
import { queryPg } from "../postgres";
import { buildProductKey, type FieldFact, type ProductKey } from "../match/product-key";
import { addressParts } from "../match/offer-email";
import { today as londonToday } from "../match/stored-match";
import { offerExpiry, offerMargin, quoteGate, type Margin, type QuoteGate } from "../bulk-offer-close";
import { buildPriceSheet, SHEET_TITLE, sheetReference, SheetRefused, type PriceSheet, type SheetKind, type SheetLot } from "../bulk-price-sheet";
import { comparePrices, type MarketplacePriceSource, type PriceCheck } from "../bulk-price-of-record";
import { sellerQuote } from "./bulk-matches";
import { addDocument } from "./bulk-documents";
import type { OfferTerms } from "./bulk-offers";

/** Who reads what this offer sends: a buyer (an offer on a supply listing) or a seller (an offer on a request). */
export type OfferSide = "buyer" | "seller";

export type OfferClose = {
  side: OfferSide;
  /** Null for a seller-facing offer: those are never gated. */
  gate: QuoteGate | null;
  /** The offer's last day: terms.expires_on, else the seller quote's. */
  expiresOn: string | null;
  /** How many: the offer's quantity, else what the match's yes confirmed. */
  quantity: number | null;
  /** Staff only. Null on a seller-facing offer. */
  margin: Margin | null;
};

type OfferFacts = {
  id: string; listing_id: string; kind: "supply" | "demand"; name: string | null; company_id: string | null; person_id: string | null;
  stage: string | null; terms: OfferTerms; quantity: number | null; data: Record<string, unknown>;
  match_until: string | null; match_qty: number | null;
};

async function offerFacts(offerId: string): Promise<OfferFacts | null> {
  const [row] = await queryPg<OfferFacts>(
    `select o.id, o.bulk_listing_id as listing_id, l.kind, o.name, o.company_id, o.person_id, o.stage, coalesce(o.terms, '{}'::jsonb) as terms,
       o.quantity::float8 as quantity, coalesce(o.data, '{}'::jsonb) as data,
       m.quote_valid_until::text as match_until, m.confirmed_qty::float8 as match_qty
     from crm_bulk_offers o join crm_bulk_listings l on l.id = o.bulk_listing_id
     left join crm_bulk_matches m on m.offer_id = o.id
     where o.id = $1 and o.role = 'counterparty'`, [offerId]);
  return row ?? null;
}

async function listingFields(listingId: string): Promise<FieldFact[]> {
  return queryPg<FieldFact>(
    `select field_key, value, status, visibility, coalesce(alternatives, '[]'::jsonb) as alternatives
     from crm_bulk_listing_fields where bulk_listing_id = $1`, [listingId]);
}

/** kWh per unit of a single-product lot, to convert per-kWh and per-unit prices. */
const kwhPerUnit = (key: ProductKey) => (!key.mixed && key.lines.length === 1 ? key.lines[0].kwh : null);

/** The quote gate for one offer. A buyer-facing offer reads the seller quote of its supply listing and its match's date. */
export async function offerGate(offerId: string, now: Date = new Date()): Promise<{ side: OfferSide; gate: QuoteGate | null } | null> {
  const offer = await offerFacts(offerId);
  if (!offer) {
    return null;
  }
  return gateFor(offer, now);
}

async function gateFor(offer: OfferFacts, now: Date): Promise<{ side: OfferSide; gate: QuoteGate | null }> {
  if (offer.kind !== "supply") {
    return { side: "seller", gate: null };
  }
  const quote = await sellerQuote(offer.listing_id, now);
  return { side: "buyer", gate: quoteGate(quote, londonToday(now), offer.match_until) };
}

/** Everything the offer card needs to close: the gate, the last day, the quantity and, for staff, the margin. */
export async function offerClose(offerId: string, now: Date = new Date()): Promise<OfferClose | null> {
  const offer = await offerFacts(offerId);
  if (!offer) {
    return null;
  }
  const { side, gate } = await gateFor(offer, now);
  const quantity = offer.quantity ?? offer.match_qty ?? null;
  let margin: Margin | null = null;
  if (side === "buyer") {
    const key = buildProductKey({ fields: await listingFields(offer.listing_id) });
    margin = offerMargin({
      buyer: offer.terms,
      seller: key.sellerPrice ? { amount: key.sellerPrice.amount, currency: key.sellerPrice.currency, per: key.sellerPrice.per } : null,
      quantity, kwhPerUnit: kwhPerUnit(key),
    });
  }
  return { side, gate, expiresOn: side === "buyer" ? offerExpiry(offer.terms.expires_on, gate) : offer.terms.expires_on ?? null, quantity, margin };
}

type SellerSide = { party: string | null; contact: string | null; email: string | null; location: string | null; person_name: string | null; company_name: string | null };

/** The seller's name, contact and address parts on a supply listing: none may reach a buyer's sheet. */
async function sellerPrivate(listingId: string): Promise<string[]> {
  const [row] = await queryPg<SellerSide>(
    `select l.party, l.contact, l.email, l.location, p.full_name as person_name, c.name as company_name
     from crm_bulk_listings l left join crm_people p on p.id = l.person_id left join crm_companies c on c.id = l.company_id
     where l.id = $1`, [listingId]);
  if (!row) {
    return [];
  }
  return [row.party, row.contact, row.email, row.person_name, row.company_name, ...addressParts(row.location)]
    .map((value) => (value ?? "").trim()).filter(Boolean);
}

/** A priced, in-date lot for a buyer's sheet: the offer's own price, never the seller's. */
async function lotFor(offer: OfferFacts, now: Date): Promise<{ lot: SheetLot; gate: QuoteGate; privateValues: string[] } | { why: string }> {
  const { side, gate } = await gateFor(offer, now);
  if (side !== "buyer" || !gate) {
    return { why: "Price sheets go to buyers. This offer is to a seller." };
  }
  if (!gate.ok) {
    return { why: gate.reason };
  }
  const { amount, currency, unit } = offer.terms;
  if (amount == null || !currency || !unit) {
    return { why: "Record the buyer price on the offer first: amount, currency and unit." };
  }
  return {
    lot: { fields: await listingFields(offer.listing_id), price: { amount, currency, unit }, quantity: offer.quantity ?? offer.match_qty ?? null },
    gate,
    privateValues: await sellerPrivate(offer.listing_id),
  };
}

const STAGES_OPEN = ["candidate", "offered", "negotiating"];

/** The other live offers to the same buyer on supply listings, for the overview: one row per lot. */
async function sameBuyerOffers(offer: OfferFacts): Promise<OfferFacts[]> {
  if (!offer.company_id && !offer.person_id) {
    return [];
  }
  const ids = await queryPg<{ id: string }>(
    `select o.id from crm_bulk_offers o join crm_bulk_listings l on l.id = o.bulk_listing_id
     where o.role = 'counterparty' and l.kind = 'supply' and l.status <> 'closed' and o.id <> $1 and o.stage = any($4::text[])
       and (($2::text is not null and o.company_id = $2) or ($2::text is null and $3::text is not null and o.person_id = $3))
     order by o.created_at`, [offer.id, offer.company_id, offer.person_id, STAGES_OPEN]);
  const rows = await Promise.all(ids.map((row) => offerFacts(row.id)));
  return rows.filter((row): row is OfferFacts => !!row);
}

export type PreparedSheet = { sheet: PriceSheet; kind: SheetKind; lines: number; buyer: string | null; skipped: { offerId: string; why: string }[] };

/**
 * Builds one sheet for this offer, in memory. `overview` adds the buyer's other live, priced, in-date lots; `fixed` and
 * `send` are this offer's confirmed line. Refuses (SheetRefused) with the reason a person can act on.
 */
export async function prepareOfferSheet(offerId: string, kind: SheetKind, now: Date = new Date()): Promise<PreparedSheet> {
  const offer = await offerFacts(offerId);
  if (!offer) {
    throw new SheetRefused("Offer not found.");
  }
  const first = await lotFor(offer, now);
  if ("why" in first) {
    throw new SheetRefused(first.why);
  }
  const lots = [first.lot];
  const privateValues = [...first.privateValues];
  const skipped: PreparedSheet["skipped"] = [];
  if (kind === "overview") {
    for (const other of await sameBuyerOffers(offer)) {
      const lot = await lotFor(other, now);
      if ("why" in lot) {
        skipped.push({ offerId: other.id, why: lot.why });
        continue;
      }
      lots.push(lot.lot);
      privateValues.push(...lot.privateValues);
    }
  }
  const sheet = buildPriceSheet({
    kind, reference: sheetReference(), date: londonToday(now), lots,
    delivery: kind === "overview" ? null : offer.terms.delivery_terms ?? null,
    payment: kind === "overview" ? null : offer.terms.payment_terms ?? null,
    validUntil: kind === "overview" ? null : offerExpiry(offer.terms.expires_on, first.gate),
    privateValues,
  });
  return { sheet, kind, lines: lots.length, buyer: offer.name, skipped };
}

/**
 * Stores a prepared sheet with the deal's documents (crm_bulk_listing_documents) as a draft we prepared, and notes it on
 * the listing's History and the offer's thread. A send copy is remembered on the offer, so the send marks it sent.
 */
export async function storeOfferSheet(
  listingId: string, offerId: string, prepared: PreparedSheet, actorUserId: string | null, draftId: string | null = null,
): Promise<string> {
  const { sheet, kind } = prepared;
  const total = sheet.total ? ` Total ${sheet.total.currency} ${sheet.total.amount.toLocaleString("en-GB")}.` : "";
  const doc = await addDocument(listingId, {
    title: `${SHEET_TITLE[kind]} ${sheet.reference} for ${prepared.buyer ?? "buyer"}`,
    doc_type: "Quote",
    state: "draft",
    direction: "prepared",
    visibility: "never",
    note: kind === "send"
      ? `Goes with the offer email${draftId ? ` (draft ${draftId})` : ""}. Not sent yet.${total}`
      : `${prepared.lines} ${prepared.lines === 1 ? "line" : "lines"}.${total}`,
  }, { name: sheet.fileName, type: SHEET_MIME, content: sheet.file }, actorUserId, offerId);
  if (!doc) {
    throw new SheetRefused("Listing not found.");
  }
  if (kind === "send") {
    await queryPg(`update crm_bulk_offers set data = data || jsonb_build_object('open_sheet_doc_id', $2::text), updated_at = now() where id = $1`, [offerId, doc.id]);
  }
  return doc.id;
}

const SHEET_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The listing's CRM price (its `seller_price`, as held) against the marketplace's, from an injected source. Not wired to a
 * live source: no local copy of a deal's marketplace price exists (see bulk-price-of-record.ts).
 */
export async function priceOfRecord(listingId: string, source: MarketplacePriceSource): Promise<PriceCheck> {
  const [listing] = await queryPg<{ marketplace_listing_id: string | null }>(
    `select marketplace_listing_id from crm_bulk_listings where id = $1 and kind = 'supply'`, [listingId]);
  if (!listing?.marketplace_listing_id) {
    return { state: "unknown", why: "This listing is not on the marketplace.", flag: null };
  }
  // The price the CRM holds, whether or not the seller has re-confirmed it: this is about what we show, not what we offer.
  const fields = (await listingFields(listingId)).map((row) => (row.field_key === "seller_price" ? { ...row, status: "confirmed" } : row));
  const key = buildProductKey({ fields });
  const crm = key.sellerPrice ? { amount: key.sellerPrice.amount, currency: key.sellerPrice.currency, unit: key.sellerPrice.per } : null;
  return comparePrices(crm, await source(listing.marketplace_listing_id), kwhPerUnit(key));
}
