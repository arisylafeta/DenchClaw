/** Pure helpers shared by the Transactions page and its server actions. */

export const DASHBOARD_URL = "https://www.rebattery.io/buyer/dashboard";

export type TransactionRow = {
  id: string;
  number: string;
  createdAt: string;
  status: string;
  workflowStep: string;
  sourceType: string;
  quantity: number;
  amount: number;
  currency: string;
  listingId: string;
  listingTitle: string | null;
  listingReference: string | null;
  buyerName: string | null;
  sellerName: string | null;
  paymentStatus: string | null;
  payoutStatus: string | null;
  fundedAmount: number | null;
  refundedAmount: number | null;
  paidOutAmount: number | null;
  paymentIntentRef: string | null;
  canRefund: boolean;
  refundBlocker: string | null;
};

/** Human transaction number: first 8 characters of the deal id, upper case. */
export function transactionNumber(dealId: string): string {
  return dealId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function firstName(fullName: string | null | undefined): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first || "there";
}

/** Why a deal cannot be refunded from this page, or null when it can. The database function re-checks every rule. */
export function refundBlocker(input: {
  status: string;
  paymentStatus: string | null;
  payoutStatus: string | null;
  fundedAmount: number | null;
  refundedAmount: number | null;
  paidOutAmount: number | null;
  paymentIntentRef: string | null;
}): string | null {
  if (input.status === "cancelled") return "Already cancelled";
  if (input.status !== "open") return "Deal is not open";
  if (!input.paymentIntentRef || input.fundedAmount == null || input.fundedAmount <= 0) return "No captured payment";
  if ((input.refundedAmount ?? 0) !== 0) return "Already refunded";
  if ((input.paidOutAmount ?? 0) !== 0) return "Seller already paid";
  if (["creating", "processing", "posted", "legacy_transferred"].includes(input.payoutStatus ?? "")) {
    return "Payout started";
  }
  if (input.paymentStatus !== "funds_held" && input.paymentStatus !== "processing") return "Payment not held";
  return null;
}
