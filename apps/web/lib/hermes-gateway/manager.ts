import WebSocket from "ws";
import { dashboardToken, invalidateDashboardToken } from "../hermes-native";
import { JsonRpcRequestChannel, JsonRpcGatewayError, wireFrameText, type ServerRequest } from "../../vendor/hermes-gateway/json-rpc-channel";
import type { GatewayEvent, RpcMethods, SessionResumeResult, ServerRequestMap } from "../../vendor/hermes-gateway/gateway-events";

export type GatewaySessionEvent = GatewayEvent & { generation: number; session_id: string; seq: number };
export type GatewayConnectionState = "connected" | "reconnecting" | "lost";
export interface GatewayNotice { type: "gateway" | "resync"; state?: GatewayConnectionState; key?: string; reason?: string }
export interface RetainedSession {
  key: string;
  profile: string;
  storedSessionId: string;
  runtimeId?: string;
  generation: number;
}
export interface PendingServerRequest {
  id: string;
  method: "approval" | "clarify";
  params: Record<string, unknown>;
  replayed?: boolean;
}
export interface ReplayResult { generation: number; latestSeq: number; events: GatewaySessionEvent[]; truncated: boolean }
export type LiveSessionSnapshot = SessionResumeResult & { replayBoundary: { generation: number; seq: number }; subagents: NonNullable<RpcMethods["subagent.list"]["result"]["subagents"]> };
export interface GatewayClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface GatewaySocket {
  send(text: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  on?(type: "unexpected-response", listener: (request: unknown, response: { statusCode?: number; resume(): void }) => void): void;
}
export interface GatewayManagerOptions {
  /** Discovery-only connection: no capabilities, heartbeat RPCs, or session bindings. */
  discoveryOnly?: boolean;
  url?: string;
  socketFactory?: (url: string) => GatewaySocket;
  tokenProvider?: (url: URL) => Promise<string>;
  invalidateToken?: () => void;
  clock?: GatewayClock;
  random?: () => number;
  ringSize?: number;
  ringBytes?: number;
  maxSessions?: number;
  idleMs?: number;
}
interface SessionState extends RetainedSession {
  events: GatewaySessionEvent[];
  seq: number;
  truncated: boolean;
  subscribers: Set<(event: GatewaySessionEvent) => void>;
  requests: Map<string, ServerRequest>;
  resume?: Promise<SessionResumeResult>;
  tail: Promise<unknown>;
  held?: GatewayEvent[];
  touched: number;
  active: boolean;
  bytes: number;
  operations: number;
  children: Set<string>;
  verifiedRuntimes: Set<string>;
}
const defaultClock: GatewayClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return timer; },
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};
/** Process-owned transport: browser subscription count never controls socket lifetime. */
export class HermesGatewayManager {
  private readonly clock: GatewayClock;
  private readonly channel: JsonRpcRequestChannel;
  private readonly sessions = new Map<string, SessionState>();
  private readonly requestHandlers = new Map<string, (request: PendingServerRequest) => void>();
  private socket?: GatewaySocket;
  private connecting?: Promise<void>;
  private connected = false;
  private stopped = false;
  private epoch?: string;
  private readonly openRequests = new Map<string, ServerRequest>();
  private lastInbound = 0;
  private reconnectAttempt = 0;
  private authFailures = 0;
  private reconnectTimer?: unknown;
  private heartbeatTimer?: unknown;
  private rejectConnect?: (error: Error) => void;
  private readonly timers = new Set<unknown>();
  private readonly noticeListeners = new Set<(notice: GatewayNotice) => void>();
  private state: GatewayConnectionState = "lost";
  private retirementTimer?: unknown;
  connectionState(): GatewayConnectionState { return this.state; }
  subscribeNotices(handler: (notice: GatewayNotice) => void): () => void {
    this.noticeListeners.add(handler);
    return () => { this.noticeListeners.delete(handler); };
  }
  private notice(notice: GatewayNotice): void {
    for (const handler of this.noticeListeners) { try { handler(notice); } catch { /* Isolated consumer. */ } }
  }
  private connection(state: GatewayConnectionState): void { this.state = state; this.notice({ type: "gateway", state }); }
  private resync(session: SessionState, reason: string): void { this.notice({ type: "resync", key: session.key, reason }); }

  constructor(private readonly options: GatewayManagerOptions = {}) {
    this.clock = options.clock ?? defaultClock;
    this.channel = new JsonRpcRequestChannel({
      advertiseCapabilities: !options.discoveryOnly,
      requestTimeoutMs: 0, // Manager clock owns deadlines, including deterministic tests.
      onEvent: event => this.onEvent(event),
    });
    this.channel.onRequest(request => this.onRequest(request));
  }

  connect(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Gateway manager shut down"));
    if (this.connecting) return this.connecting;
    if (this.connected) return Promise.resolve();
    if (this.reconnectTimer !== undefined) { this.clock.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    const pending = this.open();
    this.connecting = pending;
    void pending.finally(() => { if (this.connecting === pending) this.connecting = undefined; }).catch(() => {});
    return pending;
  }

  private async open(): Promise<void> {
    try {
      const url = new URL(this.options.url ?? process.env.HERMES_GATEWAY_WS_URL ?? "");
      if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Hermes gateway requires TLS except on loopback");
      url.searchParams.set("token", await (this.options.tokenProvider ?? dashboardToken)(url));
      if (this.stopped) throw new Error("Gateway manager shut down");
      const socket = (this.options.socketFactory ?? (address => new WebSocket(address)))(url.toString());
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        this.rejectConnect = reject;
        const deadline = this.later(() => this.lose(socket, new Error("Gateway handshake timed out")), 15_000);
        socket.on?.("unexpected-response", (_request, response) => {
          if (this.socket !== socket) return;
          if (response.statusCode === 401 || response.statusCode === 403) {
            (this.options.invalidateToken ?? invalidateDashboardToken)();
            this.authFailures++;
          }
          response.resume();
          this.cancel(deadline);
          this.lose(socket, new Error(`Gateway upgrade rejected (${response.statusCode})`));
        });
        socket.addEventListener("open", () => {
          if (this.socket !== socket) return;
          this.connected = true;
          this.lastInbound = this.clock.now();
          this.channel.attach({ send: text => socket.send(text) });
          if (!this.options.discoveryOnly) this.heartbeat(socket);
        });
        socket.addEventListener("message", event => {
          if (this.socket !== socket || !this.connected) return;
          this.lastInbound = this.clock.now();
          const text = wireFrameText(event.data);
          if (text === null) return;
          this.channel.handleFrame(text);
          // Resolve only after ready/capabilities: callers cannot race authentication setup.
          if (this.ready) { this.cancel(deadline); this.rejectConnect = undefined; resolve(); }
        });
        socket.addEventListener("close", event => {
          if (this.socket !== socket) return;
          if (event.code === 4401) {
            (this.options.invalidateToken ?? invalidateDashboardToken)();
            this.authFailures++;
          }
          this.cancel(deadline);
          this.lose(socket, new Error(event.code === 4401 ? "Gateway authentication rejected (4401)" : "Gateway connection lost"));
        });
        socket.addEventListener("error", () => { this.cancel(deadline); this.lose(socket, new Error("Gateway socket failed")); });
      });
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    }
  }

  private ready = false;
  private heartbeat(socket: GatewaySocket): void {
    this.heartbeatTimer = this.later(() => {
      if (this.socket !== socket) return;
      if (this.clock.now() - this.lastInbound >= 45_000) { this.lose(socket, new Error("Gateway silence deadline exceeded")); return; }
      void this.request("gateway.ping", {}).catch(() => {});
      this.heartbeat(socket);
    }, 15_000);
  }

  private lose(socket: GatewaySocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.connected = false;
    this.ready = false;
    this.connection(this.authFailures >= 2 || this.stopped ? "lost" : "reconnecting");
    this.channel.detach(error);
    this.rejectConnect?.(error);
    this.rejectConnect = undefined;
    if (this.heartbeatTimer !== undefined) this.cancel(this.heartbeatTimer);
    this.openRequests.clear();
    for (const session of this.sessions.values()) session.requests.clear();
    try { socket.close(); } catch { /* Already disconnected. */ }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.authFailures >= 2 || this.reconnectTimer !== undefined) return;
    const delay = this.backoff(this.reconnectAttempt++);
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {});
    }, delay);
  }
  private backoff(attempt: number): number { return Math.min(30_000, 250 * 2 ** Math.min(attempt, 7)) * (0.5 + (this.options.random ?? Math.random)()); }
  private later(callback: () => void, delay: number): unknown {
    const handle = this.clock.setTimeout(() => { this.timers.delete(handle); callback(); }, delay);
    this.timers.add(handle);
    return handle;
  }
  private cancel(handle: unknown): void { this.clock.clearTimeout(handle); this.timers.delete(handle); }

  private request<T>(method: string, params: object): Promise<T> {
    if (this.options.discoveryOnly && method !== 'session.active_list') return Promise.reject(new Error('Discovery allows only session.active_list'));
    const controller = new AbortController();
    const timer = this.later(() => controller.abort(), 120_000);
    return this.channel.request<T>(method, params as Record<string, unknown>, 0, controller.signal).finally(() => this.cancel(timer));
  }
  async call<M extends keyof RpcMethods>(method: M, params: RpcMethods[M]["params"]): Promise<RpcMethods[M]["result"]> {
    await this.connect();
    return this.request(method, params);
  }
  async callSession<M extends keyof RpcMethods>(key: string, method: M, params: RpcMethods[M]["params"]): Promise<RpcMethods[M]["result"]> {
    const session = this.requireSession(key);
    const invoke = () => this.call(method, { ...params, profile: session.profile, session_id: session.runtimeId } as RpcMethods[M]["params"]);
    if (!session.runtimeId) throw new Error("session_not_live");
    try { return await invoke(); } catch (error) {
      if (error instanceof JsonRpcGatewayError && error.code === 4001) {
        session.runtimeId = undefined;
        session.active = false;
        session.children.clear();
        this.resync(session, "session_reclaimed");
        throw new Error("session_not_live: runtime reclaimed; send a new prompt to resume");
      }
      throw error;
    }
  }

  retainSession(profile: string, storedSessionId: string, runtimeId?: string): string {
    const key = JSON.stringify([profile, storedSessionId]);
    let session = this.sessions.get(key);
    if (!session) {
      if (this.sessions.size >= (this.options.maxSessions ?? 128)) {
        const idle = [...this.sessions.values()].filter(candidate => !candidate.active && !candidate.children.size && !candidate.operations && !candidate.subscribers.size && !candidate.requests.size && !candidate.resume).sort((a, b) => a.touched - b.touched)[0];
        if (!idle) throw new Error("gateway_session_capacity");
        this.releaseSession(idle.key);
      }
      session = { key, profile, storedSessionId, generation: 1, events: [], seq: 0, truncated: false, subscribers: new Set(), requests: new Map(), tail: Promise.resolve(), touched: this.clock.now(), active: false, bytes: 0, operations: 0, children: new Set(), verifiedRuntimes: new Set() };
      this.sessions.set(key, session);
      this.retireIdle();
    }
    session.touched = this.clock.now();
    if (runtimeId) { session.verifiedRuntimes.add(runtimeId); this.adoptRuntime(session, runtimeId); }
    return key;
  }
  session(key: string): RetainedSession | undefined {
    const session = this.sessions.get(key);
    return session && { key, profile: session.profile, storedSessionId: session.storedSessionId, runtimeId: session.runtimeId, generation: session.generation };
  }
  releaseSession(key: string): void {
    const session = this.sessions.get(key);
    if (!session || session.active || session.children.size || session.operations || session.subscribers.size || session.requests.size || session.resume) return;
    this.sessions.delete(key);
  }
  private retireIdle(): void {
    const idle = [...this.sessions.values()].filter(session => !session.active && !session.children.size && !session.operations && !session.subscribers.size && !session.requests.size && !session.resume).sort((a, b) => a.touched - b.touched);
    for (const session of idle) {
      if (this.clock.now() - session.touched < (this.options.idleMs ?? 300_000) && this.sessions.size <= (this.options.maxSessions ?? 128)) continue;
      this.releaseSession(session.key);
    }
    if (!this.stopped && this.retirementTimer === undefined) this.retirementTimer = this.later(() => { this.retirementTimer = undefined; this.retireIdle(); }, this.options.idleMs ?? 300_000);
  }
  private requireSession(key: string): SessionState { const session = this.sessions.get(key); if (!session) throw new Error("Unknown retained Hermes session"); session.touched = this.clock.now(); return session; }
  private bump(session: SessionState): void { session.generation++; session.seq = 0; session.events = []; session.bytes = 0; session.truncated = true; session.requests.clear(); session.children.clear(); this.resync(session, "generation_change"); }
  private adoptRuntime(session: SessionState, runtime: string): void {
    if (session.runtimeId && session.runtimeId !== runtime) this.bump(session);
    session.runtimeId = runtime;
    for (const request of this.openRequests.values()) {
      if (request.params.session_id === runtime) session.requests.set(request.id, request);
    }
  }
  async attachLive(key: string, runtimeId: string): Promise<LiveSessionSnapshot | undefined> {
    const session = this.requireSession(key);
    try {
      const result = await this.call("session.activate", { profile: session.profile, session_id: runtimeId, omit_messages: true });
      // active_list is cross-profile, and lazy activation omits profile_name.
      // A stored-id match (even in both profile stores) cannot prove runtime ownership.
      if ((result.info.profile_name ? result.info.profile_name !== session.profile : !session.verifiedRuntimes.has(runtimeId))
        || (result.session_key ?? result.stored_session_id) !== session.storedSessionId
        || (result.stored_session_id && result.stored_session_id !== session.storedSessionId)
        || result.session_id !== runtimeId) return undefined;
      session.verifiedRuntimes.add(runtimeId);
      this.adoptRuntime(session, runtimeId);
      session.active = Boolean(result.running);
      const replayBoundary = { generation: session.generation, seq: session.seq };
      const subagents = await this.refreshChildren(session);
      return { ...result, replayBoundary, subagents };
    } catch (error) {
      if (error instanceof JsonRpcGatewayError && [4001, 4007, 4009].includes(error.code ?? 0)) return undefined;
      throw error;
    }
  }
  resumeSession(key: string): Promise<SessionResumeResult> {
    const session = this.requireSession(key);
    if (session.resume) return session.resume;
    const pending = this.resume(session);
    session.resume = pending;
    void pending.finally(() => { if (session.resume === pending) session.resume = undefined; }).catch(() => {});
    return pending;
  }
  private async resume(session: SessionState): Promise<SessionResumeResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.call("session.resume", { profile: session.profile, session_id: session.storedSessionId, source: "crm", close_on_disconnect: false, omit_messages: true });
        if (this.sessions.get(session.key) !== session) throw new Error("Session released while resuming");
        session.verifiedRuntimes.add(result.session_id);
        this.adoptRuntime(session, result.session_id);
        session.active = Boolean(result.running || result.auto_continue);
        await this.refreshChildren(session);
        // Channel restores open_requests before the resume response resolves.
        return result;
      } catch (error) {
        if (!(error instanceof JsonRpcGatewayError) || error.code === undefined || ![4001, 4007, 4009].includes(error.code) || attempt >= 6 || this.stopped) throw error;
        await this.pause(this.backoff(attempt));
      }
    }
  }
  private async refreshChildren(session: SessionState): Promise<LiveSessionSnapshot["subagents"]> {
    const changes: GatewaySessionEvent[] = [];
    const stop = this.subscribe(session.key, event => {
      if (event.type === "subagent.start" || event.type === "subagent.complete") changes.push(event);
    });
    try {
      const result = await this.callSession(session.key, "subagent.list", { session_id: "" });
      session.children = new Set((result.subagents ?? []).filter(child => !child.status || ["queued", "running"].includes(child.status)).map(child => child.subagent_id));
      for (const event of changes) this.trackChild(session, event);
      // The view replays changes after its pre-list boundary, so return the list
      // unchanged rather than consuming a concurrent completion here.
      return result.subagents ?? [];
    } finally { stop(); }
  }
  private trackChild(session: SessionState, event: GatewayEvent): void {
    if (event.type !== "subagent.start" && event.type !== "subagent.complete") return;
    const payload = event.payload as { subagent_id?: string; delegation_id?: string; task_index?: number; goal?: string };
    const child = payload.subagent_id ?? `${payload.delegation_id ?? payload.goal}:${payload.task_index ?? 0}`;
    if (event.type === "subagent.complete") session.children.delete(child);
    else session.children.add(child);
  }
  private pause(delay: number): Promise<void> {
    // The application's ES library predates Promise.withResolvers.
    return new Promise((resolve, reject) => {
      const handle = this.later(() => { this.sleepers.delete(handle); resolve(); }, delay);
      this.sleepers.set(handle, reject);
    });
  }
  private readonly sleepers = new Map<unknown, (error: Error) => void>();
  serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const session = this.requireSession(key);
    session.operations++;
    const pending = session.tail.then(operation).finally(() => { session.operations--; session.touched = this.clock.now(); });
    session.tail = pending.catch(() => {});
    return pending;
  }

  subscribe(key: string, handler: (event: GatewaySessionEvent) => void): () => void {
    const session = this.requireSession(key);
    session.subscribers.add(handler);
    return () => { session.subscribers.delete(handler); };
  }
  eventsSince(key: string, lastGeneration?: number, lastSeq = 0): ReplayResult {
    const session = this.requireSession(key);
    const mismatch = lastGeneration !== undefined && lastGeneration !== session.generation;
    const oldest = session.events[0]?.seq ?? session.seq + 1;
    return { generation: session.generation, latestSeq: session.seq, events: session.events.filter(event => mismatch || (event.seq ?? 0) > lastSeq), truncated: mismatch || lastSeq < oldest - 1 || (session.truncated && lastSeq === 0) };
  }
  private onEvent(event: GatewayEvent): void {
    if (event.type === "gateway.ready") {
      const epoch = (event.payload as { replay_epoch?: string } | undefined)?.replay_epoch;
      if (epoch && this.epoch && epoch !== this.epoch) for (const session of this.sessions.values()) { session.verifiedRuntimes.clear(); this.bump(session); }
      if (epoch) this.epoch = epoch;
      this.ready = true;
      this.reconnectAttempt = 0;
      this.authFailures = 0;
      this.connection("connected");
      if (this.options.discoveryOnly) return;
      void this.request("client.capabilities", { server_requests: true }).then(() => {
        // History-only subscriptions must never cold-resume interrupted work.
        for (const session of this.sessions.values()) {
          if (session.runtimeId) void this.restore(session).catch(() => {});
        }
      }).catch(() => {});
    }
    if (event.type === "session.reclaimed") {
      const runtime = (event.payload as { session_id?: string } | undefined)?.session_id;
      for (const session of this.sessions.values()) if (runtime && session.runtimeId === runtime) {
        const frame: GatewaySessionEvent = { ...event, session_id: runtime, seq: ++session.seq, generation: session.generation };
        for (const handler of session.subscribers) { try { handler(frame); } catch { /* Isolate consumers. */ } }
        session.runtimeId = undefined; session.active = false; session.requests.clear(); session.children.clear();
        this.resync(session, "session_reclaimed");
      }
      return;
    }
    for (const session of this.sessions.values()) {
      if (event.session_id !== session.runtimeId || !event.session_id) continue;
      if (session.held) { session.held.push(event); continue; }
      if (event.type === "request.cancel") {
        const id = (event.payload as { id?: string } | undefined)?.id;
        if (id) { session.requests.delete(id); this.openRequests.delete(id); }
      }
      if (typeof event.seq !== "number" || event.seq <= session.seq) continue;
      const frame: GatewaySessionEvent = { ...event, session_id: event.session_id, seq: event.seq, generation: session.generation };
      session.seq = event.seq;
      session.touched = this.clock.now();
      if (event.type === "message.start") session.active = true;
      if (event.type === "message.complete" || event.type === "error") session.active = false;
      this.trackChild(session, event);
      session.bytes += Buffer.byteLength(JSON.stringify(frame));
      session.events.push(frame);
      while (session.events.length > (this.options.ringSize ?? 512) || session.bytes > (this.options.ringBytes ?? 2_097_152)) {
        const removed = session.events.shift();
        if (!removed) break;
        session.bytes -= Buffer.byteLength(JSON.stringify(removed)); session.truncated = true;
      }
      for (const handler of session.subscribers) { try { handler(frame); } catch { /* One consumer cannot break transport. */ } }
    }
  }
  private async restore(session: SessionState): Promise<void> {
    const socket = this.socket;
    const held: GatewayEvent[] = [];
    session.held = held;
    try {
      if (!session.runtimeId || !(await this.attachLive(session.key, session.runtimeId))) {
        session.runtimeId = undefined; session.active = false; session.children.clear(); this.resync(session, "session_reclaimed"); return;
      }
      if (!session.runtimeId || this.socket !== socket) return;
      const result = await this.call("session.events.since", { session_id: session.runtimeId, profile: session.profile, last_seen: session.seq });
      if (this.socket !== socket) return;
      if (result.epoch && result.epoch !== this.epoch) {
        this.epoch = result.epoch;
        for (const retained of this.sessions.values()) { retained.verifiedRuntimes.clear(); this.bump(retained); }
        return;
      }
      if (result.truncated) {
        session.truncated = true;
        session.seq = result.latest_seq;
        this.resync(session, "truncated_replay");
      } else {
        held.push(...result.events as unknown as GatewayEvent[]);
      }
      this.resync(session, "connection_restored");
    } finally {
      if (session.held === held) {
        session.held = undefined;
        if (this.socket === socket) {
          held.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
          for (const event of held) this.onEvent(event);
        }
      }
    }
  }

  private onRequest(request: ServerRequest): boolean {
    if (this.options.discoveryOnly) return true;
    if (request.method !== "approval" && request.method !== "clarify") {
      // Returning false sends -32601, which settles the shared request before Desktop.
      request.decline?.("This client does not own a Desktop window");
      return true;
    }
    this.openRequests.set(request.id, request);
    for (const session of this.sessions.values()) {
      if (session.runtimeId !== request.params.session_id) continue;
      session.requests.set(request.id, request);
    }
    this.requestHandlers.get(request.method)?.({ id: request.id, method: request.method, params: request.params, replayed: request.replayed });
    return true;
  }
  onServerRequest<M extends "approval" | "clarify">(method: M, handler: (request: PendingServerRequest) => void): () => void {
    this.requestHandlers.set(method, handler);
    return () => { if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method); };
  }
  pendingRequests(key: string): PendingServerRequest[] {
    return [...this.requireSession(key).requests.values()].map(request => ({ id: request.id, method: request.method as "approval" | "clarify", params: request.params, replayed: request.replayed }));
  }
  respondToRequest<M extends "approval" | "clarify">(key: string, id: string, result: ServerRequestMap[M]["result"]): void {
    const session = this.requireSession(key);
    const request = session.requests.get(id);
    if (!request) throw new Error("Request does not belong to this conversation");
    request.respond(result as unknown as Record<string, unknown>);
    session.requests.delete(id);
    this.openRequests.delete(id);
  }
  failRequest(key: string, id: string, code: number, message: string): void {
    const session = this.requireSession(key);
    const request = session.requests.get(id);
    if (!request) throw new Error("Request does not belong to this conversation");
    request.fail(code, message);
    session.requests.delete(id);
    this.openRequests.delete(id);
  }
  shutdown(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) this.clock.clearTimeout(this.reconnectTimer);
    for (const [handle, reject] of this.sleepers) { this.cancel(handle); reject(new Error("Gateway manager shut down")); }
    this.sleepers.clear();
    for (const handle of this.timers) this.clock.clearTimeout(handle);
    this.timers.clear();
    if (this.socket) this.lose(this.socket, new Error("Gateway manager shut down"));
  }
}

const globalGateway = globalThis as typeof globalThis & { __hermesGatewayManager?: HermesGatewayManager };
export function getHermesGatewayManager(): HermesGatewayManager {
  return globalGateway.__hermesGatewayManager ??= new HermesGatewayManager();
}
