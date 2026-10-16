import { createHash } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import { buildAgentMessage, type WorkspaceContext } from "../agent-message";
import type { ImageAttachment } from "../agent-runner";
import { hydrateMessageImageAttachments, buildChatImageHydrationErrorMessage } from "../chat-image-attachments";
import { CHAT_IMAGE_EXTENSION_TO_MIME, MAX_CHAT_IMAGE_BYTES } from "../chat-image-common";
import { conversationKey, parseConversationKey, type HermesConversation, type HermesMessage } from "../hermes-conversations";
import { assertProfile, nativeFetch, readConversation, soloConversation } from "../hermes-native";
import { getHermesGatewayManager, type HermesGatewayManager, type PendingServerRequest } from "./manager";
import { lookupMessageHtml, saveMessageHtml, type MessageHtmlRecord } from "./message-html-store";
import type { SessionResumeResult } from "../../vendor/hermes-gateway/gateway-events";

export class ChatServiceError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface GatewayChatSnapshot {
  conversation: HermesConversation;
  messages: HermesMessage[];
  generation: number;
  seq: number;
  running: boolean;
  inflight: SessionResumeResult["inflight"];
  queued: SessionResumeResult["queued"];
  pendingRequests: PendingServerRequest[];
  todo_state: SessionResumeResult["todo_state"];
  html: MessageHtmlRecord[];
}
export interface GatewayPrompt {
  text: string;
  images?: ImageAttachment[];
  context?: WorkspaceContext;
  clientMessageId?: string;
  html?: string;
}
const promptSchema = z.object({
  text: z.string().min(1),
  images: z.array(z.object({ content: z.string(), mimeType: z.string(), fileName: z.string().optional() })).optional(),
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
  const parsed = promptSchema.safeParse(value);
  if (!parsed.success) throw new ChatServiceError(400, "invalid_prompt");
  return parsed.data;
}
export function authorizeConversation(key: string) {
  let identity;
  try { identity = parseConversationKey(key); } catch { throw new ChatServiceError(400, "invalid_conversation_key"); }
  if (identity.kind !== "solo") throw new ChatServiceError(400, "solo_conversation_required");
  try { assertProfile(identity.profile); } catch { throw new ChatServiceError(404, "unknown_profile"); }
  return identity;
}

export class HermesChatService {
  // session.create mints a runtime before Hermes persists the first user row.
  private readonly newConversations = new Map<string, HermesConversation>();
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
  async openForView(profile: string, storedId: string): Promise<GatewayChatSnapshot> {
    const key = conversationKey("solo", storedId, profile);
    authorizeConversation(key);
    const pending = this.newConversations.get(key);
    const source = await this.source(key);
    const retained = this.retainedKey(key);
    let resume: SessionResumeResult | undefined;
    if (source !== "cron" && source !== "webhook") {
      const active = await this.manager.call("session.active_list", { profile });
      if (active.sessions.some(row => row.session_key === storedId)) resume = await this.manager.resumeSession(retained);
    }
    const replay = this.manager.eventsSince(retained);
    const history = pending && this.newConversations.has(key)
      ? { conversation: pending, messages: [] }
      : await readConversation(key);
    history.conversation.source = source;
    return { ...history, generation: replay.generation, seq: replay.events.at(-1)?.seq ?? 0,
      running: Boolean(resume?.running), inflight: resume?.inflight, queued: resume?.queued,
      pendingRequests: this.manager.pendingRequests(retained), todo_state: resume?.todo_state,
      html: await lookupMessageHtml(profile, storedId) };
  }
  async sendPrompt(key: string, prompt: GatewayPrompt) {
    const identity = authorizeConversation(key);
    if (typeof prompt.text !== "string" || !prompt.text.trim() || Buffer.byteLength(prompt.text) > 65_536) throw new ChatServiceError(400, "invalid_prompt");
    await this.writable(key);
    const retained = this.retainedKey(key);
    return this.manager.serialize(retained, async () => {
      // Re-check inside the critical section: never stage an image into another queued send.
      await this.writable(key);
      let resume: SessionResumeResult | undefined;
      if (!this.manager.session(retained)?.runtimeId) resume = await this.manager.resumeSession(retained);
      const active = await this.manager.call("session.active_list", { profile: identity.profile });
      const runtime = this.manager.session(retained)?.runtimeId;
      const busy = Boolean(resume?.auto_continue || resume?.running || active.sessions.some(row => row.id === runtime && row.status !== "idle"));
      const workspace = assertProfile(identity.profile).workspaceDir;
      const text = buildAgentMessage({ userText: prompt.text, workspaceContext: prompt.context, workspacePrefix: workspace });
      const hydrated = hydrateMessageImageAttachments(text, workspace);
      const hydrationError = buildChatImageHydrationErrorMessage(hydrated.skipped);
      if (hydrationError) throw new ChatServiceError(400, hydrationError);
      const images = [...hydrated.attachments, ...(prompt.images ?? [])];
      for (const image of images) {
        if (!image || typeof image.content !== "string" || !Object.values(CHAT_IMAGE_EXTENSION_TO_MIME).includes(image.mimeType as typeof CHAT_IMAGE_EXTENSION_TO_MIME[".png"]) || Buffer.byteLength(image.content, "base64") > MAX_CHAT_IMAGE_BYTES) throw new ChatServiceError(400, "invalid_image");
      }
      const attached: string[] = [];
      const imageHashes = new Set<string>();
      try {
        for (const image of images) {
          // Uploaded images also appear in the attachment prefix; stage each byte payload once.
          const hash = createHash("sha256").update(Buffer.from(image.content, "base64")).digest("hex");
          if (imageHashes.has(hash)) continue;
          imageHashes.add(hash);
          const result = await this.manager.callSession(retained, "image.attach_bytes", { session_id: "", content_base64: image.content, filename: image.fileName, ext: extname(image.fileName ?? "") });
          if (!result.attached || !result.path) throw new ChatServiceError(502, "image_attach_failed");
          attached.push(result.path);
        }
        // Persist before submit: a lost acknowledgement must not lose reconciliation markup.
        if (prompt.html && prompt.clientMessageId) await saveMessageHtml(identity.profile, identity.id, prompt.clientMessageId, prompt.text, prompt.html);
        const result = await this.manager.callSession(retained, "prompt.submit", { session_id: "", text, queued: busy });
        return { ...result, autoContinue: Boolean(resume?.auto_continue) };
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
  async command(key: string, action: string, body: Record<string, unknown>) {
    const retained = this.retainedKey(key);
    await this.writable(key);
    // Commands act only on an existing runtime; viewing/interrupting must not cold-resume.
    if (!this.manager.session(retained)?.runtimeId) throw new ChatServiceError(409, "session_not_live");
    if (action === "interrupt") return this.manager.callSession(retained, "session.interrupt", { session_id: "" });
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
