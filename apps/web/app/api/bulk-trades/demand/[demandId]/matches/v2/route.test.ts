import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), matches: vi.fn(), verdict: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/crm-postgres/demand-matches-v2", () => ({ demandMatchesV2: mocks.matches }));
vi.mock("@/lib/crm-postgres/demand-supply", () => ({ recordMatchVerdict: mocks.verdict }));
vi.mock("@/lib/crm-postgres/supply-matches", () => ({ REASON_MAX: 200 }));
import { POST } from "./route";

const context = { params: Promise.resolve({ demandId: "btd_stn" }) };
const post = (body: unknown) => new Request("http://localhost/matches/v2", { method: "POST", body: JSON.stringify(body) });
const unit = (key: string, vehicle: string) => ({ key, vehicle });

describe("request Not a fit", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user", email: "user@test" });
    mocks.verdict.mockImplementation(async (_id: string, input: { key: string }) => ({ id: input.key }));
    mocks.matches.mockResolvedValue({
      rows: [
        { key: "stock:sto_9", name: "Carden" },
        { key: "group:stock:sto_1", name: "Northway Parts", group: { units: [unit("stock:sto_1", "Vauxhall Vivaro-e"), unit("stock:sto_2", "Peugeot Rifter"), unit("stock:sto_3", "Peugeot e-208")] } },
      ],
    });
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });

  it("on a group, records one Not a fit per unit, so each stays hidden on the request", async () => {
    const response = await POST(post({ key: "group:stock:sto_1", label: "Northway Parts", reason: "Price" }), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ count: 3 });
    expect(mocks.verdict.mock.calls.map(([id, input]) => [id, input.key, input.verdict, input.reason, input.title])).toEqual([
      ["btd_stn", "stock:sto_1", "not_a_fit", "Price", "Northway Parts: Vauxhall Vivaro-e (group of 3)"],
      ["btd_stn", "stock:sto_2", "not_a_fit", "Price", "Northway Parts: Peugeot Rifter (group of 3)"],
      ["btd_stn", "stock:sto_3", "not_a_fit", "Price", "Northway Parts: Peugeot e-208 (group of 3)"],
    ]);
  });

  it("on a single row, or a unit inside a group, records just that one", async () => {
    expect((await POST(post({ key: "stock:sto_9", label: "Carden", reason: "Price" }), context)).status).toBe(201);
    expect((await POST(post({ key: "stock:sto_2", label: "Northway Parts", reason: "Price" }), context)).status).toBe(201);
    expect(mocks.verdict.mock.calls.map(([, input]) => input.key)).toEqual(["stock:sto_9", "stock:sto_2"]);
  });

  it("refuses a key that is not a match, or no reason", async () => {
    expect((await POST(post({ key: "group:stock:sto_404", label: "X", reason: "Price" }), context)).status).toBe(404);
    expect((await POST(post({ key: "company:c1", label: "X", reason: "Price" }), context)).status).toBe(400);
    expect((await POST(post({ key: "group:stock:sto_1", label: "Northway Parts", reason: " " }), context)).status).toBe(400);
    expect(mocks.verdict).not.toHaveBeenCalled();
  });
});
