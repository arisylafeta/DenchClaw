import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(), user: vi.fn(), listing: vi.fn(), pins: vi.fn(), save: vi.fn(), read: vi.fn(), gateway: vi.fn(), pending: vi.fn(), authorize: vi.fn(), share: vi.fn(), sse: vi.fn(), transport: vi.fn(),
}));
vi.mock("@/lib/bulk-trades-route", () => ({ guardBulkTrades: mocks.guard, notFound: (what: string) => Response.json({ error: `${what} not found` }, { status: 404 }) }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/agent-backend", () => ({ resolveAgentBackend: () => "hermes" }));
vi.mock("@/lib/conversation-access", () => ({ accessErrorResponse: () => Response.json({ error: "denied" }, { status: 404 }), changeSharing: mocks.share }));
vi.mock("@/lib/crm-postgres/bulk-listings", () => ({ getListing: mocks.listing }));
vi.mock("@/lib/crm-postgres/bulk-listing-chats", () => ({ listingChatPins: mocks.pins, saveListingChat: mocks.save }));
vi.mock("@/lib/hermes-native", () => ({ readConversation: mocks.read, createConversation: mocks.sse, authorizeNativeConversation: mocks.authorize }));
vi.mock("@/lib/hermes-gateway/chat-service", () => ({ createGatewayConversation: mocks.gateway, pendingGatewayConversation: mocks.pending }));
vi.mock("@/lib/hermes-gateway/transport-flag", () => ({ hermesChatTransport: mocks.transport }));

import { POST, PUT } from "./route";
const call = () => POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "btd_1" }) });
const team = { visibility: "team", canShare: false };
const priv = { visibility: "private", canShare: true };

describe("POST /api/bulk-listings/[id]/matcha-chat", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.guard.mockResolvedValue({ userId: "u1", email: "a@b.c" });
    mocks.user.mockResolvedValue({ id: "u1", email: "a@b.c" });
    mocks.listing.mockResolvedValue({ id: "btd_1" });
    mocks.transport.mockReturnValue("gateway");
    mocks.pins.mockResolvedValue([]);
    mocks.gateway.mockResolvedValue({ key: "solo:matcha:new" });
    mocks.share.mockResolvedValue(team);
    mocks.authorize.mockResolvedValue({ access: team });
  });

  it("creates a team-shared Matcha conversation and pins it", async () => {
    const res = await call();
    expect(res.status).toBe(201);
    expect(mocks.gateway).toHaveBeenCalledWith(["matcha"], expect.objectContaining({ id: "u1" }));
    expect(mocks.share).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }), "solo:matcha:new", "team");
    expect(mocks.save).toHaveBeenCalledWith("btd_1", "u1", "solo:matcha:new");
    expect(await res.json()).toMatchObject({ conversation: { key: "solo:matcha:new", access: team }, transport: "gateway" });
  });

  it("sends everyone to the same shared chat, even one a colleague pinned", async () => {
    mocks.pins.mockResolvedValue([{ key: "solo:matcha:theirs", userId: "u2" }]);
    mocks.read.mockResolvedValue({ conversation: { key: "solo:matcha:theirs" } });
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect((await res.json()).conversation.key).toBe("solo:matcha:theirs");
  });

  it("prefers a team chat over the user's own older private pin", async () => {
    mocks.pins.mockResolvedValue([{ key: "solo:matcha:mine", userId: "u1" }, { key: "solo:matcha:shared", userId: "u2" }]);
    mocks.authorize.mockImplementation(async (_a: unknown, key: string) => ({ access: key.endsWith("mine") ? priv : team }));
    mocks.read.mockImplementation(async (key: string) => ({ conversation: { key } }));
    expect((await (await call()).json()).conversation.key).toBe("solo:matcha:shared");
  });

  it("skips a private chat of someone else", async () => {
    mocks.pins.mockResolvedValue([{ key: "solo:matcha:secret", userId: "u2" }]);
    mocks.authorize.mockRejectedValue(new Error("not_found"));
    expect((await call()).status).toBe(201);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("reopens a pinned chat that Hermes has not stored yet (nothing sent in it)", async () => {
    mocks.pins.mockResolvedValue([{ key: "solo:matcha:empty", userId: "u1" }]);
    mocks.pending.mockReturnValue({ key: "solo:matcha:empty" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect((await res.json()).conversation).toMatchObject({ key: "solo:matcha:empty", access: team });
  });

  it("replaces a pinned conversation that can no longer be read", async () => {
    mocks.pins.mockResolvedValue([{ key: "solo:matcha:gone", userId: "u1" }]);
    mocks.read.mockRejectedValue(new Error("not_found"));
    const res = await call();
    expect(res.status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith("btd_1", "u1", "solo:matcha:new");
  });

  it("404s for an unknown listing", async () => {
    mocks.listing.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  describe("PUT", () => {
    const key = "%5B%22solo%22%2C%22matcha%22%2C%22n1%22%5D";
    const put = (k: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ key: k }) }), { params: Promise.resolve({ id: "btd_1" }) });
    it("re-pins the listing to a new chat and shares it", async () => {
      mocks.authorize.mockResolvedValue({ access: priv });
      expect((await put(key)).status).toBe(200);
      expect(mocks.share).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }), key, "team");
      expect(mocks.save).toHaveBeenCalledWith("btd_1", "u1", key);
    });
    it("leaves a chat that is already shared alone", async () => {
      expect((await put(key)).status).toBe(200);
      expect(mocks.share).not.toHaveBeenCalled();
    });
    it("rejects a chat of another bot", async () => {
      expect((await put("%5B%22solo%22%2C%22orchas%22%2C%22n1%22%5D")).status).toBe(400);
      expect(mocks.save).not.toHaveBeenCalled();
    });
  });
});
