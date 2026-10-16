import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ currentUser: vi.fn(async () => ({ id: "user" })) }));
vi.mock("@/lib/agent-backend", () => ({ resolveAgentBackend: () => "hermes" }));
vi.mock("@/lib/hermes-native", () => ({ assertProfile: vi.fn(), nativeFetch: vi.fn(), readConversation: vi.fn(), soloConversation: vi.fn() }));
vi.mock("@/lib/hermes-gateway/manager", () => ({ getHermesGatewayManager: vi.fn(() => ({ onServerRequest: vi.fn() })) }));
import { currentUser, type AuthenticatedUser } from "@/lib/auth";
import { HermesChatService, type GatewayChatSnapshot } from "@/lib/hermes-gateway/chat-service";
import { conversationKey } from "@/lib/hermes-conversations";
import { EventConnection, eventConnections } from "./registry";
import { GET } from "./route";
import { POST as subscribe } from "./subscriptions/route";
import { POST as prompt } from "../conversations/[key]/prompt/route";
import { POST as legacyPost } from "../conversations/[key]/route";
vi.mock("@/lib/hermes-client", () => ({ stopNativeHermesStream: vi.fn() }));
const key = conversationKey("solo", "one", "ari");
const other = conversationKey("solo", "two", "ari");
function fixture(truncated = false) {
  const listeners = new Map<string, (event: { type: "message.delta"; generation: number; seq: number; session_id: string; payload: { text: string } }) => void>();
  const unsubscribed = vi.fn();
  const manager = {
    onServerRequest: vi.fn(),
    retainSession: vi.fn((_profile: string, id: string) => id),
    subscribe: vi.fn((id: string, callback: (event: { type: "message.delta"; generation: number; seq: number; session_id: string; payload: { text: string } }) => void) => { listeners.set(id, callback); return () => { listeners.delete(id); unsubscribed(); }; }),
    eventsSince: vi.fn(() => ({ generation: 1, truncated, events: [{ type: "message.delta", seq: 3, generation: 1, payload: { text: "three" } }] })),
    releaseSession: vi.fn(),
  };
  // Narrow fake at the service's transport seam; only subscription operations are exercised.
  const service = new HermesChatService(manager as unknown as HermesChatService["manager"]);
  const snapshot = vi.spyOn(service, "openForView").mockResolvedValue({ generation: 1, seq: 2, messages: [] } as unknown as GatewayChatSnapshot);
  const emitted: { event: string; payload: unknown; id?: string }[] = [];
  const connection = new EventConnection("user", (event, payload, id) => emitted.push({ event, payload, id }), service);
  return { connection, emitted, manager, snapshot, listeners, unsubscribed };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(currentUser).mockResolvedValue({ id: "user", email: "user@example.com", displayName: "User" } satisfies AuthenticatedUser); });
afterEach(() => { for (const connection of eventConnections.values()) connection.close(); eventConnections.clear(); vi.useRealTimers(); delete process.env.HERMES_CHAT_TRANSPORT; });
describe("multiplexed gateway endpoints", () => {
  it("rejects anonymous route calls before reading commands or opening streams", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    expect((await GET(new Request("http://local/api/hermes/events"))).status).toBe(401);
    expect((await prompt(new Request("http://local", { method: "POST", body: "{}" }), { params: Promise.resolve({ key }) })).status).toBe(401);
  });
  it("replays a single-key cursor and snapshots truncated replay", async () => {
    const f = fixture();
    await f.connection.update([key], [], { generation: 1, seq: 2 });
    expect(f.manager.eventsSince).toHaveBeenCalledWith("one", 1, 2);
    expect(f.emitted).toContainEqual(expect.objectContaining({ event: "gw", id: "1:3" }));
    f.connection.close();
    const lost = fixture(true);
    await lost.connection.update([key], [], { generation: 0, seq: 900 });
    expect(lost.emitted[0].event).toBe("snapshot");
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
    await vi.advanceTimersByTimeAsync(15_000);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    abort.abort(); expect(eventConnections.size).toBe(0);
  });
  it("server-gates legacy solo sends while preserving stop", async () => {
    process.env.HERMES_CHAT_TRANSPORT = "gateway";
    const response = await legacyPost(new Request("http://local", { method: "POST", body: JSON.stringify({ message: "old bundle" }) }), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "gateway_transport" });
  });
});
