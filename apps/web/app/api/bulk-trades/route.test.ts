import { afterEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.fn();
vi.mock("@/lib/auth", () => ({ currentUser }));

const createBulkTrade = vi.fn(async (patch: Record<string, unknown>) => ({ id: "bt_1", ...patch }));
const updateBulkTrade = vi.fn();
vi.mock("@/lib/crm-postgres/bulk-trades", () => ({
  listBulkTrades: vi.fn(async () => ({ trades: [], owners: [] })),
  createBulkTrade,
  updateBulkTrade,
}));

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "alex@rebattery.io", displayName: "Alex" };

function jsonRequest(method: string, body: unknown) {
  return new Request("http://localhost/api/bulk-trades", { method, body: JSON.stringify(body) });
}

describe("bulk trades routes", () => {
  afterEach(() => {
    delete process.env.CRM_DB_BACKEND;
    vi.clearAllMocks();
  });

  it("requires the Postgres backend and a signed-in user", async () => {
    delete process.env.CRM_DB_BACKEND;
    const { GET } = await import("./route");
    expect((await GET()).status).toBe(503);

    process.env.CRM_DB_BACKEND = "postgres";
    currentUser.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(401);
  });

  it("creates a trade as the signed-in user and rejects a missing title", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    currentUser.mockResolvedValue(USER);
    const { POST } = await import("./route");

    expect((await POST(jsonRequest("POST", { next_step: "Call" }))).status).toBe(400);
    const response = await POST(jsonRequest("POST", { title: "Oklahoma", trade_stage: "Closing" }));
    expect(response.status).toBe(201);
    expect(createBulkTrade).toHaveBeenCalledWith({ title: "Oklahoma", trade_stage: "Closing" }, USER.id);
  });

  it("validates updates and returns 404 for an unknown trade", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    currentUser.mockResolvedValue(USER);
    const { PATCH } = await import("./[id]/route");
    const params = { params: Promise.resolve({ id: "bt_missing" }) };

    expect((await PATCH(jsonRequest("PATCH", { stage: "Completed" }), params)).status).toBe(400);
    expect(updateBulkTrade).not.toHaveBeenCalled();

    updateBulkTrade.mockResolvedValueOnce(null);
    expect((await PATCH(jsonRequest("PATCH", { trade_stage: "Lost" }), params)).status).toBe(404);
    expect(updateBulkTrade).toHaveBeenCalledWith("bt_missing", { trade_stage: "Lost" }, USER.id);
  });
});
