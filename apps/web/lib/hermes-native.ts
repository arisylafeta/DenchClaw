import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveHermesConfig } from "./agent-backend";
import { nativeHermesWorking } from "./hermes-client";
import { discoverWorkspaces } from "./workspace";
import { conversationKey, parseConversationKey, type HermesConversation, type HermesMessage } from "./hermes-conversations";

type NativeSession = { id: string; source?: string; title?: string; last_active?: number; started_at?: number; hidden?: boolean; is_internal_child?: boolean };
type Member = { profile: string; member_id: string; display_name?: string; handle?: string };
type Room = { room_id: string; name: string; updated_at: number; members: Member[] };
type RoomState = { room: Room; driver_status?: { working?: boolean; blocked?: boolean } };
type RoomEvent = { event_id: string; kind: string; actor: { id: string; profile?: string; display_name?: string }; payload: { text?: string; task_id?: string; member_id?: string } };
export function hermesProfiles() { return discoverWorkspaces().map((p) => p.name); }
export function assertProfile(profile: string) {
  const found = discoverWorkspaces().find((workspace) => workspace.name === profile);
  if (!found) throw new Error("Unknown Hermes profile");
  return found;
}
export async function nativeFetch(profile: string, path: string, init: RequestInit = {}, allowedStatuses: number[] = []) {
  assertProfile(profile);
  const config = resolveHermesConfig();
  if (!config.apiKey) throw new Error("Missing Hermes API key");
  const response = await fetch(`${config.baseUrl}/p/${encodeURIComponent(profile)}${path}`, {
    ...init, cache: "no-store", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  // Never forward upstream bodies, which may contain credential-bearing URLs.
  if (!response.ok && !allowedStatuses.includes(response.status)) throw new Error(`Hermes request failed (${response.status})`);
  return response;
}
export function groupsConfigured() {
  return Boolean(process.env.HERMES_GATEWAY_WS_URL && (process.env.HERMES_GATEWAY_TOKEN ||
    (process.env.HERMES_GATEWAY_USERNAME && process.env.HERMES_GATEWAY_PASSWORD_FILE)));
}
let dashboardSession: { token: string; expiresAt: number } | undefined;
let dashboardLogin: Promise<string> | undefined;
let dashboardRetryAt = 0;
export async function dashboardToken(url: URL): Promise<string> {
  if (process.env.HERMES_GATEWAY_TOKEN) return process.env.HERMES_GATEWAY_TOKEN;
  if (dashboardSession && dashboardSession.expiresAt > Date.now()) return dashboardSession.token;
  if (Date.now() < dashboardRetryAt) throw new Error("Hermes dashboard sign-in temporarily unavailable");
  if (dashboardLogin) return dashboardLogin;
  dashboardLogin = (async () => {
    const endpoint = new URL(url);
    endpoint.protocol = url.protocol === "wss:" ? "https:" : "http:";
    endpoint.pathname = endpoint.pathname.replace(/\/api\/ws\/?$/, "/auth/password-login");
    endpoint.search = "";
    const password = (await readFile(process.env.HERMES_GATEWAY_PASSWORD_FILE!, "utf8")).trim();
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "basic", username: process.env.HERMES_GATEWAY_USERNAME, password }),
    });
    if (!response.ok) throw new Error("Hermes dashboard sign-in failed");
    const accessCookie = /^(?:__Host-|__Secure-)?hermes_session_at=([^;]+)/;
    const cookie = response.headers.getSetCookie().find((value) => accessCookie.test(value));
    const rawToken = cookie?.match(accessCookie)?.[1];
    const token = rawToken?.startsWith('"') ? JSON.parse(rawToken) as string : rawToken;
    const maxAge = Number(cookie?.match(/Max-Age=(\d+)/i)?.[1] ?? 60);
    if (!token) throw new Error("Hermes dashboard did not return a session");
    dashboardSession = { token, expiresAt: Date.now() + Math.max(1, maxAge - 60) * 1000 };
    return token;
  })().catch(() => {
    dashboardRetryAt = Date.now() + 60_000;
    throw new Error("Hermes dashboard sign-in failed");
  }).finally(() => { dashboardLogin = undefined; });
  return dashboardLogin;
}
/** Forget a rejected dashboard credential; healthy sockets do not call this. */
export function invalidateDashboardToken(): void {
  dashboardSession = undefined;
  dashboardRetryAt = 0;
}
// One native dashboard socket multiplexes list/state/log/send RPCs, including concurrent refreshes.
let gateway: { url: string; socket: WebSocket; pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> } | undefined;
/** Native dashboard JSON-RPC, never an API-server key or independent room engine. */
export async function groupRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!groupsConfigured()) throw new Error("Group chats require a Hermes dashboard connection on the server");
  const url = new URL(process.env.HERMES_GATEWAY_WS_URL!);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Hermes gateway requires TLS except on loopback");
  const address = url.toString();
  if (!gateway || gateway.url !== address || gateway.socket.readyState >= WebSocket.CLOSING) {
    url.searchParams.set("token", await dashboardToken(url));
  }
  // Recheck after sign-in: another concurrent caller may have opened the socket.
  if (!gateway || gateway.url !== address || gateway.socket.readyState >= WebSocket.CLOSING) {
    gateway?.socket.close();
    const connection = { url: address, socket: new WebSocket(url, { handshakeTimeout: 10_000 }), pending: new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>() };
    gateway = connection;
    const fail = () => {
      for (const request of connection.pending.values()) { clearTimeout(request.timer); request.reject(new Error("Hermes gateway disconnected")); }
      connection.pending.clear();
    };
    connection.socket.on("error", fail);
    connection.socket.on("close", fail);
    connection.socket.on("message", (data) => {
      try {
        for (const line of data.toString().split("\n").filter(Boolean)) {
          const frame = JSON.parse(line);
          const request = connection.pending.get(frame.id);
          if (!request) continue;
          connection.pending.delete(frame.id); clearTimeout(request.timer);
          if (frame.error) request.reject(new Error(`Hermes group request failed (code ${frame.error.code})`));
          else request.resolve(frame.result);
        }
      } catch { fail(); connection.socket.close(); }
    });
  }
  const connection = gateway;
  return new Promise<T>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { connection.pending.delete(id); reject(new Error("Hermes group request timed out")); }, 30_000);
    connection.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    const send = () => {
      if (connection.pending.has(id)) connection.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    };
    if (connection.socket.readyState === WebSocket.OPEN) send(); else connection.socket.once("open", send);
  });
}
export function soloConversation(profile: string, s: NativeSession): HermesConversation {
  return { key: conversationKey("solo", s.id, profile), kind: "solo", id: s.id, profile,
    title: s.title || "Untitled chat", updatedAt: (s.last_active || s.started_at || 0) * 1000,
    participants: [{ profile, name: profile }], working: nativeHermesWorking(profile, s.id), source: s.source };
}
export function roomConversation(room: Room, working: boolean | null = null): HermesConversation {
  return { key: conversationKey("group", room.room_id), kind: "group", id: room.room_id,
    title: room.name, updatedAt: room.updated_at * 1000, working,
    participants: room.members.map((m) => ({ profile: m.profile, memberId: m.member_id, name: m.display_name || m.handle || m.profile, handle: m.handle })) };
}
export async function listConversations() {
  const warnings: string[] = [];
  const profiles = hermesProfiles();
  const soloLists = await Promise.all(profiles.map(async (profile) => {
    // Newest first, one page: profiles can hold thousands of sessions and a full walk takes minutes.
    try {
      const page = await (await nativeFetch(profile, "/api/sessions?limit=200&offset=0")).json() as { data: NativeSession[] };
      return page.data.filter((row) => row.source !== "bot_room" && !row.hidden && !row.is_internal_child).map((row) => soloConversation(profile, row));
    } catch { warnings.push(`Could not load chats for ${profile}`); return []; }
  }));
  const rooms = new Map<string, HermesConversation>();
  if (groupsConfigured()) {
    try {
      let offset: number | null = 0;
      while (offset !== null) {
        const page: { rooms: Room[]; next_offset: number | null } = await groupRpc("groups.list", { limit: 100, offset });
        for (const room of page.rooms) rooms.set(room.room_id, roomConversation(room));
        if (page.next_offset !== null && page.next_offset <= offset) throw new Error("Invalid room pagination");
        offset = page.next_offset;
      }
      await Promise.all([...rooms.values()].map(async (row) => {
        try {
          const state = await groupRpc<RoomState>("groups.state", { room_id: row.id });
          row.working = state.driver_status?.working ?? null;
          row.blocked = state.driver_status?.blocked ?? false;
        } catch { /* Unknown status must not be mistaken for idle or working. */ }
      }));
    } catch { warnings.push("Could not load all Hermes group chats"); }
  } else warnings.push("Group chats unavailable: configure the Hermes dashboard connection on the server");
  return { backend: "hermes", profiles, groupsAvailable: groupsConfigured(), warnings,
    sessions: [...soloLists.flat(), ...rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt) };
}
export async function createConversation(profiles: string[], title?: string) {
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 6 || new Set(profiles).size !== profiles.length) throw new Error("Choose one to six distinct bots");
  profiles.forEach(assertProfile);
  const id = randomUUID();
  if (profiles.length === 1) {
    await nativeFetch(profiles[0], "/api/sessions", { method: "POST", body: JSON.stringify({ id, title: title || "New chat", source: "web" }) });
    const result = await (await nativeFetch(profiles[0], `/api/sessions/${encodeURIComponent(id)}`)).json();
    return soloConversation(profiles[0], result.session ?? result);
  }
  const room = { room_id: id, name: title || profiles.join(", "), members: profiles.map((profile, index) => ({ member_id: `bot-${index + 1}`, profile, handle: `bot${index + 1}`, display_name: profile, target: { kind: "local", profile } })) };
  await groupRpc("groups.create", room);
  const verified = await groupRpc<RoomState>("groups.state", { room_id: id });
  return roomConversation(verified.room, verified.driver_status?.working ?? null);
}
export async function readConversation(key: string, sinceSeq = 0) {
  const identity = parseConversationKey(key);
  if (identity.kind === "group") {
    const state = await groupRpc<RoomState>("groups.state", { room_id: identity.id });
    const events: RoomEvent[] = [];
    let since = sinceSeq;
    for (;;) {
      const page = await groupRpc<{ events: (RoomEvent & { seq: number })[]; has_more?: boolean }>("groups.log", { room_id: identity.id, since_seq: since, limit: 100 });
      events.push(...page.events);
      if (!page.events.length) {
        if (page.has_more) throw new Error("Hermes room replay made no progress");
        break;
      }
      const next = page.events.at(-1)!.seq;
      if (next <= since) throw new Error("Invalid Hermes room replay cursor");
      since = next;
      if (page.has_more === false || (page.has_more === undefined && page.events.length < 100)) break;
    }
    const messages: HermesMessage[] = events.filter((e) => ["message.user", "message.member"].includes(e.kind)).map((e) => {
      const member = state.room.members.find((m) => m.member_id === e.actor.id);
      return { id: e.event_id, role: e.kind === "message.user" ? "user" : "assistant", text: e.payload.text || "", content: e.payload.text || "", profile: member?.profile, name: member?.display_name || e.actor.display_name };
    });
    const conversation = roomConversation(state.room, state.driver_status?.working ?? null);
    return { conversation, messages, cursor: since, sinceSeq, blocked: state.driver_status?.blocked ?? false };
  }
  const root = `/api/sessions/${encodeURIComponent(identity.id)}`;
  const [sessionResponse, messagesResponse] = await Promise.all([nativeFetch(identity.profile, root), nativeFetch(identity.profile, `${root}/messages?order=oldest&limit=500&offset=0`)]);
  const session = await sessionResponse.json();
  const messages: HermesMessage[] = [];
  const tools = new Map<string, Record<string, unknown>>();
  let page = await messagesResponse.json();
  let offset = 0;
  for (;;) {
    for (const m of page.data) {
      if (m.display_kind === "hidden") continue;
      if (m.role === "tool") {
        const tool = tools.get(m.tool_call_id);
        if (tool) { tool.result = m.content; delete tool.state; }
        continue;
      }
      if (!["user", "assistant"].includes(m.role)) continue;
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("\n") : "";
      const parts: Record<string, unknown>[] = [];
      if (typeof (m.reasoning_content ?? m.reasoning) === "string") parts.push({ type: "reasoning", text: m.reasoning_content ?? m.reasoning });
      if (text) parts.push({ type: "text", text });
      for (const call of m.tool_calls ?? []) {
        let args: unknown = call.function?.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* Preserve malformed historical arguments as text. */ } }
        const part: Record<string, unknown> = { type: "tool-invocation", toolCallId: call.id, toolName: call.function?.name ?? call.name ?? "unknown", args, state: "call" };
        tools.set(call.id, part); parts.push(part);
      }
      messages.push({ id: String(m.id), role: m.role, text, content: text, parts, profile: m.role === "assistant" ? identity.profile : undefined });
    }
    if (page.data.length < 500) break;
    offset += 500;
    page = await (await nativeFetch(identity.profile, `${root}/messages?order=oldest&limit=500&offset=${offset}`)).json();
  }
  return { conversation: soloConversation(identity.profile, session.session ?? session), messages };
}
