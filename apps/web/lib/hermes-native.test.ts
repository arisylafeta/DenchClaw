import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { conversationKey, filterConversations, parseConversationKey } from "./hermes-conversations";
vi.mock("./workspace", () => ({ discoverWorkspaces: () => [{ name: "default" }, { name: "alpha" }] }));
import { createConversation, groupRpc, listConversations, nativeFetch, readConversation } from "./hermes-native";
const room = { room_id: "room-1", name: "Alpha and Sol", updated_at: 100, members: [{ member_id: "m1", profile: "default", display_name: "Sol" }, { member_id: "m2", profile: "alpha", display_name: "Alpha" }] };
let server: WebSocketServer | undefined;
let handler: (method: string, params: Record<string, unknown>) => unknown;
async function startGateway() {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  vi.stubEnv("HERMES_GATEWAY_WS_URL", `ws://127.0.0.1:${address.port}/api/ws`);
  vi.stubEnv("HERMES_GATEWAY_TOKEN", "synthetic-dashboard-token");
  server.on("connection", (socket, req) => {
    expect(new URL(req.url!, "http://localhost").searchParams.get("token")).toBe("synthetic-dashboard-token");
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "gateway.ready", params: {} }) + "\n");
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      const result = handler(request.method, request.params);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    });
  });
}
beforeEach(() => {
  vi.stubEnv("HERMES_API_BASE_URL", "http://synthetic.invalid");
  vi.stubEnv("HERMES_API_KEY", "synthetic-api-key");
  vi.stubEnv("HERMES_GATEWAY_WS_URL", ""); vi.stubEnv("HERMES_GATEWAY_TOKEN", "");
});
afterEach(async () => {
  if (server) { for (const client of server.clients) client.terminate(); await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
describe("native Hermes conversations", () => {
  it("keeps profile-scoped identities stable and filtering never rewrites them", () => {
    const key = conversationKey("solo", "same/id", "alpha");
    expect(parseConversationKey(key)).toEqual({ kind: "solo", profile: "alpha", id: "same/id" });
    expect(key).not.toBe(conversationKey("solo", "same/id", "default"));
    expect(() => parseConversationKey("bogus")).toThrow();
  });
  it("paginates all profiles, deduplicates pins and rooms, hides execution sessions, and uses actual working not worker presence", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input); const alpha = url.pathname.includes("/alpha/");
      if (alpha) return Response.json({ data: [{ id: "shared-id", title: "Alpha chat", started_at: 2 }], has_more: false });
      const offset = url.searchParams.get("offset");
      return Response.json({ data: offset === "0" ? [{ id: "shared-id", title: "Sol chat", last_active: 3 }, { id: "execution", source: "bot_room" }, { id: "hidden", hidden: true }, { id: "child", is_internal_child: true }] : [{ id: "shared-id", title: "Sol chat", last_active: 3 }, { id: "older", started_at: 1 }], has_more: offset === "0" });
    });
    vi.stubGlobal("fetch", fetchMock);
    handler = (method, params) => method === "groups.list" ? { rooms: [room], next_offset: params.offset === 0 ? 100 : null } : { room, driver_status: { running: true, working: false } };
    await startGateway();
    const data = await listConversations();
    expect(data.sessions).toHaveLength(4);
    expect(data.sessions.filter((r) => r.id === "shared-id")).toHaveLength(2);
    expect(data.sessions.find((r) => r.kind === "group")?.working).toBe(false);
    expect(data.sessions.find((r) => r.kind === "solo")?.working).toBeNull();
    expect(data.warnings).toEqual([]);
    expect(filterConversations(data.sessions, "alpha").map((r) => r.title)).toEqual(["Alpha and Sol", "Alpha chat"]);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("offset=200"))).toBe(true);
  });
  it("reports unavailable group transport without hiding solo chats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "solo" }], has_more: false })));
    const result = await listConversations();
    expect(result.sessions).toHaveLength(2); expect(result.groupsAvailable).toBe(false);
    expect(result.warnings.join()).toContain("dashboard connection");
  });
  it("replays byte-limited native log pages using has_more on one gateway socket", async () => {
    const cursors: unknown[] = [];
    handler = (method, params) => {
      if (method === "groups.state") return { room, driver_status: { running: true, working: false } };
      cursors.push(params.since_seq);
      const seq = params.since_seq === 0 ? 1 : 2;
      return { events: [{ seq, event_id: `event-${seq}`, kind: "message.user", actor: { id: "user" }, payload: { text: `message ${seq}` } }], has_more: seq === 1 };
    };
    await startGateway();
    const detail = await readConversation(conversationKey("group", room.room_id));
    expect(detail.messages.map((m) => m.text)).toEqual(["message 1", "message 2"]);
    expect(cursors).toEqual([0, 1]); expect(server!.clients.size).toBe(1);
  });
  it("projects native reasoning and tool results into the existing rich message format", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/messages") ? Response.json({ data: [
      { id: "assistant", role: "assistant", content: "Looking", reasoning_content: "Thinking", tool_calls: [{ id: "call1", function: { name: "terminal", arguments: '{"command":"fixture"}' } }] },
      { id: "tool", role: "tool", tool_call_id: "call1", content: "Tool result" },
      { id: "handoff", role: "assistant", display_kind: "hidden", content: "" },
      { id: "diagnostic", role: "user", display_kind: "hidden", content: "" },
      { id: "answer", role: "assistant", content: "Done" },
    ] }) : Response.json({ session: { id: "rich", title: "Rich fixture" } })));
    const detail = await readConversation(conversationKey("solo", "rich", "alpha"));
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]).toMatchObject({ content: "Looking", parts: [{ type: "reasoning", text: "Thinking" }, { type: "text", text: "Looking" }, { type: "tool-invocation", toolCallId: "call1", toolName: "terminal", args: { command: "fixture" }, result: "Tool result" }] });
    expect(detail.messages[0].parts?.[2]).not.toHaveProperty("state");
  });
  it("creates a solo only in its chosen profile and reads back the native record", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (init.method === "POST") return Response.json({});
      return Response.json({ session: { id: url.split("/").at(-1), title: "New alpha", started_at: 10 } });
    }));
    const result = await createConversation(["alpha"]);
    expect(result.profile).toBe("alpha"); expect(result.title).toBe("New alpha");
    expect(requests).toHaveLength(2); expect(requests.every((r) => r.url.includes("/p/alpha/api/sessions"))).toBe(true);
    expect(JSON.parse(requests[0].init.body as string)).toMatchObject({ source: "web" });
    await expect(createConversation(["missing"])).rejects.toThrow("Unknown");
    await expect(createConversation(["alpha", "alpha"])).rejects.toThrow("distinct");
  });
  it("uses the native groups.create/state roster contract and reads the room log with member identities", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    handler = (method, params) => {
      calls.push({ method, params });
      if (method === "groups.create") return { room };
      if (method === "groups.state") return { room, driver_status: { working: true } };
      return { events: [{ event_id: "user:1", seq: 1, kind: "message.user", actor: { id: "user" }, payload: { text: "hello" } }, { event_id: "answer:1", seq: 2, kind: "message.member", actor: { id: "m2" }, payload: { text: "Alpha reply" } }] };
    };
    await startGateway();
    const created = await createConversation(["default", "alpha"]);
    expect(created.kind).toBe("group"); expect(created.participants.map((p) => p.profile)).toEqual(["default", "alpha"]);
    expect(calls[0]).toMatchObject({ method: "groups.create", params: { members: [{ profile: "default", member_id: "bot-1", handle: "bot1", target: { kind: "local", profile: "default" } }, { profile: "alpha", member_id: "bot-2", handle: "bot2", target: { kind: "local", profile: "alpha" } }] } });
    expect(calls[1].method).toBe("groups.state");
    const detail = await readConversation(conversationKey("group", room.room_id));
    expect(detail.messages).toEqual([{ id: "user:1", role: "user", text: "hello", profile: undefined, name: undefined }, { id: "answer:1", role: "assistant", text: "Alpha reply", profile: "alpha", name: "Alpha" }]);
    expect(detail.conversation.working).toBe(true);
  });
  it("reads all pages of native solo history without copying or rewriting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      if (!url.pathname.endsWith("/messages")) return Response.json({ session: { id: "history", title: "History" } });
      return Response.json({ data: url.searchParams.get("offset") === "0" ? Array.from({ length: 500 }, (_, i) => ({ id: i, role: "user", content: `line ${i}` })) : [{ id: 501, role: "assistant", content: [{ type: "text", text: "continued" }] }] });
    }));
    const detail = await readConversation(conversationKey("solo", "history", "alpha"));
    expect(detail.messages).toHaveLength(501); expect(detail.messages.at(-1)?.text).toBe("continued");
  });
  it("rejects unknown profiles before network access and protects gateway credentials", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(nativeFetch("../default", "/api/sessions")).rejects.toThrow("Unknown"); expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("HERMES_GATEWAY_WS_URL", "ws://unsafe.example/api/ws"); vi.stubEnv("HERMES_GATEWAY_TOKEN", "never-print-me");
    await expect(groupRpc("groups.list")).rejects.toThrow("TLS");
  });
});
