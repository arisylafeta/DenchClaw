import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WhatsappModule from "@/lib/crm-postgres/whatsapp";
import { GET as contextGet } from "./route";
import { GET as threadGet } from "./threads/[id]/route";
import { POST as identityPost } from "./identities/route";
const { user, context, conversation, decide } = vi.hoisted(() => ({ user: vi.fn(), context: vi.fn(), conversation: vi.fn(), decide: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser: user }));
vi.mock("@/lib/postgres", () => ({ queryPg: vi.fn() }));
vi.mock("@/lib/crm-postgres/whatsapp", async (original) => ({ ...await original<typeof WhatsappModule>(), whatsappThreads: context, whatsappConversation: conversation, decideWhatsappIdentity: decide }));
beforeEach(() => { vi.resetAllMocks(); });
describe("WhatsApp API boundaries", () => {
  it("rejects anonymous context, conversation and identity writes before database access", async () => {
    user.mockResolvedValue(null);
    expect((await contextGet(new Request("http://localhost/api/whatsapp?personId=p"))).status).toBe(401);
    expect((await threadGet(new Request("http://localhost/api/whatsapp/threads/t"), { params: Promise.resolve({ id: "t" }) })).status).toBe(401);
    expect((await identityPost(new Request("http://localhost/api/whatsapp/identities", { method: "POST", body: "{}" }))).status).toBe(401);
    expect(context).not.toHaveBeenCalled(); expect(conversation).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
  });
  it("passes canonical IDs and bounded paging through the same context reader", async () => {
    user.mockResolvedValue({ id: "operator" }); context.mockResolvedValue({ threads: [] });
    expect((await contextGet(new Request("http://localhost/api/whatsapp?personId=p&limit=20&offset=40"))).status).toBe(200);
    expect(context).toHaveBeenCalledWith({ personId: "p", companyId: undefined, tradeId: undefined }, 20, 40);
  });
  it("returns 404 for an unavailable canonical chat", async () => {
    user.mockResolvedValue({ id: "operator" }); conversation.mockResolvedValue(null);
    expect((await threadGet(new Request("http://localhost/api/whatsapp/threads/t"), { params: Promise.resolve({ id: "t" }) })).status).toBe(404);
  });
  it("rejects malformed confirmation fields without writing", async () => {
    user.mockResolvedValue({ id: "operator" });
    expect((await identityPost(new Request("http://localhost/api/whatsapp/identities", { method: "POST", body: JSON.stringify({ identityId: "identity", personId: 42 }) }))).status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });
  it("preserves operator provenance for manual decisions and exposes conflicts", async () => {
    user.mockResolvedValue({ id: "operator" }); decide.mockRejectedValue(new Error("identity_already_linked"));
    const response = await identityPost(new Request("http://localhost/api/whatsapp/identities", { method: "POST", body: JSON.stringify({ identityId: "identity", personId: "person" }) }));
    expect(response.status).toBe(409); expect(decide).toHaveBeenCalledWith("identity", { identityId: "identity", personId: "person" }, "operator");
  });
});
