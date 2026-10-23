import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./postgres", () => ({queryPg:vi.fn(async (sql: string, params?: unknown[]) => {
  const row = {owner_id:"user",creator_id:"user",origin:"crm",visibility:"team",version:1,deleted_at:null};
  if (sql.includes("jsonb_to_recordset")) {
    return sql.startsWith("select") ? JSON.parse(String(params?.[0])).map((identity: object) => ({...identity,...row})) : [];
  }
  return [row];
})}));
const actor = {id:"user",email:"ari@rebattery.io",displayName:"Synthetic owner"};
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { conversationKey, filterConversations, parseConversationKey } from "./hermes-conversations";
vi.mock("./workspace", () => ({ discoverWorkspaces: () => [{ name: "default" }, { name: "alpha" }] }));
vi.mock("./hermes-session-names", () => ({ sessionDisplayNames: vi.fn(async () => ({})) }));
import { sessionDisplayNames } from "./hermes-session-names";
vi.mock("./hermes-session-projects", () => ({ sessionProjectLabels: vi.fn(async () => ({})) }));
import { sessionProjectLabels } from "./hermes-session-projects";
vi.mock("./hermes-session-activity", () => ({ recentSessionActivity: vi.fn(async () => new Map()) }));
import { recentSessionActivity } from "./hermes-session-activity";
import { createConversation, groupRpc, inviteHandoff, inviteToConversation, listConversations, nativeFetch, readConversation, roomMembers } from "./hermes-native";
import { getHermesGatewayManager } from "./hermes-gateway/manager";
const room = { room_id: "room-1", name: "Alpha and Sol", updated_at: 100, members: [{ member_id: "m1", profile: "default", display_name: "Sol" }, { member_id: "m2", profile: "alpha", display_name: "Alpha" }] };
let server: WebSocketServer | undefined;
let handler: (method: string, params: Record<string, unknown>) => unknown;
async function startGateway() {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {throw new Error("No test port");}
  vi.stubEnv("HERMES_GATEWAY_WS_URL", `ws://127.0.0.1:${address.port}/api/ws`);
  vi.stubEnv("HERMES_GATEWAY_TOKEN", "synthetic-dashboard-token");
  server.on("connection", (socket, req) => {
    expect(new URL(req.url!, "http://localhost").searchParams.get("token")).toBe("synthetic-dashboard-token");
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "gateway.ready", params: {} }) + "\n");
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      const result = handler(request.method, request.params) as { __rpcError?: number } | undefined;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(result?.__rpcError ? { error: { code: result.__rpcError, message: "refused" } } : { result }) }) + "\n");
    });
  });
}
beforeEach(() => {
  vi.stubEnv("HERMES_API_BASE_URL", "http://synthetic.invalid");
  vi.stubEnv("HERMES_API_KEY", "synthetic-api-key");
  vi.stubEnv("HERMES_GATEWAY_WS_URL", ""); vi.stubEnv("HERMES_GATEWAY_TOKEN", "");
});
afterEach(async () => {
  if (server) { for (const client of server.clients) {client.terminate();} await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  vi.useRealTimers(); vi.restoreAllMocks();
});
it('bounds trace member history to one newest page and rejects cap overflow', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('/messages') ? Response.json({ data: Array.from({ length: 201 }, (_, id) => ({ id, role: 'user', content: 'synthetic', timestamp: 1 })) }) : Response.json({ id: 'synthetic', title: 'Test' }));
  vi.stubGlobal('fetch', fetch);
  await expect(readConversation(conversationKey('solo', 'synthetic', 'alpha'), 0, 200, actor)).rejects.toThrow('Trace probe cap exceeded');
  const pages = fetch.mock.calls.filter(([url]) => url.includes('/messages'));
  expect(pages).toHaveLength(1);
  expect(pages[0][0]).toContain('order=latest&limit=201&offset=0');
});
it("enriches only requested messaging IDs and uses the same name on deep-link readback", async () => {
  const lookup = vi.mocked(sessionDisplayNames);
  lookup.mockImplementation(async (profile, ids): Promise<Record<string, string>> => ids.includes("room") && profile === "alpha" ? { room: "Harbour / #stock" } : {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/messages") ? Response.json({ data: [] }) : url.includes("/api/sessions?") ? Response.json({ data: [{ id: "room", title: "Stored title", source: "discord", origin_json: "private", user_id: "private" }, { id: "plain", title: "Direct", source: "web" }] }) : Response.json({ session: { id: "room", title: "Stored title", source: "discord" } })));
  try {
    const listing = await listConversations(actor);
    expect(listing.sessions.find((row) => row.profile === "alpha" && row.id === "room")?.title).toBe("Harbour / #stock");
    expect(listing.sessions.find((row) => row.profile === "default" && row.id === "room")?.title).toBe("Stored title");
    expect(lookup).toHaveBeenCalledWith("alpha", ["room"]);
    expect(JSON.stringify(listing)).not.toContain("private");
    const detail = await readConversation(conversationKey("solo", "room", "alpha"), undefined, undefined, actor);
    expect(detail.conversation.title).toBe("Harbour / #stock");
  } finally { lookup.mockImplementation(async () => ({})); }
});
it.each(['queued', 'running', 'completed', 'failed', 'interrupted'])("reports %s children of an idle parent as background, never running", async status => {
  vi.stubEnv("HERMES_CHAT_TRANSPORT", "gateway");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2020, 0, 1, 0, 0, ['queued', 'running', 'completed', 'failed', 'interrupted'].indexOf(status) * 10));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "parent", title: "Solo" }] })));
  const manager = getHermesGatewayManager();
  const call = vi.spyOn(manager, "call").mockResolvedValue({ sessions: [{ id: "runtime", session_key: "parent", status: "idle" }] } as never);
  const attach = vi.spyOn(manager, "attachLive").mockResolvedValue({ running: false, subagents: [{ subagent_id: "child", status }] } as never);
  const requests = vi.spyOn(manager, "pendingRequests").mockReturnValue([]);
  try {
    const result = await listConversations(actor);
    expect(result.sessions.find(row => row.profile === "alpha")).toMatchObject({ working: false, background: ['queued', 'running'].includes(status) });
  } finally { call.mockRestore(); attach.mockRestore(); requests.mockRestore(); }
});
it("uses gateway status for hidden solo chats with profile-colliding stored ids", async () => {
  vi.stubEnv("HERMES_CHAT_TRANSPORT", "gateway");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "same", title: "Solo" }] })));
  const manager = getHermesGatewayManager();
  const call = vi.spyOn(manager, "call").mockResolvedValue({ sessions: [{ id: "runtime-alpha", session_key: "same", status: "waiting" }] } as never);
  const attach = vi.spyOn(manager, "attachLive").mockImplementation(async key => key.includes("alpha") ? { session_id: "runtime-alpha", session_key: "same", running: true, info: { lazy: true, cwd: "/workspace", branch: "", model: "test", skills: {}, tools: {} } } as never : undefined);
  const requests = vi.spyOn(manager, "pendingRequests").mockReturnValue([{ id: "srq", method: "clarify", params: {} }]);
  try {
    const result = await listConversations(actor);
    expect(result.sessions.find(row => row.profile === "alpha")).toMatchObject({ working: true, blocked: true });
    expect(result.sessions.find(row => row.profile === "default")).toMatchObject({ working: false, blocked: false });
    expect(call).toHaveBeenCalledTimes(1);
    call.mockRejectedValue(new Error("offline"));
    vi.advanceTimersByTime(5_001);
    const offline = await listConversations(actor);
    expect(offline.sessions.every(row => row.working === null)).toBe(true);
  } finally { call.mockRestore(); attach.mockRestore(); requests.mockRestore(); }
});
it("shares a short TTL status poll and caps parallel warm attachments", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.advanceTimersByTime(20_000);
  vi.stubEnv("HERMES_CHAT_TRANSPORT", "gateway");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: Array.from({ length: 20 }, (_, i) => ({ id: `session-${i}`, title: "Solo" })) })));
  const manager = getHermesGatewayManager();
  const call = vi.spyOn(manager, "call").mockResolvedValue({ sessions: Array.from({ length: 20 }, (_, i) => ({ id: `runtime-${i}`, session_key: `session-${i}`, status: "idle" })) } as never);
  let inFlight = 0, peak = 0;
  const attach = vi.spyOn(manager, "attachLive").mockImplementation(async (_key, id) => {
    peak = Math.max(peak, ++inFlight);
    await Promise.resolve(); await Promise.resolve();
    inFlight--;
    return { session_id: id, session_key: id.replace("runtime-", "session-"), running: false, info: { lazy: true } } as never;
  });
  vi.spyOn(manager, "pendingRequests").mockReturnValue([]);
  await Promise.all([listConversations(actor), listConversations(actor), listConversations(actor)]);
  expect(call).toHaveBeenCalledTimes(1);
  expect(attach).toHaveBeenCalledTimes(8);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  await listConversations(actor);
  expect(call).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5_001);
  await listConversations(actor);
  expect(call).toHaveBeenCalledTimes(2);
  expect(attach).toHaveBeenCalledTimes(16);
});
it("shows a CLI-agent session as working when the dashboard gateway has no live runtime for it", async () => {
  vi.stubEnv("HERMES_CHAT_TRANSPORT", "gateway");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.advanceTimersByTime(60_000);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "oneshot-live", title: "Spawned", source: "oneshot" }, { id: "idle", title: "Idle" }] })));
  const manager = getHermesGatewayManager();
  const call = vi.spyOn(manager, "call").mockResolvedValue({ sessions: [] } as never);
  vi.mocked(recentSessionActivity).mockImplementation(async (profile, ids) => new Map(profile === "alpha" ? ids.filter(id => id === "oneshot-live").map(id => [id, "working" as const]) : []));
  try {
    const result = await listConversations(actor);
    expect(result.sessions.find(row => row.profile === "alpha" && row.id === "oneshot-live")?.working).toBe(true);
    expect(result.sessions.find(row => row.profile === "alpha" && row.id === "idle")?.working).toBe(false);
    expect(result.sessions.find(row => row.profile === "default" && row.id === "oneshot-live")?.working).toBe(false);
    // An unreachable gateway leaves status unknown, but a fresh state.db heartbeat is still proof of work.
    call.mockRejectedValue(new Error("offline"));
    vi.advanceTimersByTime(5_001);
    const offline = await listConversations(actor);
    expect(offline.sessions.find(row => row.profile === "alpha" && row.id === "oneshot-live")?.working).toBe(true);
    expect(offline.sessions.find(row => row.profile === "alpha" && row.id === "idle")?.working).toBeNull();
  } finally { call.mockRestore(); vi.mocked(recentSessionActivity).mockImplementation(async () => new Map()); }
});
it("trusts gateway idle over a fresh heartbeat, and maps waiting past the attach cap to blocked", async () => {
  vi.stubEnv("HERMES_CHAT_TRANSPORT", "gateway");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.advanceTimersByTime(120_000);
  // Only alpha stores these ids, so each runtime has exactly one owning row.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ data: url.includes("/p/alpha/") ? Array.from({ length: 10 }, (_, i) => ({ id: `s-${i}`, title: "Solo" })) : [] })));
  const manager = getHermesGatewayManager();
  // s-0 just finished its turn; s-9 sits past the eight-attach cap waiting on a clarify.
  const call = vi.spyOn(manager, "call").mockResolvedValue({ sessions: Array.from({ length: 10 }, (_, i) => ({ id: `r-${i}`, session_key: `s-${i}`, status: i === 9 ? "waiting" : "idle" })) } as never);
  const attach = vi.spyOn(manager, "attachLive").mockImplementation(async (_key, id) => ({ session_id: id, running: false, subagents: [] }) as never);
  vi.spyOn(manager, "pendingRequests").mockReturnValue([]);
  vi.mocked(recentSessionActivity).mockImplementation(async (_profile, ids) => new Map(ids.map(id => [id, "working" as const])));
  try {
    const rows = (await listConversations(actor)).sessions;
    expect(rows).toHaveLength(10);
    expect(rows.find(row => row.id === "s-0")).toMatchObject({ working: false, blocked: false, background: false });
    expect(rows.filter(row => row.id !== "s-9").every(row => row.working === false && row.background !== true)).toBe(true);
    expect(rows.find(row => row.id === "s-9")).toMatchObject({ working: false, blocked: true, background: null });
    expect(attach).toHaveBeenCalledTimes(8);
  } finally { call.mockRestore(); attach.mockRestore(); vi.mocked(recentSessionActivity).mockImplementation(async () => new Map()); }
});
it("drops a refused runtime's status and keeps other rows when one attach throws", async () => {
  vi.stubEnv("HERMES_CHAT_TRANSPORT", "gateway");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.advanceTimersByTime(150_000);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ data: url.includes("/p/alpha/") ? [{ id: "foreign", title: "A" }, { id: "broken", title: "B" }, { id: "mine", title: "C" }] : [] })));
  const manager = getHermesGatewayManager();
  const call = vi.spyOn(manager, "call").mockResolvedValue({ sessions: [
    { id: "r-foreign", session_key: "foreign", status: "working" }, { id: "r-broken", session_key: "broken", status: "waiting" }, { id: "r-mine", session_key: "mine", status: "idle" },
  ] } as never);
  const attach = vi.spyOn(manager, "attachLive").mockImplementation(async (_key, id) => {
    if (id === "r-foreign") {return undefined;}
    if (id === "r-broken") {throw new Error("socket closed");}
    return { session_id: id, running: false, subagents: [{ subagent_id: "child", status: "running" }] } as never;
  });
  vi.spyOn(manager, "pendingRequests").mockReturnValue([]);
  try {
    const rows = (await listConversations(actor)).sessions;
    expect(rows.find(row => row.id === "foreign")).toMatchObject({ working: false, blocked: false });
    expect(rows.find(row => row.id === "broken")).toMatchObject({ working: false, blocked: true });
    expect(rows.find(row => row.id === "mine")).toMatchObject({ working: false, background: true });
  } finally { call.mockRestore(); attach.mockRestore(); }
});
it("shows a CLI session stamped only by its subagents as background", async () => {
  vi.stubEnv("HERMES_CHAT_TRANSPORT", "gateway");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.advanceTimersByTime(180_000);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "cli-parent", title: "Spawned" }] })));
  const manager = getHermesGatewayManager();
  const call = vi.spyOn(manager, "call").mockResolvedValue({ sessions: [] } as never);
  vi.mocked(recentSessionActivity).mockImplementation(async (profile, ids) => new Map(profile === "alpha" ? ids.map(id => [id, "background" as const]) : []));
  try {
    const row = (await listConversations(actor)).sessions.find(row => row.profile === "alpha" && row.id === "cli-parent");
    expect(row).toMatchObject({ working: false, background: true });
  } finally { call.mockRestore(); vi.mocked(recentSessionActivity).mockImplementation(async () => new Map()); }
});
describe("native Hermes conversations", () => {
  it("keeps profile-scoped identities stable and filtering never rewrites them", () => {
    const key = conversationKey("solo", "same/id", "alpha");
    expect(parseConversationKey(key)).toEqual({ kind: "solo", profile: "alpha", id: "same/id" });
    expect(key).not.toBe(conversationKey("solo", "same/id", "default"));
    expect(() => parseConversationKey("bogus")).toThrow();
  });
  it("lists the newest page per profile, hides execution sessions, and uses actual working not worker presence", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input); const alpha = url.pathname.includes("/alpha/");
      if (alpha) {return Response.json({ data: [{ id: "shared-id", title: "Alpha chat", started_at: 2, source: "webhook" }], has_more: false });}
      return Response.json({ data: [{ id: "shared-id", title: "Sol chat", last_active: 3, source: "cron" }, { id: "execution", source: "bot_room" }, { id: "hidden", hidden: true }, { id: "child", is_internal_child: true }], has_more: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    handler = (method, params) => method === "groups.list" ? { rooms: [room], next_offset: params.offset === 0 ? 100 : null } : { room, driver_status: { running: true, working: false, blocked: true } };
    await startGateway();
    const data = await listConversations(actor);
    expect(data.sessions).toHaveLength(3);
    expect(data.sessions.filter((r) => r.id === "shared-id")).toHaveLength(2);
    expect(data.sessions.find((r) => r.kind === "group")).toMatchObject({ working: false, blocked: true });
    expect(data.sessions.find((r) => r.kind === "solo")?.working).toBeNull();
    expect(data.sessions.find((r) => r.profile === "alpha")).toMatchObject({ source: "webhook" });
    expect(data.sessions.find((r) => r.profile === "default")).toMatchObject({ source: "cron" });
    expect(data.warnings).toEqual([]);
    expect(filterConversations(data.sessions, "alpha").map((r) => r.title)).toEqual(["Alpha and Sol", "Alpha chat"]);
    expect(fetchMock.mock.calls.every(([url]) => url.includes("limit=200&offset=0"))).toBe(true);
  });
  it("preserves older pinned backfill beyond the recent window and batches metadata reads", async () => {
    vi.stubEnv("HERMES_CHAT_TRANSPORT", "sse");
    const recent = Array.from({ length: 200 }, (_, index) => ({ id: `recent-${index}`, source: "discord", title: `Recent ${index}` }));
    const olderPin = { id: "older-pinned", source: "whatsapp", title: "Older pinned chat", pinned: true };
    vi.mocked(sessionDisplayNames).mockClear();
    vi.mocked(sessionProjectLabels).mockClear();
    vi.mocked(sessionProjectLabels).mockImplementation(async (profile, ids): Promise<Record<string, string>> => profile === "default" && ids.includes(olderPin.id) ? { [olderPin.id]: "Harbour" } : {});
    vi.stubGlobal("fetch", vi.fn(async (input: string) => Response.json({ data: input.includes("/alpha/") ? [] : [...recent, olderPin] })));
    const result = await listConversations(actor);
    expect(result.sessions).toHaveLength(201);
    expect(result.sessions.find((row) => row.id === olderPin.id)).toMatchObject({ profile: "default", title: olderPin.title, project: "Harbour" });
    expect(vi.mocked(sessionProjectLabels).mock.calls.filter(([profile]) => profile === "default").map(([, ids]) => ids.length)).toEqual([200, 1]);
    vi.mocked(sessionProjectLabels).mockImplementation(async () => ({}));
    const batches = vi.mocked(sessionDisplayNames).mock.calls.filter(([profile]) => profile === "default").map(([, ids]) => ids);
    expect(batches.map((ids) => ids.length)).toEqual([200, 1]);
    expect(batches.flat()).toContain(olderPin.id);
  });
  it("keeps other profiles' chats when one profile's sessions cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.includes("/alpha/") ? new Response("{}", { status: 401 }) : Response.json({ data: [{ id: "sol", title: "Sol chat" }] })));
    const result = await listConversations(actor);
    expect(result.sessions.map((r) => r.title)).toEqual(["Sol chat"]);
    expect(result.warnings).toContain("Could not load chats for alpha");
  });
  it("reports unavailable group transport without hiding solo chats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "solo" }], has_more: false })));
    const result = await listConversations(actor);
    expect(result.sessions).toHaveLength(2); expect(result.groupsAvailable).toBe(false);
    expect(result.warnings.join()).toContain("dashboard connection");
  });
  it("replays byte-limited native log pages using has_more on one gateway socket", async () => {
    const cursors: unknown[] = [];
    handler = (method, params) => {
      if (method === "groups.state") {return { room, driver_status: { running: true, working: false } };}
      cursors.push(params.since_seq);
      const seq = params.since_seq === 0 ? 1 : 2;
      return { events: [{ seq, event_id: `event-${seq}`, kind: "message.user", actor: { id: "user" }, payload: { text: `message ${seq}` } }], has_more: seq === 1 };
    };
    await startGateway();
    const detail = await readConversation(conversationKey("group", room.room_id), undefined, undefined, actor);
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
    const detail = await readConversation(conversationKey("solo", "rich", "alpha"), undefined, undefined, actor);
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]).toMatchObject({ content: "Looking", parts: [{ type: "reasoning", text: "Thinking" }, { type: "text", text: "Looking" }, { type: "tool-invocation", toolCallId: "call1", toolName: "terminal", args: { command: "fixture" }, result: "Tool result" }] });
    expect(detail.messages[0].parts?.[2]).not.toHaveProperty("state");
  });
  it("creates a solo only in its chosen profile and reads back the native record", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (init.method === "POST") {return Response.json({});}
      return Response.json({ session: { id: url.split("/").at(-1), title: "New alpha", started_at: 10 } });
    }));
    const result = await createConversation(["alpha"], undefined, actor);
    expect(result.profile).toBe("alpha"); expect(result.title).toBe("New alpha");
    expect(requests).toHaveLength(2); expect(requests.every((r) => r.url.includes("/p/alpha/api/sessions"))).toBe(true);
    expect(JSON.parse(requests[0].init.body as string)).toMatchObject({ source: "web" });
    await expect(createConversation(["missing"], undefined, actor)).rejects.toThrow("Unknown");
    await expect(createConversation(["alpha", "alpha"], undefined, actor)).rejects.toThrow("distinct");
  });
  it("uses the native groups.create/state roster contract and reads the room log with member identities", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    handler = (method, params) => {
      calls.push({ method, params });
      if (method === "groups.create") {return { room };}
      if (method === "groups.state") {return { room, driver_status: { working: true } };}
      return { events: [{ event_id: "user:1", seq: 1, kind: "message.user", actor: { id: "user" }, payload: { text: "hello" } }, { event_id: "answer:1", seq: 2, kind: "message.member", created_at: 42, actor: { id: "m2" }, payload: { text: "Alpha reply", member_id: "m2", task_id: "task1", turn_id: "turn1" } }, { event_id: "settle:1", seq: 3, kind: "turn.settled", created_at: 43, actor: { id: "gateway" }, payload: { member_id: "m2", task_id: "task1", turn_id: "turn1", passed: false } }] };
    };
    await startGateway();
    const created = await createConversation(["default", "alpha"], undefined, actor);
    expect(created.kind).toBe("group"); expect(created.participants.map((p) => p.profile)).toEqual(["default", "alpha"]);
    expect(calls[0]).toMatchObject({ method: "groups.create", params: { members: [{ profile: "default", member_id: "default", handle: "default", target: { kind: "local", profile: "default" } }, { profile: "alpha", member_id: "alpha", handle: "alpha", target: { kind: "local", profile: "alpha" } }] } });
    expect(calls[1].method).toBe("groups.state");
    const detail = await readConversation(conversationKey("group", room.room_id), undefined, undefined, actor);
    expect(detail.messages).toMatchObject([{ id: "user:1", role: "user", text: "hello", content: "hello", profile: undefined, name: undefined }, { id: "answer:1", role: "assistant", text: "Alpha reply", content: "Alpha reply", profile: "alpha", name: "Alpha", memberId: "m2" }]);
    expect(detail).toMatchObject({ members: room.members, driver: { working: true }, settled: [{ memberId: "m2", taskId: "task1", turnId: "turn1", passed: false, createdAt: 43000 }], cursor: 3, sinceSeq: 0 });
    expect(detail.messages[1]).toMatchObject({ memberId: "m2", taskId: "task1", turnId: "turn1", createdAt: 42000 });
    expect(detail.conversation.working).toBe(true);
  });
  it("reads all pages of native solo history without copying or rewriting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      if (!url.pathname.endsWith("/messages")) {return Response.json({ session: { id: "history", title: "History" } });}
      return Response.json({ data: url.searchParams.get("offset") === "0" ? Array.from({ length: 500 }, (_, i) => ({ id: i, role: "user", content: `line ${i}` })) : [{ id: 501, role: "assistant", content: [{ type: "text", text: "continued" }] }] });
    }));
    const detail = await readConversation(conversationKey("solo", "history", "alpha"), undefined, undefined, actor);
    expect(detail.messages).toHaveLength(501); expect(detail.messages.at(-1)?.text).toBe("continued");
  });
  it("reads a compacted session's summarized turns from the display history", async () => {
    // Hermes in-place compaction: active rows are the model's head+tail copies; the summarized
    // middle stays visible only in the display projection.
    const active = [{ id: 10, role: "user", content: "first" }, { id: 11, role: "assistant", content: "one" }, { id: 12, role: "assistant", display_kind: "hidden", content: "" }, { id: 13, role: "user", content: "latest" }, { id: 14, role: "assistant", content: "answer" }];
    const display = [active[0], active[1], { id: 3, role: "user", content: "middle" }, { id: 4, role: "assistant", content: "two" }, active[3], active[4]];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      if (!url.pathname.endsWith("/messages")) {return Response.json({ session: { id: "compacted", title: "Compacted" } });}
      return Response.json({ data: url.searchParams.get("include_compacted") === "true" ? display : active });
    }));
    const detail = await readConversation(conversationKey("solo", "compacted", "alpha"), undefined, undefined, actor);
    expect(detail.messages.map((m) => m.text)).toEqual(["first", "one", "middle", "two", "latest", "answer"]);
  });
  it("rejects unknown profiles before network access and protects gateway credentials", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(nativeFetch("../default", "/api/sessions")).rejects.toThrow("Unknown"); expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("HERMES_GATEWAY_WS_URL", "ws://unsafe.example/api/ws"); vi.stubEnv("HERMES_GATEWAY_TOKEN", "never-print-me");
    await expect(groupRpc("groups.list")).rejects.toThrow("TLS");
  });
});

describe("inviting an agent into a chat", () => {
  it("addresses members by profile name and falls back for names that cannot be mentions", () => {
    expect(roomMembers(["default", "matcha"]).map(m => m.handle)).toEqual(["default", "matcha"]);
    expect(roomMembers(["all", "my profile", "bot2"]).map(m => m.handle)).toEqual(["bot1", "bot2", "bot3"]);
  });
  it("hands the invitee a marker, a summary and a transcript pointer, with no live mentions", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", text: `line ${i} @default @all ${"x".repeat(2000)}`, content: "" }));
    const prompt = inviteHandoff("default", "matcha", { id: "s1", title: "Pricing" }, [...messages, { id: "tool", role: "tool", text: "ignored", content: "" }, { id: "blank", role: "user", text: "  ", content: "" }], "price the lot");
    expect(prompt.startsWith("[ROOM INVITE host=default session=s1 invitee=matcha]\n@matcha ")).toBe(true);
    expect(prompt.match(/@[A-Za-z0-9]/g)).toEqual(["@m"]);
    expect(prompt).toContain("The user asks you: price the lot");
    expect(prompt).toContain('session_search(session_id="s1", profile="default")');
    expect(prompt).toContain("Earlier chat: Pricing (30 messages)");
    expect(prompt).toContain("line 28 "); expect(prompt).toContain("line 29 "); expect(prompt).not.toContain("line 27 "); expect(prompt).not.toContain("ignored");
    expect(prompt.length).toBeLessThan(2_000);
    expect(inviteHandoff("default", "matcha", { id: "s1" }, [], "")).toContain("The earlier chat had no messages.");
  });
  it("creates a room for host and invitee, sends the handoff to the invitee, and removes the room if the send fails", async () => {
    const created = { room_id: "ignored", name: "x", updated_at: 1, members: [] };
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let failSend = false;
    handler = (method, params) => {
      calls.push({ method, params });
      if (method === "groups.send" && failSend) {return { __rpcError: 5112 };}
      if (method === "groups.create") {return { room: created };}
      if (method === "groups.state") {return { room: { ...created, room_id: params.room_id, name: "x", members: [{ member_id: "alpha", profile: "alpha" }, { member_id: "default", profile: "default" }] }, driver_status: { working: false } };}
      return {};
    };
    await startGateway();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/messages") ? Response.json({ data: [{ id: 1, role: "user", content: "Is the Panasonic lot priced?" }, { id: 2, role: "assistant", content: "Not yet." }], has_more: false }) : Response.json({ session: { id: "s1", title: "Pricing" } })));
    const room = await inviteToConversation(conversationKey("solo", "s1", "alpha"), "default", "take over pricing", actor);
    expect(room.kind).toBe("group");
    expect(calls.find(c => c.method === "groups.create")?.params).toMatchObject({ name: "Pricing · default", members: [{ handle: "alpha", profile: "alpha" }, { handle: "default", profile: "default" }] });
    const send = calls.find(c => c.method === "groups.send")!;
    expect(send.params).toMatchObject({ room_id: room.id, payload: { thread_id: room.id } });
    expect(String((send.params.payload as { text: string }).text)).toMatch(/^\[ROOM INVITE host=alpha session=s1 invitee=default\]\n@default .*Is the Panasonic lot priced\?.*Not yet\..*session_search\(session_id="s1", profile="alpha"\).*take over pricing/s);
    await expect(inviteToConversation(conversationKey("solo", "s1", "alpha"), "alpha", undefined, actor)).rejects.toThrow("different agent");
    await expect(inviteToConversation(conversationKey("group", "room-1"), "default", undefined, actor)).rejects.toThrow("one-to-one");
    failSend = true; calls.length = 0;
    await expect(inviteToConversation(conversationKey("solo", "s1", "alpha"), "default", undefined, actor)).rejects.toThrow();
    expect(calls.map(c => c.method)).toContain("groups.disband");
  });
});
