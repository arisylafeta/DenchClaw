import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crm-postgres/commercial-stock", () => ({
  liveStock: vi.fn(async () => [{
    id: "sto_secret", company_id: "co_secret", person_id: "p_secret", supplier: "Hidden Breaker AB", status: "opportunity",
    make: "Kia", model: "e-Niro", format: "pack", capacity_kwh: 64, chemistry: "NMC", powertrain: "BEV", year: 2020,
    country: "Norway", quantity: 1, price_eur_ex_vat: 5200, price_eur: 6500, seen_on: "2026-10-26", sync_class: "synced",
  }]),
}));
vi.mock("@/lib/commercial-stock-access", async (original) => ({
  ...(await original<typeof import("@/lib/commercial-stock-access")>()),
  commercialStockAuthorised: (request: Request) => request.headers.get("authorization") === "Bearer ok",
}));

const { POST: search } = await import("./stock/route");

const call = (body: unknown, auth = "Bearer ok") =>
  new Request("http://crm.test/api", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("commercial-buyer routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuse callers without the shared secret", async () => {
    expect((await search(call({}, "Bearer nope"))).status).toBe(401);
  });

  it("return stock groups without supplier identity", async () => {
    const response = await search(call({ make: "kia" }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ totalGroups: 1, totalUnits: 1, groups: [{ make: "Kia", units: 1 }] });
    for (const secret of ["Hidden Breaker", "co_secret", "p_secret", "sto_secret"]) expect(text).not.toContain(secret);
  });

  it("reject unknown filters", async () => {
    expect((await search(call({ supplier: "x" }))).status).toBe(400);
  });

});
