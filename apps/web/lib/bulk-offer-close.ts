// Offer to close: the rules an offer to a buyer must pass, worked out from facts already stored. Safe for client and
// server: no database, no model.
//
// The quote gate. A buyer hears a price only while the seller's own quote behind it is confirmed and in date: the
// `seller_price` field confirmed and `spec.seller_quote_valid_until` today or later (slice 4's sellerQuote), and, when
// the offer came from a stored match that recorded its own end date, that date too. The offer's `terms.expires_on`
// defaults to the quote's last day and may not run past it. Seller-facing drafts are never gated.
//
// The margin. Buyer price (the offer's `terms`) minus the seller's confirmed quote, times the quantity, in the buyer's
// currency; the take it implies is that margin in pounds. Different currencies or units are converted at the CRM's fixed
// rates (EUR_PER) and the kWh per unit of a single-product lot, and the result says it is approximate.
import { EUR_PER } from "./demand-match";
import type { OfferStage } from "./crm-postgres/bulk-offers";

/** "3 Nov": the day a quote ran out or holds until, as the card and the API say it. */
export function quoteDay(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** The supply side's quote as stored: the seller's price text, its field status and its last day. */
export type SupplyQuote = { value: string | null; status: string | null; validUntil: string | null };

export type QuoteGate =
  | { ok: true; validUntil: string }
  | { ok: false; reason: string; validUntil: string | null };

const ASK = "Ask them to confirm it.";

/**
 * May a buyer-facing offer go out today (`on`, YYYY-MM-DD in London)? Blocked says exactly why, in words the card and the
 * API both show. `matchUntil` is the stored match's own quote date, when the offer came from one and it recorded one.
 */
export function quoteGate(quote: SupplyQuote | null, on: string, matchUntil?: string | null): QuoteGate {
  const until = quote?.validUntil?.slice(0, 10) ?? null;
  if (!quote?.value?.trim()) {
    return { ok: false, reason: `The seller has not given a price yet. ${ASK}`, validUntil: until };
  }
  if (!until) {
    return { ok: false, reason: `The seller's quote has no end date. ${ASK}`, validUntil: null };
  }
  if (until < on) {
    return { ok: false, reason: `The seller's quote ran out on ${quoteDay(until)}. ${ASK}`, validUntil: until };
  }
  if (quote.status !== "confirmed") {
    return { ok: false, reason: `The seller's price is not confirmed. ${ASK}`, validUntil: until };
  }
  const match = matchUntil?.slice(0, 10) ?? null;
  if (match && match < on) {
    return { ok: false, reason: `The quote on this match ran out on ${quoteDay(match)}. Ask the seller to confirm it.`, validUntil: match };
  }
  return { ok: true, validUntil: match && match < until ? match : until };
}

/** The offer's last day: what was asked for, else the quote's. Null when no quote date is known yet. */
export function offerExpiry(requested: string | null | undefined, gate: QuoteGate | null): string | null {
  return requested?.slice(0, 10) || gate?.validUntil || null;
}

/** Why an offer's last day is refused, or null: it may not be later than the seller's quote. */
export function expiryProblem(requested: string | null | undefined, gate: QuoteGate | null): string | null {
  const day = requested?.slice(0, 10);
  if (!day) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return "Use a valid-until date like 2026-12-03.";
  }
  if (gate?.validUntil && day > gate.validUntil) {
    return `The offer cannot run past the seller's quote, which ends on ${quoteDay(gate.validUntil)}.`;
  }
  return null;
}

export type PriceUnit = "kwh" | "mwh" | "unit";

/** What a written unit buys: "kWh", "MWh", or one item (unit, pack, module, cell). Anything else cannot be compared. */
export function priceUnit(unit: string | null | undefined): PriceUnit | null {
  const word = (unit ?? "").trim().toLowerCase().replace(/^per\s+/, "").replace(/s$/, "");
  if (word === "kwh") return "kwh";
  if (word === "mwh") return "mwh";
  return ["unit", "pack", "module", "cell", "item", "piece", "pc", "system"].includes(word) ? "unit" : null;
}

const fx = (currency: string | null | undefined) => (currency ? EUR_PER[currency.toUpperCase()] ?? null : null);

/** `amount` per `from` as an amount per `to`, using kWh per unit when one side is per item. Null when it cannot. */
function perUnit(amount: number, from: PriceUnit, to: PriceUnit, kwhPerUnit: number | null): number | null {
  const perKwh = from === "kwh" ? amount : from === "mwh" ? amount / 1000 : kwhPerUnit ? amount / kwhPerUnit : null;
  if (from === to) return amount;
  if (perKwh == null) return null;
  if (to === "kwh") return perKwh;
  if (to === "mwh") return perKwh * 1000;
  return kwhPerUnit ? perKwh * kwhPerUnit : null;
}

export type Price = { amount: number; currency: string; unit: string };

export type Margin =
  | {
    ok: true;
    /** The buyer's currency and unit: the margin is counted in them. */
    currency: string; unit: string;
    /** Buyer price, and the seller's quote in the buyer's currency and unit. */
    buyerPrice: number; sellerPrice: number;
    perUnit: number; quantity: number; total: number; buyerTotal: number;
    /** The take the margin implies, in whole pounds; what Paid prefills. */
    takeGbp: number;
    /** Margin as a share of what the buyer pays, in percent (one decimal). */
    feePct: number | null;
    /** True when a currency or a unit was converted, so the figure is an estimate. */
    approx: boolean;
  }
  | { ok: false; why: string };

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The deal's margin for staff: (buyer price - seller quote) x quantity. The seller's quote is the parsed, confirmed
 * `seller_price` (ProductKey.sellerPrice); an unconfirmed or unparsable one gives no margin, with the reason.
 */
export function offerMargin(input: {
  buyer: Partial<Price> | null | undefined;
  seller: { amount: number; currency: string; per: PriceUnit } | null | undefined;
  quantity: number | null | undefined;
  /** kWh per unit of a single-product lot, to convert per-kWh and per-unit prices. */
  kwhPerUnit?: number | null;
}): Margin {
  const { buyer, seller } = input;
  if (buyer?.amount == null || !buyer.currency) {
    return { ok: false, why: "No buyer price on the offer yet." };
  }
  if (!seller) {
    return { ok: false, why: "No confirmed seller price to count from." };
  }
  if (!input.quantity || !(input.quantity > 0)) {
    return { ok: false, why: "No quantity on the offer yet." };
  }
  const unit = priceUnit(buyer.unit);
  if (!unit) {
    return { ok: false, why: `The buyer price is per ${buyer.unit || "nothing stated"}, which cannot be compared with the seller's.` };
  }
  const buyerRate = fx(buyer.currency);
  const sellerRate = fx(seller.currency);
  if (buyerRate == null || sellerRate == null) {
    return { ok: false, why: `No exchange rate for ${buyerRate == null ? buyer.currency : seller.currency}.` };
  }
  const sameUnits = unit === seller.per;
  const converted = perUnit(seller.amount, seller.per, unit, input.kwhPerUnit ?? null);
  if (converted == null) {
    return { ok: false, why: "The seller's price and the buyer price are in different units and the kWh per unit is not known." };
  }
  const sellerPrice = round2((converted * sellerRate) / buyerRate);
  const per = round2(buyer.amount - sellerPrice);
  const total = round2(per * input.quantity);
  const buyerTotal = round2(buyer.amount * input.quantity);
  return {
    ok: true, currency: buyer.currency.toUpperCase(), unit: buyer.unit ?? unit, buyerPrice: buyer.amount, sellerPrice,
    perUnit: per, quantity: input.quantity, total, buyerTotal,
    takeGbp: Math.round((total * buyerRate) / (EUR_PER.GBP ?? 1)),
    feePct: buyerTotal ? Math.round((total / buyerTotal) * 1000) / 10 : null,
    approx: buyer.currency.toUpperCase() !== seller.currency.toUpperCase() || !sameUnits,
  };
}

/** The one move the card offers next, its button and what it needs. Declined and Lost sit in the stage menu with a reason. */
export type NextStep = { to: OfferStage; label: string; needs: string };

export const NEXT_STEP: Partial<Record<OfferStage, NextStep>> = {
  candidate: { to: "offered", label: "Draft email", needs: "Sending it marks the offer Offered." },
  offered: { to: "negotiating", label: "They replied", needs: "Moves it to Negotiating." },
  negotiating: { to: "contract_out", label: "Contract sent", needs: "A buyer price, a quantity and a valid-until date." },
  contract_out: { to: "signed", label: "Mark signed", needs: "The signed contract, kept in Documents." },
  signed: { to: "invoiced", label: "Invoice sent", needs: "The invoice, kept in Documents." },
  invoiced: { to: "paid", label: "Mark paid", needs: "The paid date, amount, currency, quantity and our take." },
  paid: { to: "complete", label: "Mark complete", needs: "Delivered. Closes the request and the supply listing." },
};

/** What still stops the next step, in plain words; empty when it can go. Paid facts are asked for by their own form. */
export function stepGaps(to: OfferStage, offer: { terms: { amount?: number; currency?: string; expires_on?: string } | null; quantity: number | null }): string[] {
  if (to !== "contract_out" && to !== "signed" && to !== "invoiced") {
    return [];
  }
  return [
    offer.terms?.amount == null || !offer.terms.currency ? "buyer price" : null,
    offer.quantity == null ? "quantity" : null,
    !offer.terms?.expires_on ? "valid-until date" : null,
  ].filter((gap): gap is string => !!gap);
}

/**
 * The facts an offer email and its price sheet are built from: price, unit, currency, quantity, delivery terms and the
 * last day. A draft is stored with this key; when the offer's key differs, the draft is out of date and is not sent.
 */
export function offerTermsKey(
  terms: { amount?: number; unit?: string; currency?: string; delivery_terms?: string; expires_on?: string } | null | undefined,
  quantity: number | null | undefined,
): string {
  const text = (value: string | undefined) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return JSON.stringify([terms?.amount ?? null, text(terms?.unit), text(terms?.currency)?.toUpperCase() ?? null, quantity ?? null,
    text(terms?.delivery_terms), text(terms?.expires_on)?.slice(0, 10) ?? null]);
}

/** The terms key a draft of this offer was built from (offer data.draft_terms), or null when it was made before keys were kept. */
export function draftTermsKey(data: Record<string, unknown> | null | undefined, draftId: string): string | null {
  const keys = data?.draft_terms;
  const key = keys && typeof keys === "object" ? (keys as Record<string, unknown>)[draftId] : null;
  return typeof key === "string" ? key : null;
}
