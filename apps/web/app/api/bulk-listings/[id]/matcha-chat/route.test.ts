import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(), user: vi.fn(), listing: vi.fn(), saved: vi.fn(), save: vi.fn(), read: vi.fn(), gateway: vi.fn(), sse: vi.fn(), transport: vi.fn(),
}));
vi.mock("@/lib/bulk-trades-route", () => ({ guardBulkTrades: mocks.guard, notFound: (what: string) => Response.json({ error: `${what} not found` }, { status: 404 }) }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/agent-backend", () => ({ resolveAgentBackend: () => "hermes" }));
vi.mock("@/lib/conversation-access", () => ({ accessErrorResponse: () => Response.json({ error: "denied" }, { status: 404 }) }));
vi.mock("@/lib/crm-postgres/bulk-listings", () => ({ getListing: mocks.listing }));
vi.mock("@/lib/crm-postgres/bulk-listing-chats", () => ({ savedListingChat: mocks.saved, saveListingChat: mocks.save }));
vi.mock("@/lib/hermes-native", () => ({ readConversation: mocks.read, createConversation: mocks.sse }));
vi.mock("@/lib/hermes-gateway/chat-service", () => ({ createGatewayConversation: mocks.gateway }));
vi.mock("@/lib/hermes-gateway/transport-flag", () => ({ hermesChatTransport: mocks.transport }));

import { POST } from "./route";
const call = () => POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "btd_1" }) });

describe("POST /api/bulk-listings/[id]/matcha-chat", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.guard.mockResolvedValue({ userId: "u1", email: "a@b.c" });
    mocks.user.mockResolvedValue({ id: "u1", email: "a@b.c" });
    mocks.listing.mockResolvedValue({ id: "btd_1" });
    mocks.transport.mockReturnValue("gateway");
    mocks.gateway.mockResolvedValue({ key: "solo:matcha:new" });
  });

  it("creates a Matcha conversation and remembers it", async () => {
    mocks.saved.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(201);
    expect(mocks.gateway).toHaveBeenCalledWith(["matcha"], expect.objectContaining({ id: "u1" }));
    expect(mocks.save).toHaveBeenCalledWith("btd_1", "u1", "solo:matcha:new");
    expect(await res.json()).toMatchObject({ conversation: { key: "solo:matcha:new" }, transport: "gateway" });
  });

  it("reopens the saved conversation instead of creating another", async () => {
    mocks.saved.mockResolvedValue("solo:matcha:old");
    mocks.read.mockResolvedValue({ conversation: { key: "solo:matcha:old" } });
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect((await res.json()).conversation.key).toBe("solo:matcha:old");
  });

  it("replaces a saved conversation that can no longer be read", async () => {
    mocks.saved.mockResolvedValue("solo:matcha:gone");
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
});
