import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), listing: vi.fn(), offer: vi.fn(), update: vi.fn(), noStock: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/crm-postgres/bulk-listings", () => ({ getListing: mocks.listing }));
vi.mock("@/lib/crm-postgres/bulk-offer-mail", () => ({ markNoStock: mocks.noStock }));
vi.mock("@/lib/crm-postgres/bulk-offers", async (orig) => ({
  ...(await orig<typeof import("@/lib/crm-postgres/bulk-offers")>()),
  getOffer: mocks.offer, updateOffer: mocks.update, linkOffer: vi.fn(), addThreadEntry: vi.fn(), offerThread: vi.fn(),
}));
import { PATCH } from "./route";

const context = { params: Promise.resolve({ id: "btl_1", offerId: "bto_1" }) };
const patch = (body: unknown) => new Request("http://localhost/offer", { method: "PATCH", body: JSON.stringify(body) });

describe("offer PATCH", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user", email: "user@test" });
    mocks.listing.mockResolvedValue({ id: "btl_1" });
    mocks.update.mockResolvedValue({ id: "bto_1", stage: "declined" });
    mocks.noStock.mockResolvedValue({ marked: "sto_1", suggestion: null });
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });

  it("refuses Declined or Lost without a reason, and writes nothing", async () => {
    for (const stage of ["declined", "lost"]) {
      for (const body of [{ stage }, { stage, declinedReason: "   " }, { stage, declinedReason: null }]) {
        const response = await PATCH(patch(body), context);
        expect(response.status).toBe(400);
      }
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("stores the trimmed reason with the stage", async () => {
    expect((await PATCH(patch({ stage: "declined", declinedReason: " Price too high " }), context)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("btl_1", "bto_1", { stage: "declined", declinedReason: "Price too high" }, "user");
  });

  it("marks the linked stock line stale only when a request's reason is exactly No stock", async () => {
    mocks.listing.mockResolvedValue({ id: "btl_1", kind: "demand" });
    mocks.update.mockResolvedValue({ id: "bto_1", stage: "declined", declined_reason: "No stock" });
    const response = await PATCH(patch({ stage: "declined", declinedReason: "No stock" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ noStock: { marked: "sto_1" } });
    expect(mocks.noStock).toHaveBeenCalledWith("btl_1", "bto_1", "demand", "user");

    mocks.noStock.mockClear();
    mocks.update.mockResolvedValue({ id: "bto_1", stage: "declined", declined_reason: "Price too high" });
    await PATCH(patch({ stage: "declined", declinedReason: "Price too high" }), context);
    expect(mocks.noStock).not.toHaveBeenCalled();
  });

  it("suggests closing a listing instead of marking stock on a supply offer", async () => {
    mocks.listing.mockResolvedValue({ id: "btl_1", kind: "supply" });
    mocks.update.mockResolvedValue({ id: "bto_1", stage: "lost", declined_reason: "No stock" });
    mocks.noStock.mockResolvedValue({ marked: null, suggestion: "Close the listing when every offer has come back." });
    const response = await PATCH(patch({ stage: "lost", declinedReason: "No stock" }), context);
    expect(await response.json()).toMatchObject({ noStock: { suggestion: expect.stringMatching(/Close the listing/) } });
    expect(mocks.noStock).toHaveBeenCalledWith("btl_1", "bto_1", "supply", "user");
  });

  it("still moves an offer to any other stage without a reason", async () => {
    expect((await PATCH(patch({ stage: "negotiating" }), context)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("btl_1", "bto_1", { stage: "negotiating" }, "user");
  });
});
