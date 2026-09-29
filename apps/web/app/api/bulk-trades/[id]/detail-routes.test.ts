import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.fn();
vi.mock("@/lib/auth", () => ({ currentUser }));

const details = {
  getTradeDetail: vi.fn(),
  updateBuyer: vi.fn(),
  addBid: vi.fn(async () => ({ id: "btb_1", status: "Bid in" })),
  setField: vi.fn(),
  resolveConflict: vi.fn(),
  getFileForDownload: vi.fn(),
  updateFile: vi.fn(),
  logEmailDraft: vi.fn(),
  buyerOnTrade: vi.fn(async () => true),
  createTrackedLinks: vi.fn(async (_lot: string, _buyer: string | null, _to: string | null, urls: string[]) =>
    new Map(urls.map((url, index) => [url, `tok${index}`]))),
};
vi.mock("@/lib/crm-postgres/bulk-trade-details", () => details);
const getBulkTrade = vi.fn(async (id: string) => (id === "bt_1" ? { id } : null));
vi.mock("@/lib/crm-postgres/bulk-trades", () => ({ updateBulkTrade: vi.fn(), getBulkTrade }));
const createGmailDraft = vi.fn(async () => ({ draftId: "r1", messageId: "m1" }));
vi.mock("@/lib/gmail-drafts", async (original) => ({ ...(await original<typeof import("@/lib/gmail-drafts")>()), createGmailDraft }));

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
    details.getFileForDownload.mockResolvedValueOnce({ file_name: 'stock "list".xlsx', content: Buffer.from("x") });
    const res = await GET(new Request("http://localhost/x"), params({ id: "bt_1", fileId: "btf_1" }));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="stock _list_.xlsx"/);

    details.getFileForDownload.mockResolvedValueOnce({ file_name: "电池报告.pdf", content: Buffer.from("x") });
    const unicode = await GET(new Request("http://localhost/x"), params({ id: "bt_1", fileId: "btf_2" }));
    expect(unicode.status).toBe(200);
    expect(unicode.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("电池报告.pdf")}`);
  });

  it("makes the Gmail draft in the signed-in user's own account and logs it", async () => {
    const { POST } = await import("./email-draft/route");
    const res = await POST(post({ to: "sam@example.test", subject: "Synthetic eBS37", body: "Hi Sam" }), params({ id: "bt_1" }));
    expect(res.status).toBe(201);
    expect(createGmailDraft).toHaveBeenCalledWith(USER.email, { to: ["sam@example.test"], subject: "Synthetic eBS37", body: "Hi Sam" });
    expect((await res.json()).url).toContain("compose=m1");
    expect(details.logEmailDraft).toHaveBeenCalledWith("bt_1", expect.objectContaining({ to: ["sam@example.test"], draft_id: "r1", tracked_links: 0 }), USER.id);
    expect(details.createTrackedLinks).not.toHaveBeenCalled();

    const bad = await POST(post({ to: "not an email", subject: "x", body: "y" }), params({ id: "bt_1" }));
    expect(bad.status).toBe(400);
    expect((await POST(post({ subject: "x", body: "y" }), params({ id: "bt_9" }))).status).toBe(404);
  });

  it("swaps links for tracked ones when a public link base is set", async () => {
    process.env.BULK_TRADES_LINK_BASE = "https://crm.example.test";
    try {
      const { POST } = await import("./email-draft/route");
      const res = await POST(post({
        to: "tess@example.test", subject: "Battery batch available", buyer_id: "btb_1",
        body: "Auction: https://rebattery.io/a/ebs37 and specs https://rebattery.io/a/ebs37/specs.",
      }), params({ id: "bt_1" }));
      expect((await res.json()).tracked_links).toBe(2);
      expect(details.createTrackedLinks).toHaveBeenCalledWith("bt_1", "btb_1", "tess@example.test",
        ["https://rebattery.io/a/ebs37", "https://rebattery.io/a/ebs37/specs"], USER.id);
      const sentBody = createGmailDraft.mock.calls.at(-1)![1].body;
      expect(sentBody).toBe("Auction: https://crm.example.test/t/tok0 and specs https://crm.example.test/t/tok1.");
    } finally {
      delete process.env.BULK_TRADES_LINK_BASE;
    }
  });

  it("turns a missing linked CRM person into a clear 400", async () => {
    const { PATCH } = await import("./buyers/[buyerId]/route");
    details.updateBuyer.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "23503" }));
    const res = await PATCH(post({ person_id: "p_gone" }), params({ id: "bt_1", buyerId: "btb_1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no longer exists");
  });
});

