import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProductKey, type FieldFact } from "@/lib/match/product-key";

const m = vi.hoisted(() => ({
  currentUser: vi.fn(), getListing: vi.fn(), offerOutreach: vi.fn(), setOpenDraft: vi.fn(),
  readMailDraft: vi.fn(), createOfferEmailDraft: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ currentUser: m.currentUser, ALLOWED_EMAILS: new Set(["alex@rebattery.io", "ari@rebattery.io"]) }));
vi.mock("@/lib/crm-postgres/bulk-listings", () => ({ getListing: m.getListing }));
vi.mock("@/lib/crm-postgres/bulk-offer-mail", () => ({ offerOutreach: m.offerOutreach, setOpenDraft: m.setOpenDraft }));
vi.mock("@/lib/crm-postgres/mail", () => ({ readMailDraft: m.readMailDraft }));
vi.mock("@/lib/match/offer-draft", () => ({
  createOfferEmailDraft: m.createOfferEmailDraft,
  OfferDraftError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
}));

import { POST } from "./route";

process.env.CRM_DB_BACKEND = "postgres";

const fields: FieldFact[] = [
  { field_key: "capacity", value: "50 kWh per pack", status: "confirmed", visibility: "teaser" },
  { field_key: "format", value: "Packs", status: "confirmed", visibility: "teaser" },
  { field_key: "chemistry", value: "NMC", status: "confirmed", visibility: "teaser" },
  { field_key: "quantity", value: "40 packs", status: "confirmed", visibility: "teaser" },
  { field_key: "location", value: "Rotterdam, Netherlands", status: "confirmed", visibility: "teaser" },
  { field_key: "test_data", value: "BMS report supplied", status: "confirmed", visibility: "teaser" },
  // Visible to nobody, and after_nda: neither may reach a buyer.
  { field_key: "seller_price", value: "EUR 40 per kWh", status: "confirmed", visibility: "never" },
  { field_key: "soh", value: "88%", status: "confirmed", visibility: "after_nda" },
];

const outreach = (over: Record<string, unknown> = {}) => ({
  offerId: "bof_1", listingId: "sup_1", kind: "supply" as const, stage: "candidate",
  data: {}, location: "Rotterdam, Netherlands", email: "sam@buyer.test", recipientFirstName: "Sam",
  blocked: null, privateValues: ["Battery Partners Ltd"], product: { key: buildProductKey({ fields, title: null }), fields },
  buyer: { wants: "Samsung 50E packs", products: null }, lastSent: null, openDraftId: null, chaseDue: false,
  ...over,
});

const call = () => POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "sup_1", offerId: "bof_1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.currentUser.mockResolvedValue({ id: "u1", email: "alex@rebattery.io", displayName: "Alex Polglase" });
  m.getListing.mockResolvedValue({ id: "sup_1", kind: "supply" });
  m.offerOutreach.mockResolvedValue(outreach());
  m.createOfferEmailDraft.mockResolvedValue("draft_1");
  m.readMailDraft.mockResolvedValue(null);
});

describe("POST offer draft", () => {
  it("refuses an anonymous request before reading the offer", async () => {
    m.currentUser.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(m.offerOutreach).not.toHaveBeenCalled();
  });

  // The draft goes out under Alex's name, so creating one takes the sender allow-list, not just a session.
  it("refuses a signed-in user who may not send as Alex, and writes no draft", async () => {
    m.currentUser.mockResolvedValue({ id: "u2", email: "someone@rebattery.io", displayName: "Someone" });
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toMatch(/Only Ari or Alex/);
    expect(m.getListing).not.toHaveBeenCalled();
    expect(m.createOfferEmailDraft).not.toHaveBeenCalled();
    expect(m.setOpenDraft).not.toHaveBeenCalled();
  });

  it("creates a draft, stores its id and returns copy without the other party's name", async () => {
    const res = await call();
    expect(res.status).toBe(201);
    const body = await res.json() as { draftId: string; kind: string; subject: string; body: string; reused: boolean };
    expect(body).toMatchObject({ draftId: "draft_1", kind: "supply_offer", reused: false });
    expect(body.subject).toBe("40 x 50 kWh NMC packs");
    expect(body.body).toContain("Test data: BMS report supplied.");
    expect(body.body).not.toContain("Battery Partners");
    expect(m.createOfferEmailDraft).toHaveBeenCalledWith(expect.objectContaining({ to: ["sam@buyer.test"] }));
    expect(m.setOpenDraft).toHaveBeenCalledWith("bof_1", "draft_1");
  });

  it("passes the field visibility through: no seller price, no after_nda value, the teaser place kept", async () => {
    const res = await call();
    const body = await res.json() as { body: string };
    expect(body.body).toContain("Price on request.");
    expect(body.body).not.toMatch(/EUR|per kWh/i);
    expect(body.body).not.toContain("State of health");
    expect(body.body).not.toContain("88%");
    expect(body.body).toContain("available in Rotterdam, Netherlands.");
  });

  it("refuses a contact who opted out or has no address, and writes no draft", async () => {
    m.offerOutreach.mockResolvedValue(outreach({ blocked: "This contact has opted out of email.", email: "sam@buyer.test" }));
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/opted out/);
    expect(m.createOfferEmailDraft).not.toHaveBeenCalled();
    expect(m.setOpenDraft).not.toHaveBeenCalled();
  });

  it("returns the existing draft while it is still a draft, and does not create a second", async () => {
    m.offerOutreach.mockResolvedValue(outreach({ openDraftId: "draft_1" }));
    m.readMailDraft.mockResolvedValue({ id: "draft_1", state: "draft", subject: "40 x 50 kWh NMC packs", body_text: "Hi Sam," });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ draftId: "draft_1", reused: true });
    expect(m.createOfferEmailDraft).not.toHaveBeenCalled();
    expect(m.setOpenDraft).not.toHaveBeenCalled();
  });

  it("drops a stored draft that was already sent and writes a fresh one", async () => {
    m.offerOutreach.mockResolvedValue(outreach({ openDraftId: "draft_0" }));
    m.readMailDraft.mockResolvedValue({ id: "draft_0", state: "accepted" });
    const res = await call();
    expect(res.status).toBe(201);
    expect(m.setOpenDraft).toHaveBeenNthCalledWith(1, "bof_1", null);
    expect(m.createOfferEmailDraft).toHaveBeenCalledTimes(1);
  });

  it("drafts only while the offer is a candidate or offered", async () => {
    m.offerOutreach.mockResolvedValue(outreach({ stage: "negotiating" }));
    const res = await call();
    expect(res.status).toBe(400);
    expect(m.createOfferEmailDraft).not.toHaveBeenCalled();
  });

  it("uses the chase template on an offered offer that has gone quiet", async () => {
    m.offerOutreach.mockResolvedValue(outreach({ stage: "offered", chaseDue: true, lastSent: { sent_at: "2026-10-20T09:00:00Z", subject: "40 x 50 kWh NMC packs" } }));
    const res = await call();
    expect(res.status).toBe(201);
    expect((await res.json() as { kind: string; subject: string }).kind).toBe("chase");
    expect(m.createOfferEmailDraft).toHaveBeenCalledWith(expect.objectContaining({ subject: "Re: 40 x 50 kWh NMC packs" }));
  });

  it("uses the stock ask on a request", async () => {
    m.offerOutreach.mockResolvedValue(outreach({ kind: "demand", stage: "candidate" }));
    const res = await call();
    expect((await res.json() as { kind: string }).kind).toBe("request_stock");
  });

  it("builds the stock ask from the request's own facts, greets a company mailbox with Hello, and keeps the buyer out", async () => {
    // Requests have no field rows: product, quantity and timing come from crm_bulk_demand.
    m.offerOutreach.mockResolvedValue(outreach({
      kind: "demand", stage: "candidate", listingId: "btd_1", location: "Poland (delivery site tbc)", recipientFirstName: null,
      product: { key: buildProductKey({ fields: [], title: "500,000x Samsung 50E 21700 Cells" }), fields: [] },
      buyer: null, privateValues: ["Battery Partners", "Battery Partners Ltd", "buyer@batterypartners.example"],
      request: {
        productFamily: "Samsung 50E-equivalent 21700 cells", volume: 500_000, volumeUnit: "cells", quantity: "500,000",
        neededBy: "2027-01-31", spec: { formats: ["Cells"], cell_makers: ["Samsung SDI"] }, maxPrice: 1.15,
      },
    }));
    const res = await call();
    expect(res.status).toBe(201);
    const { body, subject } = await res.json() as { body: string; subject: string };
    expect(subject).toBe("Stock enquiry: 500,000 x Samsung 50E-equivalent 21700 cells");
    expect(body.startsWith("Hello,\n\nWe're looking for 500,000 x Samsung 50E-equivalent 21700 cells in Poland.")).toBe(true);
    expect(body).toContain("They're needed by 31 January 2027.");
    for (const leak of ["Battery Partners", "1.15", "EUR", "tbc"]) {
      expect(body).not.toContain(leak);
    }
  });
});
