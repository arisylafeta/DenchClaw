import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../hermes-native", () => ({
  dashboardToken: vi.fn(), invalidateDashboardToken: vi.fn(),
  assertProfile: vi.fn((profile: string) => { if (profile !== "ari") throw new Error("unknown"); return { workspaceDir: "/workspace" }; }),
  nativeFetch: vi.fn(async () => Response.json({ source: "crm" })),
  readConversation: vi.fn(async () => ({ conversation: { key: "one", source: "crm" }, messages: [] })),
  soloConversation: vi.fn((profile: string, row: { id: string }) => ({ key: encodeURIComponent(JSON.stringify(["solo", profile, row.id])), profile, ...row })),
}));
vi.mock("./message-html-store", () => ({ lookupMessageHtml: vi.fn(async () => []), saveMessageHtml: vi.fn() }));
vi.mock("../chat-image-attachments", () => ({ hydrateMessageImageAttachments: vi.fn(() => ({ attachments: [], skipped: [] })), buildChatImageHydrationErrorMessage: vi.fn(() => null) }));
import { nativeFetch } from "../hermes-native";
import { hydrateMessageImageAttachments } from "../chat-image-attachments";
import { HermesGatewayManager, type GatewaySocket } from "./manager";
import { HermesChatService } from "./chat-service";
import { conversationKey } from "../hermes-conversations";

type Frame = { id?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
class FakeSocket implements GatewaySocket {
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  frames: Frame[] = [];
  failPrompt = false;
  busy = false;
  autoContinue = false;
  addEventListener(type: string, handler: (event: unknown) => void) { (this.listeners[type] ??= []).push(handler); }
  emit(type: string, event: unknown = {}) { for (const handler of this.listeners[type] ?? []) handler(event); }
  receive(frame: Frame) { this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", ...frame }) }); }
  send(text: string) {
    const frame = JSON.parse(text) as Frame; this.frames.push(frame);
    if (!frame.method || frame.method === "event") return;
    if (frame.method === "prompt.submit" && this.failPrompt) { this.receive({ id: frame.id, error: { code: 4001, message: "stale" } }); return; }
    const result = frame.method === "session.resume" ? { session_id: `runtime-${frame.params?.session_id}`, running: this.busy, auto_continue: this.autoContinue ? { attempt: 1 } : undefined }
      : frame.method === "session.active_list" ? { sessions: this.busy ? [{ id: "runtime-one", session_key: "one", status: "working" }] : [] }
      : frame.method === "image.attach_bytes" ? { attached: true, path: "/image" }
      : frame.method === "session.create" ? { session_id: "runtime-one", stored_session_id: "one" }
      : frame.method === "prompt.submit" ? { status: this.busy ? "queued" : "streaming" }
      : frame.method === "session.events.since" ? { events: [], latest_seq: 0, epoch: "e" } : {};
    this.receive({ id: frame.id, result });
  }
  close() {}
}
let manager: HermesGatewayManager;
let socket: FakeSocket;
let service: HermesChatService;
const key = conversationKey("solo", "one", "ari");
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(nativeFetch).mockImplementation(async () => Response.json({ source: "crm" }));
  socket = new FakeSocket();
  manager = new HermesGatewayManager({ url: "ws://127.0.0.1/api/ws", tokenProvider: async () => "token", socketFactory: () => socket });
  const connected = manager.connect(); await flush(); socket.emit("open"); socket.receive({ method: "event", params: { type: "gateway.ready", payload: { replay_epoch: "e" } } }); await connected; await flush();
  service = new HermesChatService(manager);
});
afterEach(() => manager.shutdown());
describe("gateway chat service", () => {
  it("does not resume an idle history view", async () => {
    await service.openForView("ari", "one");
    expect(socket.frames.some(frame => frame.method === "session.resume")).toBe(false);
  });
  it("rejects REST automation sources before mutation", async () => {
    vi.mocked(nativeFetch).mockResolvedValue(Response.json({ session: { source: "cron" } }));
    await expect(service.sendPrompt(key, { text: "hello" })).rejects.toMatchObject({ status: 409, message: "automation_read_only" });
    expect(socket.frames.some(frame => frame.method === "prompt.submit")).toBe(false);
  });
  it("serializes attachment staging and submits queued when busy", async () => {
    socket.busy = true;
    const image = { content: "aGVsbG8=", mimeType: "image/png", fileName: "a.png" };
    await Promise.all([service.sendPrompt(key, { text: "first", images: [image] }), service.sendPrompt(key, { text: "second", images: [image] })]);
    expect(socket.frames.filter(frame => ["image.attach_bytes", "prompt.submit"].includes(frame.method ?? "")).map(frame => frame.method)).toEqual(["image.attach_bytes", "prompt.submit", "image.attach_bytes", "prompt.submit"]);
    expect(socket.frames.filter(frame => frame.method === "prompt.submit").every(frame => frame.params?.queued)).toBe(true);
  });
  it("attaches matching prefix and explicit image bytes only once, retaining distinct images", async () => {
    const image = { content: "aGVsbG8=", mimeType: "image/png", fileName: "a.png" };
    vi.mocked(hydrateMessageImageAttachments).mockReturnValueOnce({ attachmentPaths: ["a.png"], imagePaths: ["a.png"], attachments: [image], skipped: [] });
    await service.sendPrompt(key, { text: "[Attached files: a.png]\n\nInspect", images: [{ ...image, fileName: "renamed.png" }, { ...image, content: "ZGlmZmVyZW50", fileName: "b.png" }] });
    const staged = socket.frames.filter(frame => frame.method === "image.attach_bytes");
    expect(staged).toHaveLength(2);
    expect(staged.map(frame => frame.params?.content_base64)).toEqual(["aGVsbG8=", "ZGlmZmVyZW50"]);
  });
  it("detaches staged images and never retries stale prompt mutations", async () => {
    socket.failPrompt = true;
    await expect(service.sendPrompt(key, { text: "first", images: [{ content: "aGVsbG8=", mimeType: "image/png", fileName: "a.png" }] })).rejects.toThrow("stale");
    expect(socket.frames.filter(frame => frame.method === "prompt.submit")).toHaveLength(1);
    expect(socket.frames.find(frame => frame.method === "image.detach")?.params).toMatchObject({ session_id: "runtime-one", path: "/image" });
  });
  it("rejects another conversation's approval request and responds on the srq id", async () => {
    manager.retainSession("ari", "one", "runtime-one"); manager.retainSession("ari", "two", "runtime-two");
    socket.receive({ id: "srq-a", method: "approval", params: { session_id: "runtime-one", request_id: "payload-a" } });
    await expect(service.command(conversationKey("solo", "two", "ari"), "approval", { request_id: "payload-a", choice: "once" })).rejects.toMatchObject({ status: 403 });
    await service.command(key, "approval", { request_id: "payload-a", choice: "once" });
    expect(socket.frames.at(-1)).toMatchObject({ id: "srq-a", result: { choice: "once" } });
    expect(socket.frames.some(frame => frame.method === "approval.received" && frame.params?.request_id === "payload-a")).toBe(true);
  });
  it("surfaces auto-continue and queues the deliberate send", async () => {
    socket.autoContinue = true;
    const result = await service.sendPrompt(key, { text: "continue" });
    expect(result.autoContinue).toBe(true);
    expect(socket.frames.find(frame => frame.method === "prompt.submit")?.params?.queued).toBe(true);
  });
  it("allows a freshly created CRM runtime before its first durable row exists", async () => {
    const conversation = await service.createGatewayConversation(["ari"]);
    vi.mocked(nativeFetch).mockImplementation(async () => new Response(null, { status: 404 }));
    await service.sendPrompt(conversation.key, { text: "first row" });
    expect(socket.frames.find(frame => frame.method === "prompt.submit")?.params?.session_id).toBe("runtime-one");
  });
  it("fans live requests to only the owning conversation and answers clarify by srq", async () => {
    manager.retainSession("ari", "one", "runtime-one");
    manager.retainSession("ari", "two", "runtime-two");
    const received = vi.fn();
    const foreign = vi.fn();
    const unsubscribe = service.subscribeRequests(key, received);
    const stopOther = service.subscribeRequests(conversationKey("solo", "two", "ari"), foreign);
    socket.receive({ id: "srq-question", method: "clarify", params: { session_id: "runtime-one", questions: [] } });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: "srq-question" }));
    expect(foreign).not.toHaveBeenCalled();
    await service.command(key, "clarify", { request_id: "srq-question", answers: { question: "yes" } });
    expect(socket.frames.at(-1)).toMatchObject({ id: "srq-question", result: { answers: { question: "yes" } } });
    unsubscribe(); stopOther();
  });
});
