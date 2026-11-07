import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), demand: vi.fn(), matches: vi.fn(), verdict: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/crm-postgres/bulk-demand", () => ({ getDemand: mocks.demand }));
vi.mock("@/lib/crm-postgres/supply-matches", () => ({ REASON_MAX: 200, supplyMatches: mocks.matches, recordSupplyVerdict: mocks.verdict }));
vi.mock("@/lib/crm-postgres/demand-match-supply", () => ({ verdictKey: { demand: (id: string) => `demand:${id}`, company: (id: string) => `company:${id}` } }));
import { POST } from "./route";

const context = { params: Promise.resolve({ id: "bts_1" }) };
const post = (body: unknown) => new Request("http://localhost/matches", { method: "POST", body: JSON.stringify(body) });

describe("supply matches verdict route", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user", email: "user@test" });
    mocks.demand.mockResolvedValue({ id: "btd_1", buyer: "Cell Buyer" });
    mocks.matches.mockResolvedValue({ matches: [], notAFit: 0, notAFitReasons: [], blocked: null });
    mocks.verdict.mockResolvedValue({ id: "42" });
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });

  it("refuses Not a fit without a reason, before it reads or writes anything", async () => {
    for (const reason of [undefined, "", "   "]) {
      const response = await POST(post({ demandId: "btd_1", verdict: "not_a_fit", reason }), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Say briefly why it is not a fit." });
    }
    expect(mocks.verdict).not.toHaveBeenCalled();
  });

  it("records a Not a fit with its reason, and a Clear without one", async () => {
    expect((await POST(post({ demandId: "btd_1", verdict: "not_a_fit", reason: " Only buys packs " }), context)).status).toBe(201);
    expect(mocks.verdict).toHaveBeenLastCalledWith("bts_1", expect.objectContaining({ key: "demand:btd_1", verdict: "not_a_fit", reason: "Only buys packs" }), "user");
    expect((await POST(post({ demandId: "btd_1", verdict: "clear" }), context)).status).toBe(201);
    expect(mocks.verdict).toHaveBeenLastCalledWith("bts_1", expect.objectContaining({ verdict: "clear", reason: "" }), "user");
  });

  it("refuses a bad verdict or a reason that is not text", async () => {
    for (const body of [{ demandId: "btd_1", verdict: "maybe" }, { demandId: "btd_1", verdict: "shortlist", reason: 3 },
      { demandId: "btd_1", verdict: "not_a_fit", reason: "x".repeat(201) }, { verdict: "clear" }]) {
      expect((await POST(post(body), context)).status).toBe(400);
    }
    expect(mocks.verdict).not.toHaveBeenCalled();
  });
});
