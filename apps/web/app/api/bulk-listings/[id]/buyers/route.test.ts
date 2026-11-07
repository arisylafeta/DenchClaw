import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), query: vi.fn(), buyers: vi.fn(), verdict: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/postgres", () => ({ queryPg: mocks.query }));
vi.mock("@/lib/crm-postgres/supply-buyers", () => ({ supplyBuyers: mocks.buyers }));
vi.mock("@/lib/crm-postgres/supply-matches", () => ({ REASON_MAX: 200, recordSupplyVerdict: mocks.verdict }));
vi.mock("@/lib/crm-postgres/demand-match-supply", () => ({ verdictKey: { demand: (id: string) => `demand:${id}`, company: (id: string) => `company:${id}` } }));
vi.mock("@/lib/crm-postgres/bulk-offers", () => ({ addOffer: vi.fn(), OfferConflict: class OfferConflict extends Error {} }));
import { POST } from "./route";

const context = { params: Promise.resolve({ id: "bts_1" }) };
const post = (body: unknown) => new Request("http://localhost/buyers", { method: "POST", body: JSON.stringify(body) });

describe("supply buyers verdict route", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user", email: "user@test" });
    mocks.query.mockResolvedValue([{ id: "co_1", name: "Acme Batteries" }]);
    mocks.buyers.mockResolvedValue({ suggestions: [], notAFit: 0, notAFitReasons: [] });
    mocks.verdict.mockResolvedValue({ id: "42" });
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });

  it("refuses Not a fit on a company without a reason", async () => {
    for (const reason of [undefined, "", "   "]) {
      const response = await POST(post({ companyId: "co_1", verdict: "not_a_fit", reason }), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Say briefly why this company is not a fit." });
    }
    expect(mocks.verdict).not.toHaveBeenCalled();
  });

  it("records a Not a fit with its reason, and a Clear without one", async () => {
    expect((await POST(post({ companyId: "co_1", verdict: "not_a_fit", reason: " Buys only packs " }), context)).status).toBe(201);
    expect(mocks.verdict).toHaveBeenLastCalledWith("bts_1", expect.objectContaining({ key: "company:co_1", verdict: "not_a_fit", reason: "Buys only packs", label: "Acme Batteries" }), "user");
    expect((await POST(post({ companyId: "co_1", verdict: "clear" }), context)).status).toBe(201);
    expect(mocks.verdict).toHaveBeenLastCalledWith("bts_1", expect.objectContaining({ verdict: "clear", reason: "" }), "user");
  });

  it("refuses an unknown verdict or a reason that is not text", async () => {
    for (const body of [{ companyId: "co_1", verdict: "maybe" }, { companyId: "co_1", verdict: "shortlist", reason: 3 },
      { companyId: "co_1", verdict: "not_a_fit", reason: "x".repeat(201) }]) {
      expect((await POST(post(body), context)).status).toBe(400);
    }
    expect(mocks.verdict).not.toHaveBeenCalled();
  });
});
