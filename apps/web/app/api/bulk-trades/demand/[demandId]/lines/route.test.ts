import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/crm-postgres/bulk-demand", () => ({ setDemandLines: mocks.save }));
import { PUT } from "./route";

const context = { params: Promise.resolve({ demandId: "btd_1" }) };
const put = (body: unknown) => new Request("http://localhost/lines", { method: "PUT", body: JSON.stringify(body) });

describe("pack types PUT", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user", email: "user@test" });
    mocks.save.mockImplementation(async (_id: string, lines: unknown) => lines);
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });

  it("saves checked lines", async () => {
    const res = await PUT(put({ lines: [{ id: "zoe41", label: "Renault Zoe 41 kWh", products: ["Zoe"], kwh: [41], qty_min: 4 }] }), context);
    expect(res.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith("btd_1", [{ id: "zoe41", label: "Renault Zoe 41 kWh", products: ["zoe"], kwh: [41], qty_min: 4, qty_max: null }]);
  });

  it("refuses bad lines and writes nothing", async () => {
    for (const body of [{}, { lines: "x" }, { lines: [{ label: "", qty_min: 1 }] }]) expect((await PUT(put(body), context)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("says when the request is not there", async () => {
    mocks.save.mockResolvedValue(null);
    expect((await PUT(put({ lines: [] }), context)).status).toBe(404);
  });
});
