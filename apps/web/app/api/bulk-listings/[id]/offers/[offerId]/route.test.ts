import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), listing: vi.fn(), get: vi.fn(), update: vi.fn(), link: vi.fn(), noStock: vi.fn() }));
vi.mock("@/lib/bulk-trades-route", async (original) => ({ ...(await original<typeof import("@/lib/bulk-trades-route")>()), guardBulkTrades: mocks.guard }));
vi.mock("@/lib/crm-postgres/bulk-listings", () => ({ getListing: mocks.listing }));
vi.mock("@/lib/crm-postgres/bulk-offer-mail", () => ({ markNoStock: mocks.noStock }));
vi.mock("@/lib/crm-postgres/bulk-offers", () => ({
  OFFER_STAGES: ["candidate", "offered", "negotiating", "contract_out", "signed", "invoiced", "paid", "complete", "declined", "lost"],
  OfferConflict: class extends Error {}, addThreadEntry: vi.fn(), offerThread: vi.fn(),
  getOffer: mocks.get, updateOffer: mocks.update, linkOffer: mocks.link,
}));
import { PATCH } from "./route";

const context = { params: Promise.resolve({ id: "bl_1", offerId: "bof_1" }) };
const patch = (body: unknown) => new Request("http://localhost/offer", { method: "PATCH", body: JSON.stringify(body) });
const offer = { id: "bof_1", stage: "invoiced", paid_on: null, paid_amount: null, paid_currency: null, quantity: null, take_gbp: null };

describe("offer PATCH: the paid rule", () => {
  beforeEach(() => {
    mocks.guard.mockResolvedValue({ userId: "u1", email: "alex@rebattery.io" });
    mocks.listing.mockResolvedValue({ id: "bl_1", kind: "supply" });
    mocks.get.mockResolvedValue(offer);
    mocks.update.mockImplementation(async (_l: string, _o: string, p: { stage?: string }) => ({ ...offer, ...p }));
  });
  afterEach(() => vi.resetAllMocks());

  it("refuses Paid without the paid facts, names what is missing, and writes nothing", async () => {
    const response = await PATCH(patch({ stage: "paid" }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "To mark this offer Paid, add the paid date, amount paid, currency, quantity and take in GBP.",
      missing: ["paid_on", "paid_amount", "paid_currency", "quantity", "take_gbp"],
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses Complete when only some facts are given", async () => {
    const response = await PATCH(patch({ stage: "complete", paidOn: "2026-12-03", paidAmount: 18000, paidCurrency: "EUR" }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("To mark this offer Complete, add the quantity and take in GBP.");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("saves Paid with every fact, and counts the ones already on the offer", async () => {
    const full = { stage: "paid", paidOn: "2026-12-03", paidAmount: 18000, paidCurrency: "eur", quantity: 48, takeGbp: 1500 };
    expect((await PATCH(patch(full), context)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("bl_1", "bof_1", {
      stage: "paid", paid: { paid_on: "2026-12-03", paid_amount: 18000, paid_currency: "EUR", quantity: 48, take_gbp: 1500 },
    }, "u1");
    mocks.get.mockResolvedValue({ ...offer, paid_on: "2026-12-03", paid_amount: 18000, paid_currency: "EUR", quantity: 48, take_gbp: 1500 });
    expect((await PATCH(patch({ stage: "complete" }), context)).status).toBe(200);
  });

  it("will not clear a paid fact on an offer that is paid", async () => {
    mocks.get.mockResolvedValue({ ...offer, stage: "paid", paid_on: "2026-12-03", paid_amount: 18000, paid_currency: "EUR", quantity: 48, take_gbp: 1500 });
    const response = await PATCH(patch({ takeGbp: null }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).missing).toEqual(["take_gbp"]);
  });

  it("leaves other stages and edits alone", async () => {
    expect((await PATCH(patch({ stage: "signed" }), context)).status).toBe(200);
    expect((await PATCH(patch({ nextStep: "Send the invoice" }), context)).status).toBe(200);
    expect((await PATCH(patch({ stage: "paid", paidOn: "soon" }), context)).status).toBe(400);
  });
});
