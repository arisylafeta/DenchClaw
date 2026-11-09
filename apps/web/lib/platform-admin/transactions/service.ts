import { transactionNumber, formatMoney, firstName, refundBlocker } from "./contract";

export type DealForRefund = {
  id: string;
  status: string;
  workflowStep: string;
  currency: string;
  listingTitle: string;
  listingReference: string | null;
  fundedAmount: number | null;
  refundedAmount: number | null;
  paidOutAmount: number | null;
  paymentStatus: string | null;
  payoutStatus: string | null;
  chargeId: string | null;
  paymentIntentRef: string | null;
  buyer: { email: string | null; name: string | null };
  seller: { email: string | null; name: string | null };
};

export type RefundResult = { id: string; amount: number; currency: string; created: number };
export type FinalizeResult =
  | { outcome: "cancelled" | "already_cancelled"; restoredQuantity?: number }
  | { outcome: "not_eligible"; blocker: string };

export type EmailOutcome = { sent: boolean; skipped?: string; error?: string; messageId?: string };

export type RefundDeps = {
  loadDeal: (dealId: string) => Promise<DealForRefund | null>;
  refundCharge: (input: { chargeId: string; amountMinor: number; currency: string; dealId: string }) => Promise<RefundResult>;
  finalize: (input: { dealId: string; refund: RefundResult; actorEmail: string; reason: string }) => Promise<FinalizeResult>;
  sendBuyer: (to: string, model: { firstName: string; listingTitle: string; tagNumber: string | null; amount: string }) => Promise<{ success: boolean; messageId?: string; detail?: string }>;
  sendSeller: (to: string, model: { firstName: string; number: string; listingTitle: string }) => Promise<{ success: boolean; messageId?: string; detail?: string }>;
  audit: (dealId: string, action: string, payload: Record<string, unknown>) => Promise<void>;
};

export type RefundAndCancelResult =
  | {
      ok: true;
      number: string;
      refundId: string;
      alreadyCancelled: boolean;
      buyerEmail: EmailOutcome;
      sellerEmail: EmailOutcome;
    }
  | { ok: false; stage: "validate" | "stripe" | "database"; error: string; refundId?: string };

async function emailOutcome(
  address: string | null,
  send: (to: string) => Promise<{ success: boolean; messageId?: string; detail?: string }>,
): Promise<EmailOutcome> {
  if (!address) return { sent: false, skipped: "No email address on the account" };
  try {
    const result = await send(address);
    return result.success ? { sent: true, messageId: result.messageId } : { sent: false, error: result.detail ?? "Send failed" };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendCancellationEmails(deps: RefundDeps, deal: DealForRefund) {
  const number = transactionNumber(deal.id);
  const amount = formatMoney(deal.fundedAmount ?? 0, deal.currency);
  const buyerEmail = await emailOutcome(deal.buyer.email, (to) =>
    deps.sendBuyer(to, { firstName: firstName(deal.buyer.name), listingTitle: deal.listingTitle, tagNumber: deal.listingReference, amount }),
  );
  const sellerEmail = await emailOutcome(deal.seller.email, (to) =>
    deps.sendSeller(to, { firstName: firstName(deal.seller.name), number, listingTitle: deal.listingTitle }),
  );
  await deps.audit(deal.id, "deal_cancellation_emails", { buyer: buyerEmail, seller: sellerEmail });
  return { buyerEmail, sellerEmail };
}

/**
 * 1 Stripe refund (reused if already made), 2 one database transaction, 3 buyer email, 4 seller email.
 * Each step is safe to retry. Emails never roll the refund back.
 */
export async function refundAndCancelDeal(
  deps: RefundDeps,
  input: { dealId: string; confirmation: string; actorEmail: string; reason?: string },
): Promise<RefundAndCancelResult> {
  const deal = await deps.loadDeal(input.dealId);
  if (!deal) return { ok: false, stage: "validate", error: "Transaction not found" };
  const number = transactionNumber(deal.id);
  if (input.confirmation.trim().replace(/^#/, "").toUpperCase() !== number) {
    return { ok: false, stage: "validate", error: `Type ${number} to confirm` };
  }
  if (deal.status === "cancelled") {
    return { ok: false, stage: "validate", error: "Already cancelled" };
  }
  const blocker = refundBlocker({
    status: deal.status,
    paymentStatus: deal.paymentStatus,
    payoutStatus: deal.payoutStatus,
    fundedAmount: deal.fundedAmount,
    refundedAmount: deal.refundedAmount,
    paidOutAmount: deal.paidOutAmount,
    paymentIntentRef: deal.paymentIntentRef,
  });
  if (blocker) return { ok: false, stage: "validate", error: blocker };
  if (!deal.chargeId || deal.fundedAmount == null) {
    return { ok: false, stage: "validate", error: "No Stripe charge recorded for this payment" };
  }
  const amountMinor = Math.round(deal.fundedAmount * 100);
  const reason = (input.reason ?? "").trim() || "Refunded and cancelled by ReBattery admin";

  let refund: RefundResult;
  try {
    refund = await deps.refundCharge({ chargeId: deal.chargeId, amountMinor, currency: deal.currency, dealId: deal.id });
  } catch (error) {
    return { ok: false, stage: "stripe", error: error instanceof Error ? error.message : String(error) };
  }

  let finalized: FinalizeResult;
  try {
    finalized = await deps.finalize({ dealId: deal.id, refund, actorEmail: input.actorEmail, reason });
  } catch (error) {
    return {
      ok: false,
      stage: "database",
      refundId: refund.id,
      error: `Refund ${refund.id} succeeded at Stripe but the database step failed: ${error instanceof Error ? error.message : String(error)}. Retry to finish the cancellation.`,
    };
  }
  if (finalized.outcome === "not_eligible") {
    return {
      ok: false,
      stage: "database",
      refundId: refund.id,
      error: `Refund ${refund.id} succeeded at Stripe but the deal could not be cancelled (${finalized.blocker}). Resolve it manually.`,
    };
  }

  const alreadyCancelled = finalized.outcome === "already_cancelled";
  await deps.audit(deal.id, "deal_refund_issued_via_dench", { stripe_refund_id: refund.id, actor: input.actorEmail, amount_minor: refund.amount });
  if (alreadyCancelled) {
    return { ok: true, number, refundId: refund.id, alreadyCancelled, buyerEmail: { sent: false, skipped: "Already cancelled earlier" }, sellerEmail: { sent: false, skipped: "Already cancelled earlier" } };
  }
  const { buyerEmail, sellerEmail } = await sendCancellationEmails(deps, deal);
  return { ok: true, number, refundId: refund.id, alreadyCancelled, buyerEmail, sellerEmail };
}
