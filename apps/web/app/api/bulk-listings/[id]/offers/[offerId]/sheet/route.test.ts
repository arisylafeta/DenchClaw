import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ guard: vi.fn(), getListing: vi.fn(), getOffer: vi.fn(), prepare: vi.fn(), store: vi.fn() }));
vi.mock("@/lib/bulk-trades-route", async (original) => ({ ...(await original<typeof import("@/lib/bulk-trades-route")>()), guardBulkTrades: m.guard }));
vi.mock("@/lib/crm-postgres/bulk-listings", () => ({ getListing: m.getListing }));
vi.mock("@/lib/crm-postgres/bulk-offers", () => ({ getOffer: m.getOffer }));
vi.mock("@/lib/crm-postgres/bulk-offer-close", () => ({ prepareOfferSheet: m.prepare, storeOfferSheet: m.store }));

import { POST } from "./route";
import { SheetRefused } from "@/lib/bulk-price-sheet";

const call = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "sup_1", offerId: "bof_1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.guard.mockResolvedValue({ userId: "u1", email: "alex@rebattery.io" });
  m.getListing.mockResolvedValue({ id: "sup_1", kind: "supply" });
  m.getOffer.mockResolvedValue({ id: "bof_1", listing_id: "sup_1" });
  m.prepare.mockResolvedValue({ kind: "fixed", lines: 1, buyer: "Sam", skipped: [], sheet: { reference: "PS-0a1b2c3d", total: { amount: 28800, currency: "GBP" } } });
  m.store.mockResolvedValue("bdoc_1");
});

describe("POST price sheet", () => {
  it("makes and stores an overview or a fixed sheet, and links the stored file", async () => {
    const res = await call({ kind: "fixed" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      reference: "PS-0a1b2c3d", documentId: "bdoc_1", lines: 1, total: { amount: 28800, currency: "GBP" }, skipped: [],
      file: "/api/bulk-listings/sup_1/documents/bdoc_1/file",
    });
    expect(m.prepare).toHaveBeenCalledWith("bof_1", "fixed");
  });

  it("does not make the send copy here, and says what to fix when refused", async () => {
    expect((await call({ kind: "send" })).status).toBe(400);
    m.prepare.mockRejectedValue(new SheetRefused("The seller's quote ran out on 3 Nov. Ask them to confirm it."));
    const res = await call({ kind: "overview" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/ran out on 3 Nov/);
    expect(m.store).not.toHaveBeenCalled();
  });
});
