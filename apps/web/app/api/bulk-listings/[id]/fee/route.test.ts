import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), fee: vi.fn(), cant: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/crm-postgres/bulk-listing-fee", () => ({ setListingFee: mocks.fee }));
vi.mock("@/lib/crm-postgres/bulk-listing-cant-source", () => ({ setListingCantSource: mocks.cant }));
import { PUT as putFee } from "./route";
import { PUT as putCantSource } from "../cant-source/route";

const params = { params: Promise.resolve({ id: "btl_1" }) };
const put = (body: unknown) => new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(body) });

describe("listing fee and can't source", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user" });
    mocks.fee.mockResolvedValue(true); mocks.cant.mockResolvedValue(true);
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });

  it("sets a fee in whole euros, clears it with null, and refuses anything else", async () => {
    expect(await (await putFee(put({ fee_eur: 4200.6 }), params)).json()).toEqual({ fee_eur: 4201 });
    expect(mocks.fee).toHaveBeenLastCalledWith("btl_1", 4201);
    expect(await (await putFee(put({ fee_eur: null }), params)).json()).toEqual({ fee_eur: null });
    expect(mocks.fee).toHaveBeenLastCalledWith("btl_1", null);
    for (const fee_eur of [-1, "4200", 1e12]) expect((await putFee(put({ fee_eur }), params)).status).toBe(400);
    mocks.fee.mockResolvedValue(false);
    expect((await putFee(put({ fee_eur: 10 }), params)).status).toBe(404);
  });

  it("stores a trimmed reason, treats blank as clear, and refuses non-text", async () => {
    expect(await (await putCantSource(put({ reason: "  No packs this quarter " }), params)).json()).toEqual({ reason: "No packs this quarter" });
    expect(mocks.cant).toHaveBeenLastCalledWith("btl_1", "No packs this quarter");
    await putCantSource(put({ reason: "   " }), params);
    expect(mocks.cant).toHaveBeenLastCalledWith("btl_1", null);
    expect((await putCantSource(put({ reason: 3 }), params)).status).toBe(400);
  });

  it("needs a signed-in user", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await putFee(put({ fee_eur: 1 }), params)).status).toBe(401);
    expect(mocks.fee).not.toHaveBeenCalled();
  });
});
