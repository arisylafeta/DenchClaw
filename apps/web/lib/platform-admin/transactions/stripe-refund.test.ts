import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { refundChargeInFull, StripeRefundError } from "./stripe-refund";

const input = { chargeId: "ch_1", amountMinor: 208000, currency: "gbp", dealId: "deal-1" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("refundChargeInFull", () => {
  it("creates one refund with an idempotency key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return String(url).includes("?charge=")
        ? json({ data: [] })
        : json({ id: "re_1", amount: 208000, currency: "gbp", status: "succeeded", created: 1 });
    }) as unknown as typeof fetch;
    const refund = await refundChargeInFull(input, { secretKey: "rk_test", fetcher });
    expect(refund.id).toBe("re_1");
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect((post.init!.headers as Record<string, string>)["Idempotency-Key"]).toBe("rebattery-admin-refund-deal-1");
    expect(String(post.init!.body)).toContain("amount=208000");
    expect(String(post.init!.body)).toContain("reason=requested_by_customer");
  });

  it("reuses a succeeded full refund instead of refunding twice", async () => {
    const fetcher = vi.fn(async () => json({ data: [{ id: "re_old", amount: 208000, currency: "gbp", status: "succeeded", created: 1 }] })) as unknown as typeof fetch;
    const refund = await refundChargeInFull(input, { secretKey: "rk_test", fetcher });
    expect(refund.id).toBe("re_old");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses when the charge already has a partial refund", async () => {
    const fetcher = vi.fn(async () => json({ data: [{ id: "re_part", amount: 1000, currency: "gbp", status: "succeeded", created: 1 }] })) as unknown as typeof fetch;
    await expect(refundChargeInFull(input, { secretKey: "rk_test", fetcher })).rejects.toThrow(/partial or different/);
  });

  it("surfaces Stripe errors and non-succeeded status", async () => {
    const denied = vi.fn(async (url: RequestInfo | URL) => String(url).includes("?charge=") ? json({ data: [] }) : json({ error: { message: "Permission denied", code: "more_permissions_required" } }, 403)) as unknown as typeof fetch;
    await expect(refundChargeInFull(input, { secretKey: "rk_test", fetcher: denied })).rejects.toBeInstanceOf(StripeRefundError);
    const pending = vi.fn(async (url: RequestInfo | URL) => String(url).includes("?charge=") ? json({ data: [] }) : json({ id: "re_2", amount: 208000, currency: "gbp", status: "pending", created: 1 })) as unknown as typeof fetch;
    await expect(refundChargeInFull(input, { secretKey: "rk_test", fetcher: pending })).rejects.toThrow(/pending/);
  });
});
