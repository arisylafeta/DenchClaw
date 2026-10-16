import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../hermes-native", () => ({ dashboardToken: vi.fn(), invalidateDashboardToken: vi.fn() }));
import { HermesGatewayManager, type GatewaySocket } from "./manager";

type Frame = { id?: string; method?: string; params?: Record<string, any>; result?: any; error?: { code: number; message: string } };
class FakeSocket implements GatewaySocket {
  listeners: Record<string, ((event: any) => void)[]> = {};
  frames: Frame[] = [];
  closed = false;
  respond: (frame: Frame, socket: FakeSocket) => void;
  constructor(respond: (frame: Frame, socket: FakeSocket) => void) { this.respond = respond; }
  addEventListener(type: string, handler: (event: any) => void) { (this.listeners[type] ??= []).push(handler); }
  emit(type: string, event: any = {}) { for (const handler of this.listeners[type] ?? []) handler(event); }
  send(text: string) { const frame = JSON.parse(text) as Frame; this.frames.push(frame); this.respond(frame, this); }
  receive(frame: Frame) { this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", ...frame }) }); }
  ready(epoch = "epoch-a") { this.emit("open"); this.receive({ method: "event", params: { type: "gateway.ready", payload: { replay_epoch: epoch, heartbeat: true } } }); }
  event(runtime: string, seq: number, type = "message.delta", payload: object = { text: String(seq) }) { this.receive({ method: "event", params: { type, session_id: runtime, seq, payload } }); }
  close() { this.closed = true; this.emit("close", { code: 1006 }); }
}
const managers: HermesGatewayManager[] = [];
async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
function harness(extra: { ringSize?: number; responder?: (frame: Frame, socket: FakeSocket) => boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const tokens = vi.fn(async () => "token");
  const invalidate = vi.fn();
  const manager = new HermesGatewayManager({
    url: "ws://127.0.0.1/api/ws", tokenProvider: tokens, invalidateToken: invalidate, random: () => 0.5, ringSize: extra.ringSize,
    socketFactory: () => {
      const socket = new FakeSocket((frame, peer) => {
        if (!frame.method || extra.responder?.(frame, peer)) return;
        if (frame.method === "session.resume") peer.receive({ id: frame.id, result: { session_id: `runtime-${frame.params?.session_id}`, open_requests: [] } });
        else if (frame.method === "session.events.since") peer.receive({ id: frame.id, result: { epoch: "epoch-a", events: [], latest_seq: 0, truncated: false, open_requests: [] } });
        else peer.receive({ id: frame.id, result: {} });
      });
      sockets.push(socket);
      return socket;
    },
  });
  managers.push(manager);
  return { manager, sockets, tokens, invalidate };
}
async function start(h: { manager: HermesGatewayManager; sockets: FakeSocket[] }) { const pending = h.manager.connect(); await flush(); h.sockets[0].ready(); await pending; await flush(); }
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const manager of managers.splice(0)) manager.shutdown(); vi.useRealTimers(); });

describe("process gateway manager", () => {
  it("singleflights authentication and advertises server requests", async () => {
    const h = harness();
    const first = h.manager.connect();
    expect(h.manager.connect()).toBe(first);
    await flush();
    h.sockets[0].ready();
    await first;
    expect(h.tokens).toHaveBeenCalledTimes(1);
    expect(h.sockets[0].frames[0]).toMatchObject({ method: "client.capabilities", params: { server_requests: true } });
  });
  it("resumes every retained session even with no browser subscribers", async () => {
    const h = harness();
    h.manager.retainSession("ari", "one", "runtime-one");
    h.manager.retainSession("alex", "two", "runtime-two");
    await start(h);
    h.sockets[0].close();
    await vi.advanceTimersByTimeAsync(250);
    h.sockets[1].ready(); await flush();
    expect(h.sockets[1].frames.filter(frame => frame.method === "session.resume").map(frame => frame.params)).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: "ari", session_id: "one", close_on_disconnect: false }),
      expect.objectContaining({ profile: "alex", session_id: "two", close_on_disconnect: false }),
    ]));
  });
  it("bumps generations for epoch and runtime changes and reports ring eviction", async () => {
    const h = harness({ ringSize: 2 });
    const key = h.manager.retainSession("ari", "one", "runtime-one");
    await start(h);
    for (const seq of [1, 2, 3]) h.sockets[0].event("runtime-one", seq);
    expect(h.manager.eventsSince(key, 1, 0)).toMatchObject({ generation: 1, truncated: true });
    expect(h.manager.eventsSince(key, 1, 1).events.map(event => event.seq)).toEqual([2, 3]);
    expect(h.manager.eventsSince(key, 1, 1).truncated).toBe(false);
    h.sockets[0].receive({ method: "event", params: { type: "gateway.ready", payload: { replay_epoch: "epoch-b" } } });
    expect(h.manager.session(key)?.generation).toBe(2);
    h.manager.retainSession("ari", "one", "replacement");
    expect(h.manager.session(key)?.generation).toBe(3);
    expect(h.manager.eventsSince(key, 1, 3).truncated).toBe(true);
  });
  it.each([4001, 4007, 4009])("retries settling resume %s without submitting prompts", async code => {
    let failures = 1;
    const h = harness({ responder: (frame, socket) => {
      if (frame.method === "session.resume" && failures-- > 0) { socket.receive({ id: frame.id, error: { code, message: "settling" } }); return true; }
      return false;
    } });
    await start(h);
    const key = h.manager.retainSession("ari", "one");
    const resume = h.manager.resumeSession(key);
    await flush(); await vi.advanceTimersByTimeAsync(250);
    expect((await resume).session_id).toBe("runtime-one");
    expect(h.sockets[0].frames.filter(frame => frame.method === "session.resume")).toHaveLength(2);
    expect(h.sockets[0].frames.some(frame => frame.method === "prompt.submit")).toBe(false);
  });
  it("rejects unknown server requests and restores approval/clarify ownership", async () => {
    const h = harness();
    const key = h.manager.retainSession("ari", "one", "runtime-one");
    const other = h.manager.retainSession("ari", "two", "runtime-two");
    await start(h);
    const socket = h.sockets[0];
    socket.receive({ id: "srq-unknown", method: "desktop.open", params: { session_id: "runtime-one" } });
    expect(socket.frames.at(-1)).toMatchObject({ id: "srq-unknown", error: { code: -32601 } });
    socket.receive({ id: "srq-approval", method: "approval", params: { session_id: "runtime-one", request_id: "approval-payload-id" } });
    expect(h.manager.pendingRequests(key)).toHaveLength(1);
    expect(() => h.manager.respondToRequest(other, "srq-approval", {} as never)).toThrow("does not belong");
    h.manager.respondToRequest(key, "srq-approval", { decision: "allow" } as never);
    expect(socket.frames.at(-1)).toMatchObject({ id: "srq-approval", result: { decision: "allow" } });
    socket.receive({ id: "srq-clarify", method: "clarify", params: { session_id: "runtime-one" } });
    socket.event("runtime-one", 1, "request.cancel", { id: "srq-clarify" });
    expect(h.manager.pendingRequests(key)).toEqual([]);
  });
  it("rejects pending calls on transport loss without replaying mutations", async () => {
    const h = harness({ responder: frame => frame.method === "prompt.submit" });
    await start(h);
    const pending = h.manager.call("prompt.submit", { session_id: "runtime-one", text: "hello" } as never);
    const rejected = expect(pending).rejects.toThrow("connection lost");
    await flush(); h.sockets[0].close(); await rejected;
    await vi.advanceTimersByTimeAsync(250); h.sockets[1].ready(); await flush();
    expect(h.sockets[1].frames.some(frame => frame.method === "prompt.submit")).toBe(false);
  });
  it("pings every 15 seconds and drops a silent socket at 45 seconds", async () => {
    const h = harness({ responder: frame => frame.method === "gateway.ping" });
    await start(h);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.sockets[0].frames.filter(frame => frame.method === "gateway.ping")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sockets[0].closed).toBe(true);
  });
  it("inbound notifications keep a streaming socket alive", async () => {
    const h = harness({ responder: frame => frame.method === "gateway.ping" });
    await start(h);
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(14_000); h.sockets[0].event("runtime-one", i + 1); }
    expect(h.sockets[0].closed).toBe(false);
  });
  it("invalidates a rejected token and bounds reauthentication", async () => {
    const h = harness();
    const pending = h.manager.connect(); const rejected = expect(pending).rejects.toThrow("4401");
    await flush(); h.sockets[0].emit("close", { code: 4401 }); await rejected;
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    h.sockets[1].emit("close", { code: 4401 }); await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.tokens).toHaveBeenCalledTimes(2);
    expect(h.sockets).toHaveLength(2);
  });
  it("merges live frames racing reconnect replay in sequence order", async () => {
    let replay: Frame | undefined;
    const h = harness({ responder: (frame, socket) => {
      if (frame.method === "session.events.since" && replay === undefined) { replay = frame; socket.event("runtime-one", 3); return true; }
      return false;
    } });
    const key = h.manager.retainSession("ari", "one", "runtime-one");
    const seen: number[] = [];
    h.manager.subscribe(key, event => seen.push(event.seq!));
    await start(h);
    h.sockets[0].receive({ id: replay!.id, result: { epoch: "epoch-a", events: [1, 2, 3].map(seq => ({ type: "message.delta", session_id: "runtime-one", seq, payload: { text: String(seq) } })), truncated: false } });
    await flush();
    expect(seen).toEqual([1, 2, 3]);
  });
  it("restores open requests returned before a new runtime id is adopted", async () => {
    const h = harness({ responder: (frame, socket) => {
      if (frame.method !== "session.resume") return false;
      socket.receive({ id: frame.id, result: { session_id: "new-runtime", open_requests: [{ id: "srq-restored", method: "clarify", params: { session_id: "new-runtime" } }] } });
      return true;
    } });
    await start(h);
    const key = h.manager.retainSession("ari", "one");
    await h.manager.resumeSession(key);
    expect(h.manager.pendingRequests(key)).toMatchObject([{ id: "srq-restored", replayed: true }]);
  });
  it("re-resumes stale reads but never resubmits a stale mutation", async () => {
    let statusCalls = 0;
    let promptCalls = 0;
    const h = harness({ responder: (frame, socket) => {
      if (frame.method === "session.status" && statusCalls++ === 0) {
        socket.receive({ id: frame.id, error: { code: 4001, message: "stale" } }); return true;
      }
      if (frame.method === "prompt.submit") {
        promptCalls++;
        socket.receive({ id: frame.id, error: { code: 4001, message: "stale mutation" } }); return true;
      }
      return false;
    } });
    await start(h);
    const key = h.manager.retainSession("ari", "one", "old-runtime");
    await h.manager.callSession(key, "session.status", { session_id: "old-runtime" });
    expect(statusCalls).toBe(2);
    const frames = h.sockets[0].frames.filter(frame => frame.method === "session.status");
    expect(frames[1].params?.session_id).toBe("runtime-one");
    await expect(h.manager.callSession(key, "prompt.submit", { session_id: "runtime-one", text: "hello" } as never)).rejects.toThrow("stale mutation");
    expect(promptCalls).toBe(1);
  });
});
