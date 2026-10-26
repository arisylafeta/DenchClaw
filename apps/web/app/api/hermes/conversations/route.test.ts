import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({currentUser:async () => ({id:"user",email:"ari@rebattery.io",displayName:"User"}),ALLOWED_EMAILS:new Set(["ari@rebattery.io"])}));
vi.mock("@/lib/postgres", () => ({queryPg:vi.fn(async () => [{owner_id:"user",creator_id:"user",origin:"crm",visibility:"team",version:1,deleted_at:null}])}));
import { queryPg } from "@/lib/postgres";
import { conversationKey } from "@/lib/hermes-conversations";
const native = vi.hoisted(() => ({ authorizeNativeConversation:vi.fn(async () => ({access:{visibility:"team"},version:1})), assertProfile: vi.fn(() => ({ workspaceDir: "/fixtures/alpha" })), createConversation: vi.fn(), listConversations: vi.fn(), readConversation: vi.fn(), nativeFetch: vi.fn(), groupRpc: vi.fn() }));
vi.mock("@/lib/hermes-native", () => native);
import { GET, POST } from "./route";
import { GET as detailGET, POST as detailPOST, PATCH, DELETE } from "./[key]/route";
const request = (body: unknown) => new Request("http://localhost/api/hermes/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.stubEnv("DENCH_AGENT_BACKEND", "hermes"); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());
describe("Hermes conversation routes", () => {
  it("leaves legacy mode alone and never touches Hermes", async () => {
    vi.stubEnv("DENCH_AGENT_BACKEND", "openclaw");
    expect(await (await GET(new Request("http://localhost/api/hermes/conversations"))).json()).toEqual({ backend: "openclaw" });
    expect((await POST(request({ profiles: ["alpha"] }))).status).toBe(404);
    expect(native.listConversations).not.toHaveBeenCalled(); expect(native.createConversation).not.toHaveBeenCalled();
  });

  it("leaves solo sending on the existing authenticated chat route", async () => {
    const key = conversationKey("solo", "existing-session", "alpha");
    const response = await detailPOST(request({ message: "continue" }), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(405);
    expect(native.nativeFetch).not.toHaveBeenCalled(); expect(native.createConversation).not.toHaveBeenCalled();
  });
  it("sends an idempotent native user event to one shared room and reads back history", async () => {
    const key = conversationKey("group", "shared-room");
    native.groupRpc.mockResolvedValue({ accepted: true }); native.readConversation.mockResolvedValue({ messages: [{ text: "persisted" }] });
    const response = await detailPOST(request({ message: "continue group", eventId: "stable-id", profile: "other" }), { params: Promise.resolve({ key }) });
    expect(native.groupRpc).toHaveBeenCalledWith("groups.send", { room_id: "shared-room", event_id: "stable-id", payload: { text: "continue group", thread_id: "shared-room" } });
    expect(response.status).toBe(200);
  });
  it.each(["a".repeat(65_537), "🔋".repeat(16_385)])("rejects text over the native UTF-8 byte limit before sending", async (message) => {
    const key = conversationKey("group", "shared-room");
    const response = await detailPOST(request({ message, eventId: "stable-id" }), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(400);
    expect(native.groupRpc).not.toHaveBeenCalled();
  });
  it("refuses ambiguous group sends and malformed identities before upstream writes", async () => {
    const context = { params: Promise.resolve({ key: conversationKey("group", "shared-room") }) };
    expect((await detailPOST(request({ message: "no event id" }), context)).status).toBe(400);
    expect((await detailPOST(request({ message: "hello", eventId: "valid" }), { params: Promise.resolve({ key: "invalid" }) })).status).toBe(502);
    expect(native.groupRpc).not.toHaveBeenCalled(); expect(native.nativeFetch).not.toHaveBeenCalled();
  });
  it("keeps rename and deletion profile-scoped and verifies the exact native target", async () => {
    const key = conversationKey("solo", "native-existing", "alpha");
    const context = { params: Promise.resolve({ key }) };
    native.nativeFetch.mockResolvedValue(Response.json({})); native.readConversation.mockResolvedValue({ conversation: { title: "Renamed" } });
    expect((await PATCH(request({ title: "Renamed" }), context)).status).toBe(200);
    expect(native.nativeFetch).toHaveBeenCalledWith("alpha", "/api/sessions/native-existing", { method: "PATCH", body: JSON.stringify({ title: "Renamed" }) });
    native.nativeFetch.mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await DELETE(new Request("http://localhost"), context)).status).toBe(200);
    expect(native.nativeFetch).toHaveBeenLastCalledWith("alpha", "/api/sessions/native-existing", {}, [404]);
    native.nativeFetch.mockResolvedValue(Response.json({}));
    expect((await DELETE(new Request("http://localhost"), context)).status).toBe(502);
  });
  it("tombstones owned groups before disband and verifies absence from the native room list",async()=>{
    const key=conversationKey("group","owned-group");
    native.groupRpc.mockResolvedValueOnce({}).mockResolvedValueOnce({rooms:[],next_offset:null});
    const response=await DELETE(new Request("http://local"),{params:Promise.resolve({key})});
    expect(response.status).toBe(200);expect(await response.json()).toEqual({deleted:"owned-group"});
    const index=vi.mocked(queryPg).mock.calls.findIndex(([sql])=>sql.includes("set deleted_at=now()"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(queryPg).mock.invocationCallOrder[index]).toBeLessThan(native.groupRpc.mock.invocationCallOrder[0]);
    expect(native.groupRpc.mock.calls).toEqual([["groups.disband",{room_id:"owned-group"}],["groups.list",{limit:100,offset:0}]]);
  });
  it("does not claim group deletion when the native room still exists",async()=>{
    const key=conversationKey("group","still-present");
    native.groupRpc.mockResolvedValueOnce({}).mockResolvedValueOnce({rooms:[{room_id:"still-present"}],next_offset:null});
    expect((await DELETE(new Request("http://local"),{params:Promise.resolve({key})})).status).toBe(502);
  });
  it("stops via the native room service and exposes readback failures rather than claiming success", async () => {
    const key = conversationKey("group", "room");
    native.groupRpc.mockResolvedValue({ cancelled: 1 }); native.readConversation.mockRejectedValue(new Error("synthetic read failure"));
    const response = await detailPOST(request({ action: "stop", eventId: "stop-1" }), { params: Promise.resolve({ key }) });
    expect(native.groupRpc).toHaveBeenCalledWith("groups.stop", { room_id: "room", cancel_id: "stop-1" });
    expect(response.status).toBe(502); expect((await response.json()).error).toBe("hermes_request_failed");
    expect((await detailGET(new Request("http://localhost"), { params: Promise.resolve({ key }) })).status).toBe(502);
  });
});
