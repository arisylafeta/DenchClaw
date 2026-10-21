import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), get: vi.fn(), list: vi.fn(), add: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/crm-postgres/bulk-listings", () => ({ getListing: mocks.get }));
// The demand URLs still only accept demand listings.
vi.mock("@/lib/crm-postgres/bulk-demand", () => ({ getDemand: mocks.get }));
vi.mock("@/lib/crm-postgres/bulk-demand-activity", async (original) => ({
  ...await original(), listDemandActivity: mocks.list, addDemandActivity: mocks.add, deleteDemandActivity: mocks.remove,
}));
import { GET, POST } from "./route";
import { DELETE } from "./[activityId]/route";
const context = { params: Promise.resolve({ demandId: "btd_test" }) };
const request = (body: unknown) => new Request("http://localhost/activity", { method: "POST", body: JSON.stringify(body) });

describe("demand activity routes", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user", email: "user@test" });
    mocks.get.mockResolvedValue({ id: "btd_test" });
    mocks.list.mockResolvedValue([]);
    mocks.add.mockResolvedValue({ id: "12" });
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });

  it("requires sign-in on reads and writes", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await GET(request(null), context)).status).toBe(401);
    expect((await POST(request({ kind: "note", title: "Hello" }), context)).status).toBe(401);
    expect((await DELETE(request(null), { params: Promise.resolve({ demandId: "btd_test", activityId: "12" }) })).status).toBe(401);
  });
  it("lists activity and reports missing demand", async () => {
    expect(await (await GET(request(null), context)).json()).toEqual({ activity: [] });
    mocks.get.mockResolvedValue(null);
    expect((await GET(request(null), context)).status).toBe(404);
    expect((await POST(request({ kind: "note", title: "Hello" }), context)).status).toBe(404);
  });
  it("validates inputs and assigns the signed-in actor", async () => {
    for (const body of [null, { kind: "bad", title: "x" }, { kind: "note", title: " " },
      { kind: "note", title: "x", data: [] }, { kind: "note", title: "x", occurredAt: "yesterday" },
      { kind: "supply", title: "x", refKind: "bad" }]) {
      expect((await POST(request(body), context)).status).toBe(400);
    }
    expect((await POST(request({ kind: "supply", title: "Found stock", refKind: "stock", refId: "s1", actorUserId: "spoof" }), context)).status).toBe(201);
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ demandId: "btd_test", actorUserId: "user", refId: "s1" }));
  });
  it("scopes deletion and rejects invalid bigint IDs", async () => {
    const remove = (activityId: string) => DELETE(request(null), { params: Promise.resolve({ demandId: "btd_test", activityId }) });
    expect((await remove("9999999999999999999999999")).status).toBe(400);
    mocks.remove.mockResolvedValue(false);
    expect((await remove("12")).status).toBe(404);
    mocks.remove.mockResolvedValue(true);
    expect((await remove("12")).status).toBe(200);
    expect(mocks.remove).toHaveBeenLastCalledWith("btd_test", "12");
  });
});
