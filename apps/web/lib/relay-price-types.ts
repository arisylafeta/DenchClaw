/** Shared shapes for Relay's prices and the stock that fits an email. relay-price.ts fills them; the chat, the drafts and
 * the workspace read them. */

/** One pack or lot that fits what the person asked for. Supplier details never go in an email to a buyer. */
export type StockFit = {
  /** Stable for the same stock across reads: "stock:<crm_stock_opportunities id>" or "market:<marketplace listing id>". */
  key: string;
  /** What the buyer would read: "VW ID.3 62 kWh, 2020". */
  label: string;
  kind: "supplier" | "marketplace";
  supplier: { name: string; country: string | null; email: string | null };
  kwh: number | null;
  year: number | null;
  /** State of health in percent, when a report gives it. */
  soh: number | null;
  /** What the supplier wants (supplier stock), or the marketplace price, which already holds our commission. */
  cost: Money | null;
  listed: Money | null;
  /** A CRM or marketplace link for Alex, never for the email. */
  href: string | null;
};

export type Money = { amount: number; currency: "GBP" | "EUR" | "USD" };

/** Relay's price for one offered line, or Alex's once he changes or accepts it. */
export type PriceFill = {
  /** The StockFit key this prices. */
  key: string;
  label: string;
  /** Whole pounds; null when Relay has nothing to work from, which leaves the gap open and blocks sending. */
  value: number | null;
  /** "collected" until delivery rates exist: a delivered price needs a quote from the transport partner. */
  basis: "collected" | "delivered";
  /** The lines shown beside the field, in order: cost, exchange rate, margin, delivery, Penny's range. */
  working: string[];
  /** Below cost, outside Penny's range, an old exchange rate. Shown, never blocking. */
  warnings: string[];
  needsDeliveryQuote: boolean;
  by: "relay" | "alex";
  /** Optional: the cost in whole pounds (the listed price for marketplace stock), so a value Alex types is checked against it. */
  floor?: number | null;
  /** Optional: Penny's quick to patient price for the pack in whole pounds, so a value Alex types is checked against it. */
  pennyRange?: { low: number; high: number } | null;
};
