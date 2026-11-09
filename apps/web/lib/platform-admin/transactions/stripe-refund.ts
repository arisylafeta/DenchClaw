import "server-only";

import { getStripeRefundEnv } from "@/lib/platform-admin/env";
import { fetchWithTimeout } from "@/lib/platform-admin/network";

export type StripeRefund = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  created: number;
};

export class StripeRefundError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number) {
    super(message);
    this.name = "StripeRefundError";
  }
}

async function stripe<T>(
  fetcher: typeof fetch,
  secretKey: string,
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetcher(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
  if (!response.ok) {
    throw new StripeRefundError(body.error?.message ?? `Stripe returned ${response.status}`, body.error?.code ?? null, response.status);
  }
  return body;
}

/**
 * Refund the whole charge, once. A succeeded full refund that already exists is reused, so a retry after a
 * database failure never refunds twice. The idempotency key stops concurrent double submits.
 */
export async function refundChargeInFull(
  input: { chargeId: string; amountMinor: number; currency: string; dealId: string },
  deps: { secretKey?: string; fetcher?: typeof fetch } = {},
): Promise<StripeRefund> {
  const secretKey = deps.secretKey ?? getStripeRefundEnv().secretKey;
  const fetcher = deps.fetcher ?? ((url, init) => fetchWithTimeout(String(url), init));

  const existing = await stripe<{ data: StripeRefund[] }>(
    fetcher, secretKey, "GET", `/v1/refunds?charge=${encodeURIComponent(input.chargeId)}&limit=20`,
  );
  const alreadyRefunded = existing.data.filter((refund) => refund.status === "succeeded");
  const alreadyAmount = alreadyRefunded.reduce((sum, refund) => sum + refund.amount, 0);
  if (alreadyAmount > 0) {
    const full = alreadyRefunded.find((refund) => refund.amount === input.amountMinor);
    if (full && alreadyAmount === input.amountMinor && full.currency.toLowerCase() === input.currency.toLowerCase()) return full;
    throw new StripeRefundError("This charge already has a partial or different refund. Resolve it in Stripe first.", "refund_mismatch", 409);
  }

  const charge = await stripe<{ amount: number; amount_captured?: number; currency: string; refunded: boolean; amount_refunded: number }>(
    fetcher, secretKey, "GET", `/v1/charges/${encodeURIComponent(input.chargeId)}`,
  );
  const captured = charge.amount_captured ?? charge.amount;
  if (charge.currency.toLowerCase() !== input.currency.toLowerCase() || captured !== input.amountMinor) {
    throw new StripeRefundError(
      `The Stripe charge (${(captured / 100).toFixed(2)} ${charge.currency.toUpperCase()}) does not match the settlement (${(input.amountMinor / 100).toFixed(2)} ${input.currency.toUpperCase()}). Refund it in Stripe.`,
      "charge_mismatch",
      409,
    );
  }

  const refund = await stripe<StripeRefund>(
    fetcher, secretKey, "POST", "/v1/refunds",
    {
      charge: input.chargeId,
      amount: String(input.amountMinor),
      reason: "requested_by_customer",
      "metadata[deal_id]": input.dealId,
      "metadata[source]": "dench_transactions_page",
    },
    // Ten-minute bucket: concurrent double submits collapse into one request, while a genuine retry after a
    // failed attempt is not stuck behind Stripe's 24h replay of the earlier error. Existing refunds are checked above.
    `rebattery-admin-refund-${input.dealId}-${Math.floor(Date.now() / 600_000)}`,
  );
  if (refund.status !== "succeeded") {
    throw new StripeRefundError(`Stripe accepted the refund but its status is "${refund.status}". Check it in Stripe, then retry.`, "refund_not_succeeded", 202);
  }
  return refund;
}
