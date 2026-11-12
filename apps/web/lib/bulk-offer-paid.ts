// What an offer must record before it can be marked paid: when it was paid, what was paid and in which currency, how
// much was sold, and our take in pounds. The OKR page counts bulk take from these. Safe for client and server.

/** The offer stages that mean the money is in. Moving an offer to either needs every paid fact. */
export const PAID_STAGES = ["paid", "complete"] as const;

/** The paid facts as stored on crm_bulk_offers (migration 116). quantity is in the price unit (terms.unit). */
export type PaidFacts = {
  paid_on: string | null;
  paid_amount: number | null;
  paid_currency: string | null;
  quantity: number | null;
  take_gbp: number | null;
};

export const PAID_CURRENCIES = ["GBP", "EUR", "USD"] as const;

/** Plain names for the error message and the form, in the order the form asks for them. */
export const PAID_FACT_LABEL: Record<keyof PaidFacts, string> = {
  paid_on: "paid date", paid_amount: "amount paid", paid_currency: "currency", quantity: "quantity", take_gbp: "take in GBP",
};

export function isPaidStage(stage: string | null | undefined): boolean {
  return (PAID_STAGES as readonly (string | null | undefined)[]).includes(stage);
}

/** The paid facts still missing for an offer at `stage`; empty when the stage needs none or all are there. */
export function missingPaidFacts(stage: string | null | undefined, facts: Partial<PaidFacts>): (keyof PaidFacts)[] {
  if (!isPaidStage(stage)) return [];
  return (Object.keys(PAID_FACT_LABEL) as (keyof PaidFacts)[]).filter((key) => {
    const value = facts[key];
    return value === null || value === undefined || (typeof value === "string" && !value.trim());
  });
}

/** "To mark this offer Paid, add the paid date and take in GBP." */
export function missingPaidMessage(stage: string, missing: (keyof PaidFacts)[]): string {
  const names = missing.map((key) => PAID_FACT_LABEL[key]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `To mark this offer ${stage === "complete" ? "Complete" : "Paid"}, add the ${list}.`;
}

/** Request keys for the paid facts, and the column each sets. */
const PAID_KEYS = { paidOn: "paid_on", paidAmount: "paid_amount", paidCurrency: "paid_currency", quantity: "quantity", takeGbp: "take_gbp" } as const satisfies Record<string, keyof PaidFacts>;

/** Reads the paid facts in a PATCH body; a string is the error to return. Only keys present are set; null clears one. */
export function readPaidFacts(body: Record<string, unknown>): Partial<PaidFacts> | string {
  const paid: Partial<PaidFacts> = {};
  for (const [key, column] of Object.entries(PAID_KEYS) as [keyof typeof PAID_KEYS, keyof PaidFacts][]) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value === null || value === "") { (paid as Record<string, unknown>)[column] = null; continue; }
    if (column === "paid_on") {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Use a paid date like 2026-10-30.";
      paid.paid_on = value;
    } else if (column === "paid_currency") {
      if (typeof value !== "string" || !(PAID_CURRENCIES as readonly string[]).includes(value.toUpperCase())) return `Currency must be ${PAID_CURRENCIES.join(", ")}.`;
      paid.paid_currency = value.toUpperCase();
    } else {
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (column === "quantity" && n === 0)) {
        return column === "quantity" ? "Quantity must be a number above 0." : `${column === "take_gbp" ? "Take in GBP" : "Amount paid"} must be a number, 0 or more.`;
      }
      paid[column] = n;
    }
  }
  return paid;
}
