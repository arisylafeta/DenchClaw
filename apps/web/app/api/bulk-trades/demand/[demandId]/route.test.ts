import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_REGISTRY } from "@/lib/bulk-registry.fixture";

const mocks = vi.hoisted(() => ({ user: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/crm-postgres/bulk-registry", () => ({ loadRegistry: async () => TEST_REGISTRY }));
vi.mock("@/lib/crm-postgres/bulk-demand", () => ({
  getDemand: mocks.get, updateDemand: mocks.update, categorizeDemand: vi.fn(), closeDemand: vi.fn(), confirmDemand: vi.fn(), makeStanding: vi.fn(), setBasis: vi.fn(),
}));
import { PATCH } from "./route";

const context = { params: Promise.resolve({ demandId: "btd_1" }) };
const patch = (body: unknown) => new Request("http://localhost/demand", { method: "PATCH", body: JSON.stringify(body) });
const saved = { id: "btd_1", spec: {}, max_price: 40, price_currency: "EUR", price_unit: "kWh", location: "Ukraine (Kharkiv base; delivery site tbc)" };

describe("demand PATCH, criteria edits", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user", email: "user@test" });
    mocks.get.mockResolvedValue(saved);
    mocks.update.mockImplementation(async (_id: string, value: unknown) => ({ ...saved, ...(value as object) }));
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });

  it("refuses a price floor above the saved ceiling in the same currency and unit, and writes nothing", async () => {
    const res = await PATCH(patch({ spec: { price_floor: { amount: 50, currency: "EUR", unit: "kWh" } } }), context);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/above the ceiling/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses a ceiling saved below the saved floor", async () => {
    mocks.get.mockResolvedValue({ ...saved, spec: { price_floor: { amount: 30, currency: "EUR", unit: "kWh" } } });
    const res = await PATCH(patch({ max_price: 20, price_currency: "EUR", price_unit: "kWh" }), context);
    expect(res.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("saves a floor at or below the ceiling, or in another currency", async () => {
    expect((await PATCH(patch({ spec: { price_floor: { amount: 30, currency: "EUR", unit: "kWh" } } }), context)).status).toBe(200);
    expect((await PATCH(patch({ spec: { price_floor: { amount: 90, currency: "USD", unit: "kWh" } } }), context)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it("does not touch location when only the spec is sent", async () => {
    await PATCH(patch({ spec: { chemistries: ["NMC"] } }), context);
    expect(mocks.update.mock.calls[0][1]).not.toHaveProperty("location");
  });
});
