import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ ALLOWED_EMAILS:new Set(["user@example.com"]), currentUser: vi.fn(async () => ({ id: "user",email:"user@example.com",displayName:"User" })), sessionRevalidator:async () => async () => ({id:"user",email:"user@example.com",displayName:"User"}) }));
vi.mock("@/lib/postgres", () => ({queryPg:vi.fn(async () => [{owner_id:"user",creator_id:"user",origin:"crm",visibility:"team",version:1,deleted_at:null}])}));
const actor={id:"user",email:"user@example.com",displayName:"User"};
vi.mock("@/lib/agent-backend", () => ({ resolveAgentBackend: () => "hermes" }));
vi.mock("@/lib/hermes-native", () => ({ authorizeNativeConversation:vi.fn(async () => ({access:{visibility:"team"},version:1})), assertProfile: vi.fn(), nativeFetch: vi.fn(), readConversation: vi.fn(), soloConversation: vi.fn() }));
vi.mock("@/lib/hermes-gateway/manager", () => ({ getHermesGatewayManager: vi.fn(() => ({ onServerRequest: vi.fn(), subscribeNotices: () => () => {}, connectionState: () => "connected" })) }));
import { currentUser, type AuthenticatedUser } from "@/lib/auth";
import { ChatServiceError, HermesChatService, type GatewayChatSnapshot } from "@/lib/hermes-gateway/chat-service";
import { conversationKey } from "@/lib/hermes-conversations";
import { EventConnection, eventConnections } from "./registry";
import type { GatewayNotice } from "@/lib/hermes-gateway/manager";
import { GET } from "./route";
import { POST as subscribe } from "./subscriptions/route";
import { POST as prompt } from "../conversations/[key]/prompt/route";
vi.mock("@/lib/hermes-client", () => ({ stopNativeHermesStream: vi.fn() }));
const key = conversationKey("solo", "one", "ari");
const other = conversationKey("solo", "two", "ari");
function fixture(truncated = false) {
  const listeners = new Map<string, (event: { type: "message.delta"; generation: number; seq: number; session_id: string; payload: { text: string } }) => void>();
  const unsubscribed = vi.fn();
  const manager = {
    onServerRequest: vi.fn(),
    subscribeNotices: vi.fn((_listener: (notice: GatewayNotice) => void) => () => {}),
    connectionState: () => "connected",
    retainSession: vi.fn((_profile: string, id: string) => id),
    subscribe: vi.fn((id: string, callback: (event: { type: "message.delta"; generation: number; seq: number; session_id: string; payload: { text: string } }) => void) => { listeners.set(id, callback); return () => { listeners.delete(id); unsubscribed(); }; }),
    eventsSince: vi.fn(() => ({ generation: 1, truncated, events: [{ type: "message.delta", seq: 3, generation: 1, payload: { text: "three" } }] })),
    releaseSession: vi.fn(),
  };
  // Narrow fake at the service's transport seam; only subscription operations are exercised.
  const service = new HermesChatService(manager as unknown as HermesChatService["manager"]);
  const snapshot = vi.spyOn(service, "openForView").mockResolvedValue({ generation: 1, seq: 2, messages: [] } as unknown as GatewayChatSnapshot);
  const emitted: { event: string; payload: unknown; id?: string }[] = [];
  const connection = new EventConnection(actor, (event, payload, id) => emitted.push({ event, payload, id }), service,async () => actor);
  return { connection, emitted, manager, snapshot, listeners, unsubscribed };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(currentUser).mockResolvedValue({ id: "user", email: "user@example.com", displayName: "User" } satisfies AuthenticatedUser); });
afterEach(() => { for (const connection of eventConnections.values()) {connection.close();} eventConnections.clear(); vi.useRealTimers(); delete process.env.HERMES_CHAT_TRANSPORT; });
describe("multiplexed gateway endpoints", () => {
  it("rejects anonymous route calls before reading commands or opening streams", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    expect((await GET(new Request("http://local/api/hermes/events"))).status).toBe(401);
    expect((await prompt(new Request("http://local", { method: "POST", body: "{}" }), { params: Promise.resolve({ key }) })).status).toBe(401);
  });
  it.each([
    { keys: Array(65).fill(key).join(",") },
    { keys: "x".repeat(2049) },
    { subscriptionIds: JSON.stringify(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), "s"]))) },
    { subscriptionIds: JSON.stringify({ [key]: "s".repeat(257) }) },
    { subscriptionIds: JSON.stringify({ ["k".repeat(2049)]: "s" }) },
  ])("caps SSE subscription input %j", async query => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {if (typeof value === "string") {params.set(name, value);}}
    const response = await GET(new Request(`http://local/api/hermes/events?${params}`));
    expect(response.status).toBe(400);
    expect(eventConnections.size).toBe(0);
  });
  it.each([
    { add: Array(65).fill(key) },
    { remove: Array(65).fill(key) },
    { add: ["k".repeat(2049)] },
    { subscriptionIds: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), "s"])) },
    { subscriptionIds: { [key]: "s".repeat(257) } },
    { subscriptionIds: { ["k".repeat(2049)]: "s" } },
  ])("caps POST subscription input %j", async excess => {
    const f = fixture(); eventConnections.set(f.connection.id, f.connection);
    const response = await subscribe(new Request("http://local", { method: "POST", body: JSON.stringify({ connectionId: f.connection.id, add: [], remove: [], ...excess }) }));
    expect(response.status).toBe(400);
    expect(f.manager.subscribe).not.toHaveBeenCalled();
  });
  it("caps the aggregate connection subscriptions across POST requests", async () => {
    const f = fixture(); eventConnections.set(f.connection.id, f.connection);
    await f.connection.update(Array.from({ length: 64 }, (_, i) => conversationKey("solo", String(i), "ari")), []);
    const response = await subscribe(new Request("http://local", { method: "POST", body: JSON.stringify({ connectionId: f.connection.id, add: [key], remove: [] }) }));
    expect(response.status).toBe(400);
    expect(f.manager.subscribe).toHaveBeenCalledTimes(64);
  });
  it("returns gateway_unavailable with HTTP 503, not conflict", async () => {
    process.env.HERMES_CHAT_TRANSPORT = "gateway";
    const send = vi.spyOn(HermesChatService.prototype, "sendPrompt").mockRejectedValueOnce(new ChatServiceError(503, "gateway_unavailable"));
    const response = await prompt(new Request("http://local", { method: "POST", body: JSON.stringify({ text: "hello" }) }), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "gateway_unavailable" });
    send.mockRestore();
  });
  it("replays a single-key cursor and snapshots truncated replay", async () => {
    const f = fixture();
    await f.connection.update([key], [], { generation: 1, seq: 2 });
    expect(f.manager.eventsSince).toHaveBeenCalledWith("one", 1, 2);
    expect(f.emitted).toContainEqual(expect.objectContaining({ event: "gw", id: "1:3" }));
    f.connection.close();
    const lost = fixture(true);
    await lost.connection.update([key], [], { generation: 0, seq: 900 });
    expect(lost.emitted.some(event => event.event === "snapshot")).toBe(true);
    lost.connection.close();
  });
  it("multiplexes keys and unsubscribes without releasing or interrupting sessions", async () => {
    const f = fixture();
    await f.connection.update([key, other], []);
    expect(f.emitted.filter(event => event.event === "snapshot")).toHaveLength(2);
    await f.connection.update([], [key]);
    expect(f.unsubscribed).toHaveBeenCalledTimes(1);
    expect(f.manager.releaseSession).not.toHaveBeenCalled();
    f.connection.close();
  });
  it("rejects connection ownership violations", async () => {
    const f = fixture(); eventConnections.set(f.connection.id, f.connection);
    vi.mocked(currentUser).mockResolvedValue({ id: "intruder", email: "intruder@example.com", displayName: "Intruder" } satisfies AuthenticatedUser);
    const response = await subscribe(new Request("http://local", { method: "POST", body: JSON.stringify({ connectionId: f.connection.id, add: [key], remove: [] }) }));
    expect(response.status).toBe(403); expect(f.manager.subscribe).not.toHaveBeenCalled();
  });
  it("emits heartbeat comments on the one tab stream", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const response = await GET(new Request("http://local/api/hermes/events", { signal: abort.signal }));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: connection");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: gateway");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    abort.abort(); expect(eventConnections.size).toBe(0);
  });
  it("gates gateway submission commands in SSE mode", async () => {
    process.env.HERMES_CHAT_TRANSPORT = "sse";
    const response = await prompt(new Request("http://local", { method: "POST", body: JSON.stringify({ text: "new client" }) }), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "sse_transport" });
  });
  it("disconnects a stalled browser at the bounded output budget", async () => {
    const response = await GET(new Request("http://local/api/hermes/events"));
    const connection = [...eventConnections.values()][0];
    // Inspect the in-process emitter seam while exercising the actual route stream.
    const emitter = connection as unknown as { emit(event: string, payload: unknown, id?:string,version?:number): void };
    for (let i = 0; i < 100; i++) {emitter.emit("gw", { text: "x".repeat(65_536) });}
    expect(eventConnections.size).toBe(0);
    const reader = response.body!.getReader();
    let bytes = 0;
    for (;;) { const result = await reader.read(); if (result.done) {break;} bytes += result.value.byteLength; }
    expect(bytes).toBeLessThanOrEqual(4_194_304);
  });
  it("forwards lost/restored gateway state and refreshes stale request snapshots on resync", async () => {
    const f = fixture(); await f.connection.update([key], []);
    const notify = f.manager.subscribeNotices.mock.calls[0][0];
    notify({ type: "gateway", state: "reconnecting" });
    notify({ type: "resync", key: "one", reason: "connection_restored" });
    await f.connection.update([], []);
    await f.connection.update([], []);
    await f.connection.update([], []);
    expect(f.emitted).toContainEqual({ event: "gateway", payload: { state: "reconnecting" }, id: undefined });
    expect(f.emitted).toContainEqual({ event: "resync", payload: { key, reason: "connection_restored", subscriptionId: undefined }, id: undefined });
    expect(f.snapshot.mock.calls.length).toBeGreaterThan(1);
    f.connection.close();
  });
  it("echoes the subscription id that requested each snapshot", async () => {
    const f = fixture();
    await f.connection.update([key], [], undefined, { [key]: "first" });
    await f.connection.update([key], [], undefined, { [key]: "second" });
    expect(f.emitted.filter(event => event.event === "snapshot").map(event => {
      const payload = event.payload;
      return payload && typeof payload === "object" && "subscriptionId" in payload ? payload.subscriptionId : undefined;
    })).toEqual(["first", "second"]);
    f.connection.close();
  });
  it("delivers a snapshot larger than the live backlog cap without a reconnect loop", async () => {
    const abort = new AbortController();
    const response = await GET(new Request("http://local/api/hermes/events", { signal: abort.signal }));
    const connection = [...eventConnections.values()][0];
    const emitter = connection as unknown as { emit(event: string, payload: unknown, id?:string,version?:number): void };
    emitter.emit("snapshot", { key, messages: [{ id: "huge", role: "assistant", text: "x".repeat(4_300_000) }] },undefined,1);
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes('"}]}\n\n')) {
      const result = await reader.read();
      expect(result.done).toBe(false);
      text += new TextDecoder().decode(result.value);
    }
    expect(text).toContain("event: snapshot");
    expect(eventConnections.size).toBe(1);
    abort.abort();
  });
  it("publishes frames arriving during hydration after its covered watermark", async () => {
    const f = fixture();
    f.snapshot.mockImplementationOnce(async () => {
      f.listeners.get("one")?.({ type: "message.delta", generation: 1, seq: 3, session_id: "runtime-one", payload: { text: "done" } });
      return { generation: 1, seq: 2, messages: [] } as unknown as GatewayChatSnapshot;
    });
    await f.connection.update([key], []);
    expect(f.emitted.map(event => event.event)).toEqual(["snapshot", "gw"]);
    expect(f.emitted[1]).toMatchObject({ event: "gw", id: "1:3" });
    f.connection.close();
  });
});
