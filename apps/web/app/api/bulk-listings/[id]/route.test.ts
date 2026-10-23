import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), get: vi.fn(), view: vi.fn(), fields: vi.fn(), offers: vi.fn(), add: vi.fn(), conversation: vi.fn(), buyer: vi.fn(), mail: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/crm-postgres/bulk-listings", () => ({ getListing: mocks.get, listingView: mocks.view }));
vi.mock("@/lib/crm-postgres/bulk-trade-details", () => ({ listingFields: mocks.fields }));
vi.mock("@/lib/crm-postgres/bulk-offers", async (original) => ({ ...await original(), listOffers: mocks.offers, addOffer: mocks.add }));
vi.mock("@/lib/crm-postgres/bulk-thread-links", () => ({ listingConversation: mocks.conversation }));
vi.mock("@/lib/crm-postgres/company-profile", () => ({ getBuyer: mocks.buyer }));
vi.mock("@/lib/crm-postgres/demand-context", () => ({ buyerMail: mocks.mail }));
vi.mock("@/lib/postgres", () => ({ queryPg: mocks.query }));
import { GET } from "./route";
import { GET as fields } from "./fields/route";
import { GET as offers, POST } from "./offers/route";
import { GET as conversation } from "./conversation/route";
import { GET as context } from "./context/route";
const req = new Request("http://localhost/listing");
const params = { params: Promise.resolve({ id: "supply-1" }) };

describe("listing routes", () => {
  beforeEach(() => {
    process.env.CRM_DB_BACKEND = "postgres";
    mocks.user.mockResolvedValue({ id: "user" });
    mocks.get.mockResolvedValue({ id: "supply-1", kind: "supply", company_id: "seller", email: "seller@test", person_id: "person" });
    mocks.view.mockResolvedValue({ id: "supply-1", kind: "supply", is_trade: false });
    mocks.fields.mockResolvedValue([]); mocks.offers.mockResolvedValue([]); mocks.mail.mockResolvedValue([]);
    mocks.conversation.mockResolvedValue(null); mocks.query.mockResolvedValue([]);
  });
  afterEach(() => { vi.resetAllMocks(); delete process.env.CRM_DB_BACKEND; });
  it("guards every read before querying", async () => {
    mocks.user.mockResolvedValue(null);
    for (const handler of [GET, fields, offers, conversation, context]) expect((await handler(req, params)).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.view).not.toHaveBeenCalled();
  });
  it("serves supply listing, fields, offers and conversation without a demand row", async () => {
    expect(await (await GET(req, params)).json()).toEqual({ listing: { id: "supply-1", kind: "supply", is_trade: false } });
    expect(await (await fields(req, params)).json()).toEqual({ fields: [] });
    expect(await (await offers(req, params)).json()).toEqual({ offers: [] });
    expect(await (await conversation(req, params)).json()).toEqual({ conversation: null });
    expect(mocks.conversation).toHaveBeenCalledWith("supply-1", "user");
  });
  it("returns 404 for missing listings", async () => {
    mocks.get.mockResolvedValue(null); mocks.view.mockResolvedValue(null);
    for (const handler of [GET, fields, offers, conversation, context]) expect((await handler(req, params)).status).toBe(404);
  });
  it("creates a supply offer and validates its stage", async () => {
    mocks.add.mockResolvedValue({ id: "offer" });
    const post = (body: unknown) => POST(new Request(req, { method: "POST", body: JSON.stringify(body) }), params);
    expect((await post({ name: "Buyer", stage: "invalid" })).status).toBe(400);
    expect((await post({ name: "Buyer", stage: "contract_out" })).status).toBe(201);
    expect(mocks.add).toHaveBeenCalledWith("supply-1", expect.objectContaining({ name: "Buyer", stage: "contract_out" }));
  });
  it("uses the seller's mailbox context without a buyer profile", async () => {
    expect(await (await context(req, params)).json()).toEqual({ buyer: null, mail: [], person: null });
    expect(mocks.buyer).not.toHaveBeenCalled();
    expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({ company_id: "seller" }), "user");
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), ["person", "seller@test"]);
  });
  it("preserves buyer profiles for demand context", async () => {
    mocks.get.mockResolvedValue({ kind: "demand", company_id: "buyer", person_id: null, email: "buyer@test" });
    mocks.buyer.mockResolvedValue({ id: "buyer" });
    expect(await (await context(req, params)).json()).toEqual({ buyer: { id: "buyer" }, mail: [], person: null });
    expect(mocks.buyer).toHaveBeenCalledWith("buyer");
  });
});
