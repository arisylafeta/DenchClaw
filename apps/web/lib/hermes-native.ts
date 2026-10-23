import { authorizeAccess, registerConversation, requireActor, ConversationAccessError, type ConversationActor, type ConversationAccess } from "./conversation-access";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveHermesConfig } from "./agent-backend";
import { nativeHermesWorking } from "./hermes-client";
import { discoverWorkspaces } from "./workspace";
import { conversationKey, messagingConversation, parseConversationKey, type HermesConversation, type HermesMessage } from "./hermes-conversations";
import { sessionDisplayNames } from "./hermes-session-names";
import { sessionProjectLabels } from "./hermes-session-projects";
import { recentSessionActivity } from "./hermes-session-activity";
import { hermesChatTransport } from "./hermes-gateway/transport-flag";
import { getHermesGatewayManager, type HermesGatewayManager } from "./hermes-gateway/manager";

type NativeSession = { id: string; source?: string; title?: string; last_active?: number; started_at?: number; hidden?: boolean; is_internal_child?: boolean };
export type Member = { profile: string; member_id: string; display_name?: string; handle?: string };
export type Room = { room_id: string; name: string; updated_at: number; members: Member[] };
export type RoomDriver = { working?: boolean; blocked?: boolean; pending_actions?: Array<Record<string, unknown>>; counts?: Record<string, unknown> };
export type RoomState = { room: Room; driver_status?: RoomDriver };
export type RoomEvent = { event_id: string; kind: string; created_at?: number; actor: { id: string; profile?: string; display_name?: string }; payload: { text?: string; task_id?: string; member_id?: string; turn_id?: string; passed?: boolean; message_event_id?: string; discussion_event_id?: string } };
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
export async function authorizeNativeConversation(actor: ConversationActor | undefined,key: string,action: import("./conversation-access").AccessAction = "read") {
  return authorizeAccess(actor,key,action,async () => {
    const id = parseConversationKey(key); assertProfile(id.profile);
    const response = await nativeFetch(id.profile,`/api/sessions/${encodeURIComponent(id.id)}`,{},[404]);
    if (response.status === 404) return undefined;
    const row = await response.json(); return (row.session ?? row).source;
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
type ListStatus = { working: boolean | null; blocked: boolean | null; background: boolean | null; live: boolean };
const gatewayListCache = new WeakMap<HermesGatewayManager, { expires: number; pending: Promise<Record<string, ListStatus>> }>();
const RUNNING_LIVE_STATUSES = ["working", "starting"];
function gatewayListStatus(rows: HermesConversation[]) {
  const manager = getHermesGatewayManager();
  const cached = gatewayListCache.get(manager);
  if (cached && cached.expires > Date.now()) return cached.pending;
  const pending = (async () => {
    const result: Record<string, ListStatus> = {};
    const active = await manager.call("session.active_list", {});
    for (const row of rows) result[row.key] = { working: false, blocked: false, background: false, live: false };
    const candidates = rows.flatMap(row => active.sessions.filter(live => live.session_key === row.id).map(live => ({ row, live })));
    // active_list status is free for every live runtime; attaching is not. Seed every candidate from
    // it, then refine at most eight (four workers) with pending requests and the child roster.
    // active_list spans profiles: an id stored in two profiles proves nothing until attach verifies ownership.
    const owners = new Map<string, number>();
    for (const { row } of candidates) owners.set(row.id, (owners.get(row.id) ?? 0) + 1);
    for (const { row, live } of candidates) result[row.key] = owners.get(row.id) === 1
      ? { working: RUNNING_LIVE_STATUSES.includes(live.status), blocked: live.status === "waiting", background: null, live: true }
      : { working: null, blocked: null, background: null, live: false };
    const selected = candidates.slice(0, 8);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (next < selected.length) {
        const { row, live } = selected[next++];
        const retained = manager.retainSession(row.participants[0].profile, row.id);
        let snapshot: Awaited<ReturnType<typeof manager.attachLive>>;
        // One failed attach keeps that row's active_list seed instead of discarding the whole poll.
        try { snapshot = await manager.attachLive(retained, live.id); } catch { continue; }
        // Refused ownership: this row's id is another profile's runtime, so its status is not ours.
        if (!snapshot) { result[row.key] = { working: false, blocked: false, background: false, live: false }; continue; }
        // Running means this chat's own turn. Children still working after the turn ended are background.
        const working = Boolean(snapshot.running || RUNNING_LIVE_STATUSES.includes(live.status));
        const children = Boolean(snapshot.subagents?.some(child => !child.status || ["queued", "running"].includes(child.status)));
        result[row.key] = { working, background: !working && children, live: true,
          blocked: Boolean(live.status === "waiting" || manager.pendingRequests(retained).length || snapshot.pending_approval) };
      }
    }));
    return result;
  })();
  gatewayListCache.set(manager, { expires: Date.now() + 5_000, pending });
  void pending.catch(() => gatewayListCache.delete(manager));
  return pending;
}
export async function listConversations(actor?: ConversationActor) {
  requireActor(actor);
  const warnings: string[] = [];
  const profiles = hermesProfiles();
  const soloLists = await Promise.all(profiles.map(async (profile) => {
    // Newest first, one page: profiles can hold thousands of sessions and a full walk takes minutes.
    try {
      const page = await (await nativeFetch(profile, "/api/sessions?limit=200&offset=0")).json() as { data: NativeSession[] };
      const rows: HermesConversation[] = [];
      for (const session of page.data.filter(row => row.source !== "bot_room" && !row.hidden && !row.is_internal_child)) {
        const row = soloConversation(profile,session);
        try { const { access } = await authorizeAccess(actor,row.key,"read",async () => session.source); rows.push(Object.assign(row,{access})); }
        catch(error) { if (!(error instanceof ConversationAccessError) || error.status !== 404) throw error; }
      }
      // The API may append older pinned sessions beyond its 200-row recency window.
      // Preserve those rows and bound each metadata read, not the conversation list.
      const messagingIds = rows.filter(messagingConversation).map((row) => row.id);
      const names: Record<string, string> = {};
      for (let offset = 0; offset < messagingIds.length; offset += 200) {
        Object.assign(names, await sessionDisplayNames(profile, messagingIds.slice(offset, offset + 200)));
      }
      for (const row of rows) if (Object.hasOwn(names, row.id)) row.title = names[row.id];
      const projects: Record<string, string> = {};
      for (let offset = 0; offset < rows.length; offset += 200) {
        Object.assign(projects, await sessionProjectLabels(profile, rows.slice(offset, offset + 200).map((row) => row.id)));
      }
      for (const row of rows) if (Object.hasOwn(projects, row.id)) row.project = projects[row.id];
      return rows;
    } catch (error) { if (error instanceof ConversationAccessError) throw error; warnings.push(`Could not load chats for ${profile}`); return []; }
  }));
  // Rows the dashboard gateway hosts get its authoritative status; the state.db heartbeat lags a
  // finished turn by up to its window and is restamped by background children, so it must not override it.
  const gatewayHosted = new Set<string>();
  if (hermesChatTransport() === "gateway") {
    const rows = soloLists.flat();
    for (const row of rows) { row.working = null; row.blocked = null; row.background = null; }
    try {
      const statuses = await gatewayListStatus(rows);
      for (const row of rows) {
        const status = statuses[row.key];
        if (!status) continue;
        row.working = status.working; row.blocked = status.blocked; row.background = status.background;
        if (status.live) gatewayHosted.add(row.key);
      }
    } catch { /* Unknown status is not idle. */ }
  }
  // Sessions run by a CLI agent live in their own process, so neither the stream map nor the
  // dashboard gateway sees them. A fresh state.db heartbeat proves work either way.
  await Promise.all(soloLists.map(async (rows) => {
    // Hosted rows past the attach cap have an unknown child roster: they may take a background hint only.
    const unknown = rows.filter((row) => row.working !== true && (!gatewayHosted.has(row.key) || row.background === null));
    for (let offset = 0; offset < unknown.length; offset += 200) {
      const batch = unknown.slice(offset, offset + 200);
      const activity = await recentSessionActivity(batch[0].profile!, batch.map((row) => row.id));
      for (const row of batch) {
        const seen = activity.get(row.id);
        if (seen === "working" && !gatewayHosted.has(row.key)) { row.working = true; row.background = false; }
        else if (seen === "background") row.background = true;
      }
    }
  }));
  const rooms = new Map<string, HermesConversation>();
  if (groupsConfigured()) {
    try {
      let offset: number | null = 0;
      while (offset !== null) {
        const page: { rooms: Room[]; next_offset: number | null } = await groupRpc("groups.list", { limit: 100, offset });
        for (const room of page.rooms) {
          const row = roomConversation(room);
          try { const { access } = await authorizeAccess(actor,row.key); rooms.set(room.room_id,Object.assign(row,{access})); }
          catch(error) { if (!(error instanceof ConversationAccessError) || error.status !== 404) throw error; }
        }
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
    } catch (error) { if (error instanceof ConversationAccessError) throw error; warnings.push("Could not load all Hermes group chats"); }
  } else warnings.push("Group chats unavailable: configure the Hermes dashboard connection on the server");
  return { backend: "hermes", profiles, groupsAvailable: groupsConfigured(), warnings,
    sessions: [...soloLists.flat(), ...rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt) };
}
const MENTION_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Members are addressed as @<profile>; a profile that cannot be a mention handle falls back to a positional one. */
export function roomMembers(profiles: string[]) {
  const taken = new Set(["all", "everyone"]);
  return profiles.map((profile, index) => {
    let handle = MENTION_HANDLE.test(profile) && !taken.has(profile.toLowerCase()) ? profile : `bot${index + 1}`;
    for (let n = index + 2; taken.has(handle.toLowerCase()); n++) handle = `bot${n}`;
    taken.add(handle.toLowerCase());
    return { member_id: handle, profile, handle, display_name: profile, target: { kind: "local", profile } };
  });
}
export async function createConversation(profiles: string[], title?: string, actor?: ConversationActor, inherited?: ConversationAccess) {
  requireActor(actor);
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 6 || new Set(profiles).size !== profiles.length) throw new Error("Choose one to six distinct bots");
  profiles.forEach(assertProfile);
  const id = randomUUID();
  const access = await registerConversation(actor,conversationKey(profiles.length === 1 ? "solo" : "group",id,profiles.length === 1 ? profiles[0] : ""),inherited);
  if (profiles.length === 1) {
    await nativeFetch(profiles[0], "/api/sessions", { method: "POST", body: JSON.stringify({ id, title: title || "New chat", source: "web" }) });
    const result = await (await nativeFetch(profiles[0], `/api/sessions/${encodeURIComponent(id)}`)).json();
    return Object.assign(soloConversation(profiles[0], result.session ?? result),{access});
  }
  const room = { room_id: id, name: title || profiles.join(", "), members: roomMembers(profiles) };
  await groupRpc("groups.create", room);
  const verified = await groupRpc<RoomState>("groups.state", { room_id: id });
  return Object.assign(roomConversation(verified.room, verified.driver_status?.working ?? null),{access});
}
export async function readConversation(key: string, sinceSeq = 0, probeCap?: number, actor?: ConversationActor) {
  const { access } = await authorizeNativeConversation(actor,key);
  const identity = parseConversationKey(key);
  if (identity.kind === "group") {
    const state = await groupRpc<RoomState>("groups.state", { room_id: identity.id });
    const events: RoomEvent[] = [];
    let since = sinceSeq;
    for (;;) {
      const page = await groupRpc<{ events: (RoomEvent & { seq: number })[]; has_more?: boolean }>("groups.log", { room_id: identity.id, since_seq: since, limit: 100 });
      events.push(...page.events);
      if (probeCap && (events.length > probeCap || (events.length >= probeCap && page.has_more !== false))) throw Error('Trace probe cap exceeded');
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
      const member = state.room.members.find((m) => m.member_id === (e.payload.member_id ?? e.actor.id));
      return { id: e.event_id, role: e.kind === "message.user" ? "user" : "assistant", text: e.payload.text || "", content: e.payload.text || "", profile: member?.profile, name: member?.display_name || e.actor.display_name,
        memberId: e.payload.member_id ?? member?.member_id, turnId: e.payload.turn_id, taskId: e.payload.task_id, createdAt: e.created_at ? e.created_at * 1000 : undefined };
    });
    const conversation = roomConversation(state.room, state.driver_status?.working ?? null);
    return { conversation: Object.assign(conversation,{access}), messages, cursor: since, sinceSeq, blocked: state.driver_status?.blocked ?? false,
      members: state.room.members, driver: state.driver_status ?? {},
      settled: events.filter(e => e.kind === "turn.settled").map(e => ({ memberId: e.payload.member_id, turnId: e.payload.turn_id, taskId: e.payload.task_id, passed: e.payload.passed, createdAt: e.created_at ? e.created_at * 1000 : undefined })),
      events };
  }
  const root = `/api/sessions/${encodeURIComponent(identity.id)}`;
  // Display history, not the model's working set: after Hermes compacts in place, only
  // include_compacted returns the summarized turns (and re-ID'd copies once, in display order).
  const historyPage = (offset: number) => `${root}/messages?order=${probeCap ? 'latest' : 'oldest'}&limit=${probeCap ? probeCap + 1 : 500}&offset=${offset}&include_compacted=true`;
  const [sessionResponse, messagesResponse] = await Promise.all([nativeFetch(identity.profile, root), nativeFetch(identity.profile, historyPage(0))]);
  const session = await sessionResponse.json();
  const messages: HermesMessage[] = [];
  const tools = new Map<string, Record<string, unknown>>();
  let page = await messagesResponse.json();
  if (probeCap) {
    // Hermes order=latest already returns chronological rows.
    if (page.data.length > probeCap) throw Error('Trace probe cap exceeded');
  }
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
      messages.push({ id: String(m.id), role: m.role, timestamp: Number(m.timestamp) > 0 ? Math.round(Number(m.timestamp) * 1000) : undefined, displayKind: typeof m.display_kind === "string" ? m.display_kind : undefined, displayMetadata: m.display_metadata, text, content: text, parts, profile: m.role === "assistant" ? identity.profile : undefined });
    }
    if (page.data.length < 500) break;
    offset += 500;
    page = await (await nativeFetch(identity.profile, historyPage(offset))).json();
  }
  const conversation = soloConversation(identity.profile, session.session ?? session);
  const projects = await sessionProjectLabels(identity.profile, [identity.id]);
  if (Object.hasOwn(projects, identity.id)) conversation.project = projects[identity.id];
  if (messagingConversation(conversation)) {
    const names = await sessionDisplayNames(identity.profile, [identity.id]);
    if (Object.hasOwn(names, identity.id)) conversation.title = names[identity.id];
  }
  return { conversation: Object.assign(conversation,{access}), messages };
}

const HANDOFF_TURN_CHARS = 600;
/**
 * The invitee's first prompt: a pointer to the host's transcript plus a short summary, not the transcript itself.
 * The first line is a marker so DenchClaw shows the row as a muted notice. A room message accepts only `text` and
 * `thread_id`, so the marker has to live in the text. Transcript text must not contain live @mentions, which would
 * pull extra members into round 0.
 */
export function inviteHandoff(host: string, invitee: string, session: { id: string; title?: string }, messages: HermesMessage[], task: string): string {
  const quiet = (text: string) => text.replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
  const turns = messages.filter((m) => (m.role === "user" || m.role === "assistant") && (m.text ?? "").trim());
  const last = (role: string) => turns.findLast((m) => m.role === role);
  const clip = (text: string) => { const t = quiet(text.trim()); return t.length > HANDOFF_TURN_CHARS ? `${t.slice(0, HANDOFF_TURN_CHARS)}…` : t; };
  const title = session.title && session.title !== "Untitled chat" && session.title !== "New chat" ? session.title : "";
  const ask = last("user"), reply = last("assistant");
  return [
    `[ROOM INVITE host=${host} session=${session.id} invitee=${invitee}]`,
    `@${invitee} The user invited you into this chat. It was a one-to-one chat with ${host}, so ${host} is now your teammate here.`,
    turns.length ? [
      `\nEarlier chat${title ? `: ${quiet(title)}` : ""} (${turns.length} messages).`,
      ask ? `Last user message: ${clip(ask.text)}` : "",
      reply ? `Last reply from ${host}: ${clip(reply.text)}` : "",
      `Full transcript, read-only: session_search(session_id="${session.id}", profile="${host}"). Open it only if you need more than this.`,
    ].filter(Boolean).join("\n") : "\nThe earlier chat had no messages.",
    task.trim() ? `\nThe user asks you: ${task.trim()}` : "\nCatch up, then add what is useful or ask the user what they need.",
  ].join("\n");
}
/** Turn a one-to-one chat into a group: new room with the host and the invitee, seeded with the recent transcript. */
export async function inviteToConversation(key: string, invitee: string, task = "", actor?: ConversationActor) {
  const { access } = await authorizeNativeConversation(actor,key,"derive");
  const identity = parseConversationKey(key);
  if (identity.kind !== "solo") throw new Error("Only a one-to-one chat can invite another agent");
  assertProfile(identity.profile); assertProfile(invitee);
  if (invitee === identity.profile) throw new Error("Pick a different agent than the one in this chat");
  const source = await readConversation(key,0,undefined,actor);
  const title = source.conversation.title;
  const room = await createConversation([identity.profile, invitee], title && title !== "Untitled chat" && title !== "New chat" ? `${title} · ${invitee}`.slice(0, 80) : undefined,actor,access);
  try {
    await groupRpc("groups.send", { room_id: room.id, event_id: `invite-${randomUUID()}`, payload: { text: inviteHandoff(identity.profile, invitee, { id: identity.id, title }, source.messages, task), thread_id: room.id } });
  } catch (error) {
    await groupRpc("groups.disband", { room_id: room.id }).catch(() => undefined);
    throw error;
  }
  return room;
}
