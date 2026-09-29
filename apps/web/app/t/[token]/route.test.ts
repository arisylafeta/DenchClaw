import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const followTrackedLink = vi.fn();
vi.mock("@/lib/crm-postgres/bulk-trade-details", () => ({ followTrackedLink }));

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
const params = (token: string) => ({ params: Promise.resolve({ token }) });

describe("tracked link route", () => {
  beforeEach(() => { process.env.CRM_DB_BACKEND = "postgres"; });
  afterEach(() => { delete process.env.CRM_DB_BACKEND; vi.clearAllMocks(); });

  it("forwards a person's click and counts it", async () => {
    followTrackedLink.mockResolvedValueOnce("https://rebattery.io/a/ebs37");
    const { GET } = await import("./route");
    const res = await GET(new Request(`http://localhost/t/${TOKEN}`, { headers: { "user-agent": CHROME } }), params(TOKEN));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://rebattery.io/a/ebs37");
    expect(followTrackedLink).toHaveBeenCalledWith(TOKEN, true);
  });

  it("forwards scanners without counting them, and 404s unknown or malformed tokens", async () => {
    const { GET } = await import("./route");
    followTrackedLink.mockResolvedValueOnce("https://rebattery.io/a/ebs37");
    await GET(new Request(`http://localhost/t/${TOKEN}`, { headers: { "user-agent": "Mimecast URL scanner" } }), params(TOKEN));
    expect(followTrackedLink).toHaveBeenCalledWith(TOKEN, false);

    followTrackedLink.mockResolvedValueOnce(null);
    expect((await GET(new Request(`http://localhost/t/${TOKEN}`), params(TOKEN))).status).toBe(404);
    expect((await GET(new Request("http://localhost/t/x"), params("../../etc"))).status).toBe(404);
    expect(followTrackedLink).toHaveBeenCalledTimes(2);
  });
});
