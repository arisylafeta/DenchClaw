import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.fn();
vi.mock("@/lib/auth", () => ({ currentUser }));

const details = {
  getTradeDetail: vi.fn(),
  addBid: vi.fn(async () => ({ id: "btb_1", status: "Bid in" })),
  setField: vi.fn(),
  resolveConflict: vi.fn(),
  getFileForDownload: vi.fn(),
  updateFile: vi.fn(),
};
vi.mock("@/lib/crm-postgres/bulk-trade-details", () => details);
vi.mock("@/lib/crm-postgres/bulk-trades", () => ({ updateBulkTrade: vi.fn() }));
const readTradeFile = vi.fn();
vi.mock("@/lib/bulk-trade-files", () => ({ readTradeFile }));

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "alex@rebattery.io", displayName: "Alex" };
const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

describe("trade detail routes", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    currentUser.mockResolvedValue(USER);
  });
  afterEach(() => {
    delete process.env.CRM_DB_BACKEND;
    vi.clearAllMocks();
  });

  it("returns 404 for an unknown trade and requires sign-in", async () => {
    const { GET } = await import("./route");
    details.getTradeDetail.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://localhost/x"), params({ id: "bt_x" }))).status).toBe(404);

    currentUser.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://localhost/x"), params({ id: "bt_x" }))).status).toBe(401);
  });

  it("records a structured bid as the signed-in user", async () => {
    const { POST } = await import("./buyers/[buyerId]/bids/route");
    const res = await POST(post({ amount: 22, unit: "kWh", currency: "EUR", firmness: "firm" }), params({ id: "bt_1", buyerId: "btb_1" }));
    expect(res.status).toBe(201);
    expect(details.addBid).toHaveBeenCalledWith("bt_1", "btb_1", expect.objectContaining({ amount: 22, unit: "kWh" }), USER.id);

    const bad = await POST(post({ amount: 22, unit: "kWh", currency: "EUR" }), params({ id: "bt_1", buyerId: "btb_1" }));
    expect(bad.status).toBe(400);
  });

  it("says when a field is not in the trade kind's template", async () => {
    const { PUT } = await import("./fields/[key]/route");
    details.setField.mockResolvedValueOnce("unknown_field");
    const res = await PUT(post({ value: "3 t" }), params({ id: "bt_1", key: "weight" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("weight");
  });

  it("downloads files as attachments only", async () => {
    const { GET } = await import("./files/[fileId]/route");
    details.getFileForDownload.mockResolvedValueOnce({ file_name: 'stock "list".xlsx', content_type: "text/html", storage_key: "k" });
    readTradeFile.mockResolvedValueOnce(Buffer.from("x"));
    const res = await GET(new Request("http://localhost/x"), params({ id: "bt_1", fileId: "btf_1" }));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="stock _list_.xlsx"/);
  });
});
