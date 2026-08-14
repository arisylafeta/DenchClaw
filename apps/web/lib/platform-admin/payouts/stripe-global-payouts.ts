import "server-only";

import { getStripeGlobalPayoutsEnv } from "@/lib/platform-admin/env";
import { normalisePayoutReviewContext } from "./cop";

export const STRIPE_GLOBAL_PAYOUTS_API_VERSION = "2026-06-24.preview";
const STRIPE_V2_BASE_URL = "https://api.stripe.com/v2";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export class StripeGlobalPayoutsAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "StripeGlobalPayoutsAdminError";
  }
}

export class StripeGlobalPayoutsAdminClient {
  constructor(
    private readonly secretKey = getStripeGlobalPayoutsEnv().secretKey,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(
    path: string,
    input: {
      method?: "GET" | "POST";
      stripeContext?: string;
      idempotencyKey?: string;
      body?: JsonObject;
    } = {},
  ): Promise<{ payload: JsonObject; requestId: string | null }> {
    const response = await this.fetcher(`${STRIPE_V2_BASE_URL}${path}`, {
      method: input.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
        "Stripe-Version": STRIPE_GLOBAL_PAYOUTS_API_VERSION,
        ...(input.stripeContext
          ? { "Stripe-Context": input.stripeContext }
          : {}),
        ...(input.idempotencyKey
          ? { "Idempotency-Key": input.idempotencyKey }
          : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => ({}))) as JsonObject;
    const requestId = response.headers.get("request-id");
    if (!response.ok) {
      const error = asObject(payload.error);
      throw new StripeGlobalPayoutsAdminError(
        asString(error.message) ?? "Stripe Global Payouts request failed",
        response.status,
        asString(error.code),
        requestId,
      );
    }
    return { payload, requestId };
  }

  async retrieveReviewContext(input: {
    recipientId: string;
    payoutMethodId: string;
  }) {
    const query = new URLSearchParams();
    ["configuration.recipient", "requirements"].forEach((value, index) => {
      query.append(`include[${index}]`, value);
    });
    const account = await this.request(
      `/core/accounts/${encodeURIComponent(input.recipientId)}?${query.toString()}`,
    );
    const bankAccount = await this.request(
      `/core/vault/gb_bank_accounts/${encodeURIComponent(input.payoutMethodId)}`,
      { stripeContext: input.recipientId },
    );

    return {
      ...normalisePayoutReviewContext(account.payload, bankAccount.payload),
      requestId: bankAccount.requestId,
    };
  }

  async acknowledgeConfirmationOfPayee(input: {
    recipientId: string;
    payoutMethodId: string;
    idempotencyKey: string;
  }) {
    const result = await this.request(
      `/core/vault/gb_bank_accounts/${encodeURIComponent(input.payoutMethodId)}/acknowledge_confirmation_of_payee`,
      {
        method: "POST",
        stripeContext: input.recipientId,
        idempotencyKey: input.idempotencyKey,
        body: {},
      },
    );
    const context = normalisePayoutReviewContext(
      {
        id: input.recipientId,
        configuration: {
          recipient: {
            default_outbound_destination: {
              id: input.payoutMethodId,
              type: "gb_bank_account",
            },
          },
        },
      },
      result.payload,
    );
    if (context.confirmationOfPayeeStatus !== "confirmed") {
      throw new Error("Stripe did not confirm Confirmation of Payee");
    }
    return { ...context, requestId: result.requestId };
  }
}

let defaultClient: StripeGlobalPayoutsAdminClient | null = null;

export function getStripeGlobalPayoutsAdminClient() {
  if (!defaultClient) defaultClient = new StripeGlobalPayoutsAdminClient();
  return defaultClient;
}
