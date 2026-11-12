// The CRM is the price of record. A supply listing that also sells through a marketplace listing
// (crm_bulk_listings.marketplace_listing_id) should show the same price in both places; on 9 Nov a marketplace listing
// showed about £662 where the CRM held £2,400. This compares the two and words the flag. Safe for client and server.
//
// Where the marketplace price comes from is injected (MarketplacePriceSource). There is no local mirror of a deal's
// marketplace price: the daily stock sync skips bundle listings, which is what a deal's marketplace listing is, and it
// writes crm_stock_opportunities.price only when it first adds a row. Nothing here calls the marketplace.
import { EUR_PER } from "./demand-match";
import { priceUnit, type PriceUnit } from "./bulk-offer-close";

export type ListedPrice = { amount: number; currency: string; unit: string | null };

/** Reads one marketplace listing's current price from wherever it is kept. Null when it is not known. */
export type MarketplacePriceSource = (marketplaceListingId: string) => Promise<ListedPrice | null>;

/** More than this share apart and the card says so. */
export const PRICE_TOLERANCE = 0.02;

const SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };

/** "£2,400", "€40.50", "PLN 300". */
export function moneyText(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const figure = amount.toLocaleString("en-GB", { maximumFractionDigits: amount < 100 && !Number.isInteger(amount) ? 2 : 0 });
  return SYMBOL[code] ? `${SYMBOL[code]}${figure}` : `${code} ${figure}`;
}

export type PriceCheck =
  | { state: "match" | "differs"; crm: ListedPrice; market: ListedPrice; gap: number; flag: string | null }
  | { state: "unknown"; why: string; flag: null };

const toKwh = (amount: number, unit: PriceUnit, kwhPerUnit: number | null) =>
  unit === "kwh" ? amount : unit === "mwh" ? amount / 1000 : kwhPerUnit ? amount / kwhPerUnit : null;

/**
 * Compares the CRM's price with the marketplace's, in the CRM's currency and unit. When the units differ, kWh per unit
 * (a single-product lot) converts them; when that is unknown the check says so rather than guessing. A gap above 2% gives
 * the flag: "Marketplace shows £662, CRM has £2,400."
 */
export function comparePrices(crm: ListedPrice | null, market: ListedPrice | null, kwhPerUnit: number | null = null): PriceCheck {
  if (!crm) {
    return { state: "unknown", why: "The CRM has no price for this listing.", flag: null };
  }
  if (!market) {
    return { state: "unknown", why: "The marketplace price is not known here.", flag: null };
  }
  const crmRate = EUR_PER[crm.currency.toUpperCase()];
  const marketRate = EUR_PER[market.currency.toUpperCase()];
  if (crmRate == null || marketRate == null) {
    return { state: "unknown", why: "One of the prices is in a currency without a rate.", flag: null };
  }
  const crmUnit = priceUnit(crm.unit) ?? "unit";
  const marketUnit = priceUnit(market.unit) ?? "unit";
  let marketAmount = market.amount;
  if (crmUnit !== marketUnit) {
    const perKwh = toKwh(market.amount, marketUnit, kwhPerUnit);
    const back = perKwh == null ? null : crmUnit === "kwh" ? perKwh : crmUnit === "mwh" ? perKwh * 1000 : kwhPerUnit ? perKwh * kwhPerUnit : null;
    if (back == null) {
      return { state: "unknown", why: "The two prices are per different units and the kWh per unit is not known.", flag: null };
    }
    marketAmount = back;
  }
  const inCrmCurrency = (marketAmount * marketRate) / crmRate;
  const gap = crm.amount ? Math.abs(inCrmCurrency - crm.amount) / crm.amount : inCrmCurrency ? 1 : 0;
  const differs = gap > PRICE_TOLERANCE;
  return {
    state: differs ? "differs" : "match", crm, market, gap,
    flag: differs ? `Marketplace shows ${moneyText(market.amount, market.currency)}, CRM has ${moneyText(crm.amount, crm.currency)}.` : null,
  };
}
