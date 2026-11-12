import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, POST } from "./route";

vi.mock("@/lib/auth", () => ({ currentUser: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", email: "ari@rebattery.io" })) }));

const { listMock, createMock, updateMock, expireMock, ReadOnly, Invalid } = vi.hoisted(() => {
  class InterestReadOnly extends Error { constructor(message: string) { super(message); this.name = "InterestReadOnly"; } }
  class InterestInvalid extends Error { constructor(message: string) { super(message); this.name = "InterestInvalid"; } }
  return {
    listMock: vi.fn(), createMock: vi.fn(), updateMock: vi.fn(), expireMock: vi.fn(),
    ReadOnly: InterestReadOnly, Invalid: InterestInvalid,
  };
});

vi.mock("@/lib/crm-postgres/buyer-interest", () => ({
  listBuyerInterests: listMock,
  createBuyerInterest: createMock,
  updateBuyerInterest: updateMock,
  expireBuyerInterest: expireMock,
  InterestReadOnly: ReadOnly,
  InterestInvalid: Invalid,
}));

const ctx = (id = "co_1") => ({ params: Promise.resolve({ id }) });
const request = (method: string, body?: unknown) =>
  new Request("http://localhost/api/crm/companies/co_1/interests", {
    method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("company wants API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the company's wants", async () => {
    listMock.mockResolvedValue([{ id: "bi_1", kind: "standing", label: "LFP packs" }]);
    const res = await GET(request("GET"), ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ interests: [{ id: "bi_1", kind: "standing", label: "LFP packs" }] });
    expect(listMock).toHaveBeenCalledWith("co_1");
  });

  it("adds a mastered want", async () => {
    createMock.mockResolvedValue({ id: "bi_2", kind: "interest", label: "NMC packs" });
    const res = await POST(request("POST", { kind: "interest", chemistry: "NMC", format: "pack" }), ctx());
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ interest: { id: "bi_2" } });
    expect(createMock).toHaveBeenCalledWith("co_1", expect.objectContaining({ kind: "interest", chemistry: "NMC" }));
  });

  it("refuses a synced kind and a want with no product", async () => {
    createMock.mockRejectedValueOnce(new ReadOnly("A ask line is synced from its source and cannot be edited here."));
    expect((await POST(request("POST", { kind: "ask", chemistry: "NMC" }), ctx())).status).toBe(403);
    createMock.mockRejectedValueOnce(new Invalid("State the product: a part number, make and model with kWh, a cell, or a chemistry and format."));
    const res = await POST(request("POST", { kind: "standing" }), ctx());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("State the product") });
  });

  it("edits a mastered want and expires one", async () => {
    updateMock.mockResolvedValue({ id: "bi_3", quantity: 5 });
    const edit = await PATCH(request("PATCH", { id: "bi_3", quantity: 5 }), ctx());
    expect(edit.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith("co_1", "bi_3", expect.objectContaining({ quantity: 5 }));

    expireMock.mockResolvedValue({ id: "bi_3", expired: true });
    const expire = await PATCH(request("PATCH", { id: "bi_3", action: "expire" }), ctx());
    expect(expire.status).toBe(200);
    expect(expireMock).toHaveBeenCalledWith("co_1", "bi_3");
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for an unknown want, 400 for a missing id and 401 without a user", async () => {
    updateMock.mockResolvedValueOnce(null);
    expect((await PATCH(request("PATCH", { id: "bi_x" }), ctx())).status).toBe(404);
    expect((await PATCH(request("PATCH", {}), ctx())).status).toBe(400);

    const auth = await import("@/lib/auth");
    vi.mocked(auth.currentUser).mockResolvedValueOnce(null);
    expect((await GET(request("GET"), ctx())).status).toBe(401);
  });
});
