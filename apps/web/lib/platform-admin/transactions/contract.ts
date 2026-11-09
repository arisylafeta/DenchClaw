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
export type RefundFacts = {
  status: string;
  paymentStatus: string | null;
  payoutStatus: string | null;
  fundedAmount: number | null;
  refundedAmount: number | null;
  paidOutAmount: number | null;
  paymentIntentRef: string | null;
  /** Mirrors the database function's own checks so money never moves for a deal it will refuse to cancel. */
  dealQuantity?: number | null;
  listingKind?: string | null;
  specsQuantity?: number | null;
  specsAvailable?: number | null;
  payoutRows?: number;
  capturedPayments?: number;
};

/**
 * Why a deal cannot be refunded from this page, or null when it can. Mirrors every `not_eligible` branch of
 * `admin_cancel_refunded_deal`. An open deal whose settlement is already fully refunded (the webhook beat us, or a
 * previous attempt failed after Stripe) is allowed: the action then only finishes the cancellation.
 */
export function refundBlocker(input: RefundFacts): string | null {
  if (input.status === "cancelled") return "Already cancelled";
  if (input.status !== "open") return "Deal is not open";
  if (!input.paymentIntentRef || input.fundedAmount == null || input.fundedAmount <= 0) return "No captured payment";
  const refunded = input.refundedAmount ?? 0;
  if (refunded !== 0 && refunded !== input.fundedAmount) return "Partly refunded: resolve in Stripe";
  if ((input.paidOutAmount ?? 0) !== 0) return "Seller already paid";
  if (["creating", "processing", "posted", "legacy_transferred"].includes(input.payoutStatus ?? "")) {
    return "Payout started";
  }
  if ((input.payoutRows ?? 0) > 0) return "Payout started";
  if (refunded === 0 && input.paymentStatus !== "funds_held") return "Payment not held";
  if ((input.capturedPayments ?? 1) !== 1) return "More than one payment: refund in Stripe";
  if (input.listingKind === "group") return "Group listing: cancel manually";
  if (input.dealQuantity != null && input.dealQuantity <= 0) return "No stock reservation recorded";
  if (
    input.specsQuantity != null && input.specsAvailable != null && input.dealQuantity != null &&
    input.specsAvailable + input.dealQuantity > input.specsQuantity
  ) {
    return "Stock would exceed the listing total";
  }
  return null;
}
