import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { resolveHermesConfig } from "./agent-backend";
import { discoverWorkspaces } from "./workspace";
import { conversationKey, parseConversationKey, type HermesConversation, type HermesMessage } from "./hermes-conversations";

type NativeSession = { id: string; source?: string; title?: string; last_active?: number; started_at?: number; hidden?: boolean; is_internal_child?: boolean };
type Member = { profile: string; member_id: string; display_name?: string; handle?: string };
type Room = { room_id: string; name: string; updated_at: number; members: Member[] };
type RoomState = { room: Room; driver_status?: { working?: boolean; blocked?: boolean } };
type RoomEvent = { event_id: string; kind: string; actor: { id: string; profile?: string; label?: string }; payload: { text?: string } };
export function hermesProfiles() { return discoverWorkspaces().map((p) => p.name); }
export function assertProfile(profile: string) {
  if (!hermesProfiles().includes(profile)) throw new Error("Unknown Hermes profile");
}
export async function nativeFetch(profile: string, path: string, init: RequestInit = {}) {
  assertProfile(profile);
  const config = resolveHermesConfig();
  if (!config.apiKey) throw new Error("Missing Hermes API key");
  const response = await fetch(`${config.baseUrl}/p/${encodeURIComponent(profile)}${path}`, {
    ...init, cache: "no-store", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  // Never forward upstream bodies, which may contain credential-bearing URLs.
  if (!response.ok) throw new Error(`Hermes request failed (${response.status})`);
  return response;
}
export function groupsConfigured() { return Boolean(process.env.HERMES_GATEWAY_WS_URL && process.env.HERMES_GATEWAY_TOKEN); }
/** Native dashboard JSON-RPC, not the API-server key or an independent group engine. */
export async function groupRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!groupsConfigured()) throw new Error("Group chats require HERMES_GATEWAY_WS_URL and HERMES_GATEWAY_TOKEN on the server");
  const url = new URL(process.env.HERMES_GATEWAY_WS_URL!);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Hermes gateway requires TLS except on loopback");
  }
  url.searchParams.set("token", process.env.HERMES_GATEWAY_TOKEN!);
  return new Promise<T>((resolve, reject) => {
    const id = randomUUID();
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    const timer = setTimeout(() => finish(new Error("Hermes group request timed out")), 30_000);
    let settled = false;
    function finish(error?: Error, result?: T) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error); else resolve(result as T);
    }
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
    ws.on("message", (data) => {
      try {
        for (const line of data.toString().split("\n").filter(Boolean)) {
          const frame = JSON.parse(line);
          if (frame.id !== id) continue;
          if (frame.error) finish(new Error(`Hermes ${method} failed (code ${frame.error.code})`));
          else finish(undefined, frame.result);
        }
      } catch { finish(new Error("Invalid Hermes gateway response")); }
    });
    ws.on("error", () => finish(new Error("Hermes gateway connection failed")));
    ws.on("close", () => finish(new Error("Hermes gateway disconnected")));
  });
}
export function soloConversation(profile: string, s: NativeSession): HermesConversation {
  return { key: conversationKey("solo", s.id, profile), kind: "solo", id: s.id, profile,
    title: s.title || "Untitled chat", updatedAt: (s.last_active || s.started_at || 0) * 1000,
    participants: [{ profile, name: profile }], working: null };
}
export function roomConversation(room: Room, working: boolean | null = null): HermesConversation {
  return { key: conversationKey("group", room.room_id), kind: "group", id: room.room_id,
    title: room.name, updatedAt: room.updated_at * 1000, working,
    participants: room.members.map((m) => ({ profile: m.profile, memberId: m.member_id, name: m.display_name || m.handle || m.profile })) };
}
export async function listConversations() {
  const warnings: string[] = [];
  const profiles = hermesProfiles();
  const soloLists = await Promise.all(profiles.map(async (profile) => {
    const rows = new Map<string, HermesConversation>();
    try {
      for (let offset = 0; ; offset += 200) {
        const page = await (await nativeFetch(profile, `/api/sessions?limit=200&offset=${offset}`)).json() as { data: NativeSession[]; has_more: boolean };
        for (const row of page.data) {
          if (row.source === "bot_room" || row.hidden || row.is_internal_child) continue;
          rows.set(row.id, soloConversation(profile, row));
        }
        if (!page.has_more) break;
        if (offset >= 1_000_000) throw new Error("Hermes session pagination exceeded its limit");
      }
    } catch { warnings.push(`Could not load all chats for ${profile}`); }
    return [...rows.values()];
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
export async function readConversation(key: string) {
  const identity = parseConversationKey(key);
  if (identity.kind === "group") {
    const state = await groupRpc<RoomState>("groups.state", { room_id: identity.id });
    const events: RoomEvent[] = [];
    let since = 0;
    for (;;) {
      const page = await groupRpc<{ events: (RoomEvent & { seq: number })[]; has_more?: boolean }>("groups.log", { room_id: identity.id, since_seq: since, limit: 100 });
      events.push(...page.events);
      if (!page.events.length) break;
      const next = page.events.at(-1)!.seq;
      if (next <= since) throw new Error("Invalid Hermes room replay cursor");
      since = next;
      if (page.events.length < 100) break;
    }
    const messages: HermesMessage[] = events.filter((e) => ["message.user", "message.member"].includes(e.kind)).map((e) => {
      const member = state.room.members.find((m) => m.member_id === e.actor.id);
      return { id: e.event_id, role: e.kind === "message.user" ? "user" : "assistant", text: e.payload.text || "", profile: member?.profile, name: member?.display_name || e.actor.label };
    });
    return { conversation: roomConversation(state.room, state.driver_status?.working ?? null), messages, blocked: state.driver_status?.blocked ?? false };
  }
  const root = `/api/sessions/${encodeURIComponent(identity.id)}`;
  const [sessionResponse, messagesResponse] = await Promise.all([nativeFetch(identity.profile, root), nativeFetch(identity.profile, `${root}/messages?order=oldest&limit=500&offset=0`)]);
  const session = await sessionResponse.json();
  const messages: HermesMessage[] = [];
  let page = await messagesResponse.json();
  let offset = 0;
  for (;;) {
    for (const m of page.data) {
      if (!["user", "assistant"].includes(m.role)) continue;
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("\n") : "";
      messages.push({ id: String(m.id), role: m.role, text, profile: m.role === "assistant" ? identity.profile : undefined });
    }
    if (page.data.length < 500) break;
    offset += 500;
    page = await (await nativeFetch(identity.profile, `${root}/messages?order=oldest&limit=500&offset=${offset}`)).json();
  }
  return { conversation: soloConversation(identity.profile, session.session ?? session), messages };
}
