import { createHash } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import { buildAgentMessage, stripAgentMessageContext, type WorkspaceContext } from "../agent-message";
import { hydrateMessageImageAttachments, buildChatImageHydrationErrorMessage } from "../chat-image-attachments";
import { conversationKey, parseConversationKey, type HermesConversation, type HermesMessage } from "../hermes-conversations";
import { assertProfile, hermesProfiles, inviteToConversation, nativeFetch, readConversation, soloConversation } from "../hermes-native";
import { getHermesGatewayManager, type HermesGatewayManager, type LiveSessionSnapshot, type PendingServerRequest } from "./manager";
import { lookupMessageHtml, saveMessageHtml, type MessageHtmlRecord } from "./message-html-store";
import type { SessionResumeResult, SessionUsageResult } from "../../vendor/hermes-gateway/gateway-events";
import { JsonRpcGatewayError } from "../../vendor/hermes-gateway/json-rpc-channel";
import { resolveAgentWorkspacePrefix } from "../workspace";

export class ChatServiceError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface GatewayChatSnapshot {
  conversation: HermesConversation;
  messages: (HermesMessage & { pending?: "inflight" | "queued" })[];
  generation: number;
  seq: number;
  running: boolean;
  inflight: SessionResumeResult["inflight"];
  queued: SessionResumeResult["queued"];
  pendingRequests: PendingServerRequest[];
  todo_state: SessionResumeResult["todo_state"];
  subagents?: LiveSessionSnapshot["subagents"];
  usage?: SessionUsageResult | null;
  html: MessageHtmlRecord[];
  gateway: "connected" | "unavailable";
  /** Opaque cursor for GET conversations/[key]/history?before=...&limit=200. */
  olderCursor?: string;
}
export interface GatewayPrompt {
  text: string;
  context?: WorkspaceContext;
  clientMessageId?: string;
  html?: string;
}
const promptSchema = z.object({
  text: z.string().min(1),
  clientMessageId: z.string().min(1).optional(),
  html: z.string().optional(),
  context: z.object({
    filePath: z.string().optional(), isDirectory: z.boolean().optional(),
    tableSelection: z.object({
      objectName: z.string(), kind: z.enum(["cells", "rows"]), rowCount: z.number(), columnCount: z.number(),
      columns: z.array(z.string()), updatedAt: z.number(),
      cells: z.array(z.object({ rowIndex: z.number(), entryId: z.string(), fieldName: z.string(), value: z.string() })).optional(),
      rows: z.array(z.object({ rowIndex: z.number(), entryId: z.string(), values: z.record(z.string(), z.string()) })).optional(),
    }).optional(),
  }).optional(),
});
/** Validate the browser boundary before touching the gateway or workspace files. */
export function parseGatewayPrompt(value: unknown): GatewayPrompt {
  if (value && typeof value === "object" && "html" in value && typeof value.html === "string" && Buffer.byteLength(value.html) > 262_144) throw new ChatServiceError(413, "message_html_too_large");
  if (value && typeof value === "object" && "clientMessageId" in value && typeof value.clientMessageId === "string" && Buffer.byteLength(value.clientMessageId) > 256) throw new ChatServiceError(400, "invalid_client_message_id");
  const parsed = promptSchema.safeParse(value);
  if (!parsed.success) throw new ChatServiceError(400, "invalid_prompt");
  return parsed.data;
}
/** Offer /invite and its agent argument; Hermes does not know this command. */
export function inviteCompletion<T extends { items: { text: string; display?: string; meta?: string }[]; replace_from: number }>(text: string, self: string, completion: T): T {
  const argument = /^\/invite\s+(\S*)$/i.exec(text);
  if (argument) {
    const items = hermesProfiles().filter((profile) => profile !== self && profile.toLowerCase().startsWith(argument[1].toLowerCase())).map((profile) => ({ text: profile, display: profile, meta: `Invite ${profile} into this chat` })) as T["items"];
    return { ...completion, items, replace_from: text.length - argument[1].length };
  }
  const command = /^\/(\S*)$/.exec(text);
  if (command && "invite".startsWith(command[1].toLowerCase())) {
    return { ...completion, items: [{ text: "/invite", display: "/invite", meta: "Invite another agent into this chat (makes it a group)" }, ...completion.items.filter((item) => item.text !== "/invite")] as T["items"] };
  }
  return completion;
}
export function authorizeConversation(key: string) {
  let identity;
  try { identity = parseConversationKey(key); } catch { throw new ChatServiceError(400, "invalid_conversation_key"); }
  if (identity.kind !== "solo") throw new ChatServiceError(400, "solo_conversation_required");
  try { assertProfile(identity.profile); } catch { throw new ChatServiceError(404, "unknown_profile"); }
  return identity;
}

// config.set model parses CLI flags, not a structured model/provider object. Keep browser picks
// single tokens so they cannot inject --global/--once or other model-switch options.
const modelToken = z.string().trim().min(1).max(1024).regex(/^[^\s\p{Cc}]+$/u).refine(value => !/^[-\u2012-\u2015]/.test(value));
const modelSelectionSchema = z.object({ model: modelToken, provider: modelToken.optional(), confirm: z.boolean().optional() }).strict();
const reasoningSelectionSchema = z.object({
  effort: z.enum(["none", "false", "disabled", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
}).strict();

// Match Hermes' slash-token boundary: paths such as /usr/local are not commands.
// Arguments may span lines; preserve their interior whitespace for skills and prompts.
const slashText = z.string().max(65_536).refine(value => Buffer.byteLength(value) <= 65_536)
  .refine(value => !/(?![\t\n\r])\p{Cc}/u.test(value));
const slashCompletionSchema = z.object({
  text: slashText.refine(value => /^\/[^\s/]*(?:\s[\s\S]*)?$/u.test(value)),
}).strict();
const slashExecutionSchema = z.object({
  command: slashText.refine(value => /^\/[^\s/]+(?:\s[\s\S]*)?$/u.test(value)),
}).strict();

export class HermesChatService {
  // session.create mints a runtime before Hermes persists the first user row.
  private readonly newConversations = new Map<string, HermesConversation>();
  private readonly mediaWaits = new Map<string, (error: Error) => void>();
  private readonly requestListeners = new Map<string, Set<(request: PendingServerRequest) => void>>();
  constructor(readonly manager: HermesGatewayManager = getHermesGatewayManager()) {
    for (const method of ["approval", "clarify"] as const) manager.onServerRequest(method, request => {
      for (const [key, listeners] of this.requestListeners) {
        if (manager.session(key)?.runtimeId !== request.params.session_id) continue;
        for (const listener of listeners) listener(request);
      }
    });
  }
  subscribeRequests(key: string, listener: (request: PendingServerRequest) => void): () => void {
    const retained = this.retainedKey(key);
    let listeners = this.requestListeners.get(retained);
    if (!listeners) { listeners = new Set(); this.requestListeners.set(retained, listeners); }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.requestListeners.delete(retained);
    };
  }
  retainedKey(key: string): string {
    const identity = authorizeConversation(key);
    return this.manager.retainSession(identity.profile, identity.id);
  }
  private async source(key: string): Promise<string | undefined> {
    const identity = authorizeConversation(key);
    const response = await nativeFetch(identity.profile, `/api/sessions/${encodeURIComponent(identity.id)}`, {}, this.newConversations.has(key) ? [404] : []);
    if (response.status === 404 && this.newConversations.has(key)) return "crm";
    this.newConversations.delete(key);
    const row = await response.json();
    return (row.session ?? row).source;
  }
  private async writable(key: string): Promise<void> {
    const source = await this.source(key);
    if (source === "cron" || source === "webhook") throw new ChatServiceError(409, "automation_read_only");
  }
  async openForView(profile: string, storedId: string, pageOptions?: { before: number; limit: number }): Promise<GatewayChatSnapshot> {
    const key = conversationKey("solo", storedId, profile);
    authorizeConversation(key);
    const pending = this.newConversations.get(key);
    const source = await this.source(key);
    const retained = this.retainedKey(key);
    let resume: LiveSessionSnapshot | undefined;
    let gateway: GatewayChatSnapshot["gateway"] = "connected";
    try {
      if (source !== "cron" && source !== "webhook") {
        const active = await this.manager.call("session.active_list", { profile });
        for (const row of active.sessions.filter(row => row.session_key === storedId)) {
          resume = await this.manager.attachLive(retained, row.id);
          if (resume) break;
        }
      }
    } catch { gateway = "unavailable"; }
    // Frames received while REST is reading must remain replayable after this snapshot.
    const replay = resume?.replayBoundary ?? (() => { const state = this.manager.eventsSince(retained); return { generation: state.generation, seq: state.latestSeq }; })();
    const history = pending && this.newConversations.has(key)
      ? { conversation: pending, messages: [] }
      : await readConversation(key);
    history.conversation.source = source;
    const inflight = resume?.inflight ? { ...resume.inflight, user: stripAgentMessageContext(resume.inflight.user ?? "") } : resume?.inflight;
    const queued = resume?.queued ? { ...resume.queued, user: stripAgentMessageContext(resume.queued.user) } : resume?.queued;
    const messages: GatewayChatSnapshot["messages"] = history.messages.map(row => row.role === "user" ? {
      ...row, text: stripAgentMessageContext(row.text),
      ...(row.content ? { content: stripAgentMessageContext(row.content) } : {}),
      ...(row.parts ? { parts: row.parts.map(part => part.type === "text" && typeof part.text === "string" ? { ...part, text: stripAgentMessageContext(part.text) } : part) } : {}),
    } : row);
    const queueHead = queued?.user && [...messages].reverse().find(row => row.role === "user" && row.text === queued.user);
    const queueIndex = queueHead ? messages.indexOf(queueHead) : -1;
    if (queueIndex >= 0) {
      for (const row of messages.slice(queueIndex)) if (row.role === "user") row.pending = "queued";
    }
    const inflightRow = inflight?.user && [...messages].reverse().find(row => row.role === "user" && !row.pending && row.text === inflight.user);
    if (inflightRow) inflightRow.pending = "inflight";
    const page = this.pageMessages(messages, pageOptions ? Math.min(pageOptions.before, messages.length) : messages.length, pageOptions?.limit);
    // Usage is a read of an existing runtime, never a reason to resume an idle chat.
    // Older gateways may not implement it; history must remain available.
    const usage = gateway === "connected" && this.manager.session(retained)?.runtimeId
      ? await this.manager.callSession(retained, "session.usage", { session_id: "" }).catch(() => null)
      : null;
    return { ...history, ...page, usage, gateway, generation: replay.generation, seq: replay.seq,
      running: Boolean(resume?.running), inflight, queued, subagents: resume?.subagents,
      pendingRequests: gateway === "connected" ? this.manager.pendingRequests(retained) : [], todo_state: resume?.todo_state,
      html: await lookupMessageHtml(profile, storedId) };
  }
  private pageMessages(messages: GatewayChatSnapshot["messages"], before = messages.length, limit = 200) {
    const start = Math.max(0, before - limit);
    return { messages: messages.slice(start, before), ...(start ? { olderCursor: String(start) } : {}) };
  }
  async historyPage(key: string, before: string, limit = 200) {
    const identity = authorizeConversation(key);
    if (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new ChatServiceError(400, "invalid_history_cursor");
    // Reuse exactly the snapshot mapper and pending classification, without paging twice.
    const snapshot = await this.openForView(identity.profile, identity.id, { before: Number(before), limit });
    return { messages: snapshot.messages, olderCursor: snapshot.olderCursor };
  }
  async sendPrompt(key: string, prompt: GatewayPrompt) {
    const identity = authorizeConversation(key);
    if (typeof prompt.text !== "string" || !prompt.text.trim() || Buffer.byteLength(prompt.text) > 65_536) throw new ChatServiceError(400, "invalid_prompt");
    await this.writable(key);
    try { await this.manager.connect(); } catch { throw new ChatServiceError(503, "gateway_unavailable"); }
    const retained = this.retainedKey(key);
    return this.manager.serialize(retained, async () => {
      // Re-check inside the critical section: never stage an image into another send.
      await this.writable(key);
      let resume: SessionResumeResult | undefined;
      if (!this.manager.session(retained)?.runtimeId) resume = await this.manager.resumeSession(retained);
      const runtime = this.manager.session(retained)?.runtimeId;
      const workspace = resolveAgentWorkspacePrefix();
      const text = buildAgentMessage({ userText: prompt.text, workspaceContext: prompt.context, workspacePrefix: workspace });
      const hydrated = hydrateMessageImageAttachments(text, workspace);
      const hydrationError = buildChatImageHydrationErrorMessage(hydrated.skipped);
      if (hydrationError) throw new ChatServiceError(400, hydrationError);
      const images = hydrated.attachments;
      const attached: string[] = [];
      const imageHashes = new Set<string>();
      try {
        for (const image of images) {
          // The same file may be attached twice; stage each byte payload once.
          const hash = createHash("sha256").update(Buffer.from(image.content, "base64")).digest("hex");
          if (imageHashes.has(hash)) continue;
          imageHashes.add(hash);
          const result = await this.manager.callSession(retained, "image.attach_bytes", { session_id: "", content_base64: image.content, filename: image.fileName, ext: extname(image.fileName ?? "") });
          if (!result.attached || !result.path) throw new ChatServiceError(502, "image_attach_failed");
          attached.push(result.path);
        }
        // Persist before submit: a lost acknowledgement must not lose reconciliation markup.
        if (prompt.html && prompt.clientMessageId) await saveMessageHtml(identity.profile, identity.id, prompt.clientMessageId, prompt.text, prompt.html);
        // Register before submit: message.start can arrive before its acknowledgement.
        let claimed = false;
        let settle = () => {};
        const started = new Promise<void>(resolve => { settle = resolve; });
        let rejectDisconnected = (_error: Error) => {};
        const disconnected = new Promise<never>((_resolve, reject) => { rejectDisconnected = reject; });
        // Install the rejection handler even for queued/no-image submissions.
        void disconnected.catch(() => {});
        if (attached.length) this.mediaWaits.set(retained, rejectDisconnected);
        const stopNotices = this.manager.subscribeNotices(notice => {
          // Transport loss does not cancel an accepted turn. Manager restore activates
          // the same runtime and replays events.since before releasing held frames.
          if (notice.type === "resync" && notice.key === retained && notice.reason === "connection_restored") {
            void this.manager.attachLive(retained, runtime!).then(snapshot => {
              if (snapshot?.inflight?.status === "error" || snapshot?.inflight?.error) rejectDisconnected(new ChatServiceError(502, "prompt_failed"));
              else if (snapshot?.inflight?.assistant) { claimed = true; settle(); }
            }).catch(() => { /* A further disconnect is not a turn failure either. */ });
          }
          if (notice.type === "resync" && notice.key === retained && notice.reason === "session_reclaimed") rejectDisconnected(new ChatServiceError(409, "session_not_live"));
        });
        const unsubscribe = this.manager.subscribe(retained, event => {
          const payload = event.payload as { status?: string; error?: unknown } | undefined;
          if (!claimed && (event.type === "error" || (event.type === "message.complete" && (payload?.status === "error" || payload?.error)))) rejectDisconnected(new ChatServiceError(502, "prompt_failed"));
          else if (!claimed && event.type === "message.complete" && payload?.status === "interrupted") rejectDisconnected(new ChatServiceError(409, "prompt_cancelled"));
          else if (["message.start", "message.delta", "message.interim", "reasoning.delta", "reasoning.available", "tool.start", "tool.complete", "message.complete"].includes(event.type)) { claimed = true; settle(); }
        });
        try {
          // Steer, never queue: a busy turn gets the text injected after its next tool result without
          // being interrupted. An idle turn rejects the steer and the same text starts a normal turn.
          // Images cannot ride a steer, so they go as a plain submit (Hermes decides how to merge it).
          if (!attached.length) {
            // A resumed session whose agent is not built yet answers 4010 instead of "rejected";
            // there is no turn to steer, so the text starts (or queues behind) a normal turn.
            const steer = await this.manager.callSession(retained, "session.steer", { session_id: "", text }).catch((error: unknown) => {
              if (error instanceof JsonRpcGatewayError && error.code === 4010) {return { status: "rejected" as const };}
              throw error;
            });
            if (steer.status !== "rejected") return { status: "steered" as const, autoContinue: Boolean(resume?.auto_continue) };
          }
          const result = await this.manager.callSession(retained, "prompt.submit", { session_id: "", text });
          if (attached.length && result.status === "streaming" && !claimed) {
            // Accepted prompts may wait 600s for agent construction. Ownership has no
            // local deadline: later staging waits until claim or confirmed failure.
            await Promise.race([started, disconnected]);
          }
          return { ...result, autoContinue: Boolean(resume?.auto_continue) };
        } finally { unsubscribe(); stopNotices(); this.mediaWaits.delete(retained); }
      } catch (error) {
        // Use the captured runtime directly; a stale mutation must never detach in a new runtime.
        await Promise.allSettled(attached.map(path => this.manager.call("image.detach", { session_id: runtime!, profile: identity.profile, path })));
        throw error;
      }
    });
  }
  async createGatewayConversation(profiles: string[]) {
    if (!Array.isArray(profiles) || profiles.length !== 1) throw new ChatServiceError(400, "one_profile_required");
    const profile = profiles[0];
    assertProfile(profile);
    const result = await this.manager.call("session.create", { profile, source: "crm", cols: 120 });
    this.manager.retainSession(profile, result.stored_session_id, result.session_id);
    const conversation = soloConversation(profile, { id: result.stored_session_id, source: "crm", started_at: Date.now() / 1000 });
    this.newConversations.set(conversation.key, conversation);
    return conversation;
  }
  async branchConversation(key: string) {
    const identity = authorizeConversation(key);
    await this.source(key);
    const result = await this.manager.call("session.branch_stored", { parent_session_id: identity.id, profile: identity.profile, source: "crm" });
    this.manager.retainSession(identity.profile, result.stored_session_id, result.session_id);
    return soloConversation(identity.profile, { id: result.stored_session_id, source: "crm", started_at: Date.now() / 1000 });
  }
  private async liveControls(key: string): Promise<string> {
    const retained = this.retainedKey(key);
    await this.writable(key);
    try { await this.manager.connect(); } catch { throw new ChatServiceError(503, "gateway_unavailable"); }
    return retained;
  }
  async modelOptions(key: string) {
    const identity = authorizeConversation(key);
    const retained = await this.liveControls(key);
    if (this.manager.session(retained)?.runtimeId) {
      const [options, reasoning, fast] = await Promise.all([
        this.manager.callSession(retained, "model.options", { session_id: "" }),
        this.manager.callSession(retained, "config.get", { session_id: "", key: "reasoning" }),
        this.manager.callSession(retained, "config.get", { session_id: "", key: "fast" }),
      ]);
      return { ...options, reasoning, fast: fast.value === "fast" || fast.value === "ultrafast" };
    }
    // Idle chat: read the profile's catalogue without resuming it; the stored row names its model.
    const [options, reasoning, fast, stored] = await Promise.all([
      this.manager.call("model.options", { profile: identity.profile }),
      this.manager.call("config.get", { profile: identity.profile, key: "reasoning" }),
      this.manager.call("config.get", { profile: identity.profile, key: "fast" }),
      nativeFetch(identity.profile, `/api/sessions/${encodeURIComponent(identity.id)}`, {}, [404]).then(response => response.ok ? response.json() : null),
    ]);
    const model = typeof stored?.session?.model === "string" && stored.session.model ? stored.session.model : options.model;
    const provider = model === options.model ? options.provider : options.providers.find(row => row.models?.includes(model))?.slug ?? options.provider;
    return { ...options, model, provider, reasoning, fast: fast.value === "fast" || fast.value === "ultrafast" };
  }
  async slashComplete(key: string, body: unknown) {
    const parsed = slashCompletionSchema.safeParse(body);
    if (!parsed.success) { throw new ChatServiceError(400, "invalid_slash_text"); }
    const identity = authorizeConversation(key);
    await this.source(key);
    try { await this.manager.connect(); } catch { throw new ChatServiceError(503, "gateway_unavailable"); }
    const retained = this.retainedKey(key);
    // Completion is a read: only use an already retained runtime, never resume an idle chat.
    const [completion, catalog] = this.manager.session(retained)?.runtimeId
      ? await Promise.all([
        this.manager.callSession(retained, "complete.slash", { text: parsed.data.text }),
        this.manager.callSession(retained, "commands.catalog", {}),
      ])
      : await Promise.all([
        this.manager.call("complete.slash", { text: parsed.data.text, profile: identity.profile }),
        this.manager.call("commands.catalog", { profile: identity.profile }),
      ]);
    return inviteCompletion(parsed.data.text, identity.profile, { ...completion, items: completion.items ?? [], replace_from: completion.replace_from ?? 1, catalog });
  }
  async slashExecute(key: string, body: unknown) {
    const parsed = slashExecutionSchema.safeParse(body);
    if (!parsed.success) { throw new ChatServiceError(400, "invalid_slash_command"); }
    const identity = authorizeConversation(key);
    const command = parsed.data.command;
    const parts = /^\/(\S+)([\s\S]*)$/u.exec(command)!;
    const name = parts[1].toLowerCase();
    const arg = parts[2].trim();
    // Not a Hermes command: it replaces this chat with a group that includes the invited agent.
    if (name === "invite") {
      const [invitee, ...task] = arg.split(/\s+/);
      if (!invitee) { throw new ChatServiceError(400, "invite_needs_agent"); }
      if (!hermesProfiles().includes(invitee)) { throw new ChatServiceError(404, "unknown_profile"); }
      if (invitee === identity.profile) { throw new ChatServiceError(400, "invite_same_agent"); }
      await this.writable(key);
      return { conversation: await inviteToConversation(key, invitee, task.join(" ")) };
    }
    const retained = await this.liveControls(key);
    return this.manager.serialize(retained, async () => {
      await this.writable(key);
      // These create openable CRM conversations rather than mutating a slash worker's session.
      if (name === "new") { return { conversation: await this.createGatewayConversation([identity.profile]) }; }
      if (name === "branch") { return { conversation: await this.branchConversation(key) }; }
      if (!this.manager.session(retained)?.runtimeId) { await this.manager.resumeSession(retained); }
      try {
        return await this.manager.callSession(retained, "slash.exec", { session_id: "", command });
      } catch (error) {
        if (!(error instanceof JsonRpcGatewayError) || error.code !== 4018) { throw error; }
        return this.manager.callSession(retained, "command.dispatch", { name, arg });
      }
    });
  }
  async command(key: string, action: string, body: Record<string, unknown>) {
    const retained = await this.liveControls(key);
    if (action === "model" || action === "reasoning" || action === "fast") {
      // A pick is an explicit intent to use this chat, so an idle chat resumes like a send would.
      await this.manager.serialize(retained, async () => {
        if (!this.manager.session(retained)?.runtimeId) {await this.manager.resumeSession(retained);}
      });
    } else if (!this.manager.session(retained)?.runtimeId) {
      throw new ChatServiceError(409, "session_not_live");
    }
    if (action === "model") {
      const parsed = modelSelectionSchema.safeParse(body);
      if (!parsed.success) { throw new ChatServiceError(400, "invalid_model"); }
      const { model, provider, confirm } = parsed.data;
      // Model persistence is controlled by CLI flags, not the RPC scope field. Pin both.
      const value = `${model}${provider ? ` --provider ${provider}` : ""} --session`;
      return this.manager.callSession(retained, "config.set", { session_id: "", key: "model", value, scope: "session", confirm_expensive_model: confirm ?? false });
    }
    if (action === "fast") {
      if (typeof body.enabled !== "boolean") { throw new ChatServiceError(400, "invalid_fast"); }
      return this.manager.callSession(retained, "config.set", { session_id: "", key: "fast", value: body.enabled ? "fast" : "normal", scope: "session" });
    }
    if (action === "reasoning") {
      const parsed = reasoningSelectionSchema.safeParse(body);
      if (!parsed.success) { throw new ChatServiceError(400, "invalid_reasoning"); }
      return this.manager.callSession(retained, "config.set", { session_id: "", key: "reasoning", value: parsed.data.effort, scope: "session" });
    }
    if (action === "interrupt") {
      const result = await this.manager.callSession(retained, "session.interrupt", { session_id: "" });
      if (result.status === "interrupted") this.mediaWaits.get(retained)?.(new ChatServiceError(409, "prompt_cancelled"));
      return result;
    }
    if (action === "steer") {
      if (typeof body.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 65_536) throw new ChatServiceError(400, "invalid_text");
      return this.manager.callSession(retained, body.mode === "redirect" ? "session.redirect" : "session.steer", { session_id: "", text: body.text });
    }
    if (action === "approval" || action === "clarify") {
      const request = this.manager.pendingRequests(retained).find(request => request.method === action && (action === "approval" ? request.params.request_id === body.request_id : request.id === body.request_id));
      if (!request) throw new ChatServiceError(403, "request_not_owned");
      if (action === "approval") {
        if (!["once", "session", "always", "deny"].includes(String(body.choice))) throw new ChatServiceError(400, "invalid_choice");
        await this.manager.callSession(retained, "approval.received", { session_id: "", request_id: String(body.request_id) });
        this.manager.respondToRequest(retained, request.id, { choice: body.choice as "once" | "session" | "always" | "deny" });
      } else {
        const answers = z.record(z.string(), z.string().nullable()).safeParse(body.answers);
        if (!answers.success) throw new ChatServiceError(400, "invalid_answers");
        this.manager.respondToRequest<"clarify">(retained, request.id, { answers: answers.data });
      }
      return { accepted: true };
    }
    if (action === "subagent") {
      if (body.action === "list") return this.manager.callSession(retained, "subagent.list", { session_id: "" });
      if (typeof body.subagent_id !== "string" || !body.subagent_id) throw new ChatServiceError(400, "invalid_subagent_id");
      const params = { session_id: "", subagent_id: body.subagent_id };
      if (body.action === "tail") return this.manager.callSession(retained, "subagent.tail", params);
      if (body.action === "interrupt") return this.manager.callSession(retained, "subagent.interrupt", params);
      if (body.action === "steer" && typeof body.text === "string" && body.text.trim()) return this.manager.callSession(retained, "subagent.steer", { ...params, text: body.text });
    }
    throw new ChatServiceError(400, "invalid_action");
  }
}
const globalChat = globalThis as typeof globalThis & { __hermesChatService?: HermesChatService };
export function getHermesChatService(): HermesChatService {
  return globalChat.__hermesChatService ??= new HermesChatService();
}
export function openForView(profile: string, storedId: string) { return getHermesChatService().openForView(profile, storedId); }
export function sendPrompt(key: string, prompt: GatewayPrompt) { return getHermesChatService().sendPrompt(key, prompt); }
export function createGatewayConversation(profiles: string[]) { return getHermesChatService().createGatewayConversation(profiles); }
export function branchConversation(key: string) { return getHermesChatService().branchConversation(key); }
