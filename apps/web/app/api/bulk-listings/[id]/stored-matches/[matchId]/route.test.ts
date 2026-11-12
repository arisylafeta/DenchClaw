import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), ask: vi.fn(), yes: vi.fn(), no: vi.fn(), extend: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user, ALLOWED_EMAILS: new Set(["alex@rebattery.io"]) }));
vi.mock("@/lib/crm-postgres/bulk-matches", async () => {
  class MatchError extends Error { constructor(readonly status: number, message: string) { super(message); } }
  return {
    MatchError,
    matchFailure: (error: unknown) => {
      if (error instanceof MatchError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    },
    askMatch: mocks.ask, matchYes: mocks.yes, matchNo: mocks.no, extendReservation: mocks.extend, releaseReservation: mocks.release,
  };
});
import { POST } from "./route";

const context = { params: Promise.resolve({ id: "btd_1", matchId: "bmt_1" }) };
const post = (body: unknown) => new Request("http://localhost/stored-matches/bmt_1", { method: "POST", body: JSON.stringify(body) });

describe("stored match actions", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user", email: "alex@rebattery.io" });
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });

  it("refuses a no without a reason, before anything is written", async () => {
    for (const reason of [undefined, "", "   "]) {
      const response = await POST(post({ action: "no", reason }), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Say briefly why it is a no." });
    }
    expect(mocks.no).not.toHaveBeenCalled();
  });

  it("lets only Ari or Alex create an ask draft, and never sends", async () => {
    mocks.user.mockResolvedValue({ id: "user", email: "someone@rebattery.io" });
    expect((await POST(post({ action: "ask" }), context)).status).toBe(403);
    expect(mocks.ask).not.toHaveBeenCalled();
    mocks.user.mockResolvedValue({ id: "user", email: "alex@rebattery.io" });
    mocks.ask.mockResolvedValue({ draftId: "d1", kind: "stock_confirm", subject: "s", body: "b", reused: false });
    const response = await POST(post({ action: "ask" }), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ draftId: "d1" });
  });

  it("checks a yes's quantity and quote shape, and passes the refusal of a full lot through as a 409", async () => {
    expect((await POST(post({ action: "yes", quantity: -1 }), context)).status).toBe(400);
    expect((await POST(post({ action: "yes", quote: { amount: 10, currency: "JPY", unit: "unit" } }), context)).status).toBe(400);
    const { MatchError } = await import("@/lib/crm-postgres/bulk-matches") as unknown as { MatchError: new (s: number, m: string) => Error };
    mocks.yes.mockRejectedValue(new MatchError(409, "This candidate is fully reserved for another deal, so it was not confirmed."));
    const response = await POST(post({ action: "yes", quantity: "4", validUntil: "2026-12-01" }), context);
    expect(response.status).toBe(409);
    expect(mocks.yes).toHaveBeenCalledWith("btd_1", "bmt_1", { quantity: 4, quote: null, validUntil: "2026-12-01" }, { userId: "user", email: "alex@rebattery.io" });
  });
});
