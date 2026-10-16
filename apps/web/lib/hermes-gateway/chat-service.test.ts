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
vi.mock("../workspace", () => ({ resolveAgentWorkspacePrefix: () => "/source-workspace" }));
import { nativeFetch, readConversation } from "../hermes-native";
import { hydrateMessageImageAttachments } from "../chat-image-attachments";
import { HermesGatewayManager, type GatewaySocket } from "./manager";
import { HermesChatService } from "./chat-service";
import { conversationKey } from "../hermes-conversations";
import { buildAgentMessage } from "../agent-message";

type Frame = { id?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
class FakeSocket implements GatewaySocket {
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  frames: Frame[] = [];
  failPrompt = false;
  busy = false;
  autoContinue = false;
  addEventListener(type: string, handler: (event: unknown) => void) { (this.listeners[type] ??= []).push(handler); }
  deferConsumption = false;
  activeRows: { id: string; session_key: string; status: string }[] = [];
  snapshot: Record<string, unknown> = {};
  replayEvents: unknown[] = [];
  onChildren?: () => void;
  emit(type: string, event: unknown = {}) { for (const handler of this.listeners[type] ?? []) handler(event); }
  receive(frame: Frame) { this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", ...frame }) }); }
  send(text: string) {
    const frame = JSON.parse(text) as Frame; this.frames.push(frame);
    if (!frame.method || frame.method === "event") return;
    if (frame.method === "subagent.list") this.onChildren?.();
    if (frame.method === "prompt.submit" && this.failPrompt) { this.receive({ id: frame.id, error: { code: 4001, message: "stale" } }); return; }
    const result = frame.method === "session.resume" ? { session_id: `runtime-${frame.params?.session_id}`, running: this.busy, auto_continue: this.autoContinue ? { attempt: 1 } : undefined }
      : frame.method === "session.active_list" ? { sessions: this.activeRows }
      : frame.method === "session.activate" ? { session_id: frame.params?.session_id, session_key: "one", info: { profile_name: "ari", lazy: false, cwd: "/workspace", branch: "", project: {}, model: "test", skills: {}, tools: {} }, ...this.snapshot }
      : frame.method === "image.attach_bytes" ? { attached: true, path: "/image" }
      : frame.method === "session.create" ? { session_id: "runtime-one", stored_session_id: "one" }
      : frame.method === "session.interrupt" ? { status: "interrupted" }
      : frame.method === "prompt.submit" ? { status: this.busy ? "queued" : "streaming" }
      : frame.method === "session.events.since" ? { events: this.replayEvents, latest_seq: 100, epoch: "e" } : {};
    this.receive({ id: frame.id, result });
    if (frame.method === "prompt.submit" && !this.busy && !this.deferConsumption) this.receive({ method: "event", params: { type: "message.start", session_id: "runtime-one", seq: this.frames.length, payload: {} } });
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
afterEach(() => { manager.shutdown(); vi.useRealTimers(); });
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
    await expect(service.sendPrompt(key, { text: "first", images: [{ content: "aGVsbG8=", mimeType: "image/png", fileName: "a.png" }] })).rejects.toThrow("session_not_live");
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
  it("holds staged images until the streaming turn claims them, even after acknowledgement", async () => {
    socket.deferConsumption = true;
    const image = { content: "aGVsbG8=", mimeType: "image/png" };
    const first = service.sendPrompt(key, { text: "first", images: [image] });
    await flush(); await flush();
    const second = service.sendPrompt(key, { text: "second", images: [image] });
    await flush(); await flush();
    expect(socket.frames.filter(frame => frame.method === "image.attach_bytes")).toHaveLength(1);
    socket.receive({ method: "event", params: { type: "message.start", session_id: "runtime-one", seq: 100, payload: {} } });
    await first; await flush(); await flush();
    expect(socket.frames.filter(frame => frame.method === "image.attach_bytes")).toHaveLength(2);
    socket.receive({ method: "event", params: { type: "message.start", session_id: "runtime-one", seq: 101, payload: {} } });
    await second;
  });
  it("resolves viewed files and image paths in the source workspace, not the bot workspace", async () => {
    await service.sendPrompt(key, { text: "inspect", context: { filePath: "doc.md" } });
    expect(socket.frames.find(frame => frame.method === "prompt.submit")?.params).toMatchObject({ text: "[Context: workspace file '/source-workspace/doc.md']\n\ninspect", queued: true });
    expect(hydrateMessageImageAttachments).toHaveBeenCalledWith("[Context: workspace file '/source-workspace/doc.md']\n\ninspect", "/source-workspace");
  });
  it("reads durable history when the gateway is unavailable", async () => {
    vi.spyOn(manager, "call").mockRejectedValue(new Error("offline"));
    const snapshot = await service.openForView("ari", "one");
    expect(snapshot.gateway).toBe("unavailable");
    expect(readConversation).toHaveBeenCalled();
  });
  it("uses warm-only activation and strips context on durable, inflight and merged queued rows", async () => {
    const context = { filePath: "doc.md", tableSelection: { objectName: "companies", kind: "rows" as const, rowCount: 1, columnCount: 1, columns: ["name"], updatedAt: 1, rows: [{ rowIndex: 0, entryId: "a", values: { name: "Acme" } }] } };
    const inflight = buildAgentMessage({ userText: "first", workspaceContext: context });
    const queued = buildAgentMessage({ userText: "second", workspaceContext: context });
    socket.activeRows = [{ id: "runtime-one", session_key: "one", status: "working" }];
    socket.snapshot = { running: true, inflight: { user: inflight }, queued: { user: queued } };
    vi.mocked(readConversation).mockResolvedValueOnce({ conversation: { key, kind: "solo", id: "one", title: "Chat", updatedAt: 0, participants: [], working: true, source: "crm" }, messages: [{ id: "1", role: "user", text: inflight }, { id: "2", role: "user", text: queued }, { id: "3", role: "user", text: buildAgentMessage({ userText: "[Attached files: photo.png]\n\nthird", workspaceContext: context }) }, { id: "4", role: "user", text: "fourth" }] });
    const snapshot = await service.openForView("ari", "one");
    expect(snapshot.messages).toMatchObject([{ text: "first", pending: "inflight" }, { text: "second", pending: "queued" }, { text: "[Attached files: photo.png]\n\nthird", pending: "queued" }, { text: "fourth", pending: "queued" }]);
    expect(snapshot.inflight?.user).toBe("first");
    expect(snapshot.queued?.user).toBe("second");
    expect(socket.frames.some(frame => frame.method === "session.resume")).toBe(false);
  });
  it("ignores a different profile's identical stored id and tolerates a vanished runtime", async () => {
    socket.activeRows = [{ id: "foreign", session_key: "one", status: "working" }];
    socket.snapshot = { info: { profile_name: "alex" }, running: true };
    expect((await service.openForView("ari", "one")).running).toBe(false);
    expect(manager.session(service.retainedKey(key))?.runtimeId).toBeUndefined();
    vi.spyOn(manager, "attachLive").mockResolvedValue(undefined);
    expect((await service.openForView("ari", "one")).messages).toEqual([]);
    expect(socket.frames.some(frame => frame.method === "session.resume")).toBe(false);
  });
  it("retains accepted media beyond the former deadline and serializes the next image", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    socket.deferConsumption = true;
    const image = { content: "aGVsbG8=", mimeType: "image/png" };
    const first = service.sendPrompt(key, { text: "first", images: [image] });
    await flush(); await flush();
    const second = service.sendPrompt(key, { text: "second", images: [image] });
    await flush();
    // Keep the manager transport alive while Hermes spends >120s constructing.
    for (let i = 0; i < 9; i++) {
      socket.receive({ method: "event", params: { type: "gateway.pong", payload: {} } });
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(socket.frames.filter(frame => frame.method === "image.detach")).toHaveLength(0);
    expect(socket.frames.filter(frame => frame.method === "image.attach_bytes")).toHaveLength(1);
    socket.receive({ method: "event", params: { type: "message.start", session_id: "runtime-one", seq: 100, payload: {} } });
    await first; await flush(); await flush();
    expect(socket.frames.filter(frame => frame.method === "image.attach_bytes")).toHaveLength(2);
    socket.receive({ method: "event", params: { type: "message.start", session_id: "runtime-one", seq: 101, payload: {} } });
    await second;
  });
  it("keeps history-read concurrent completion after the snapshot watermark", async () => {
    const retained = manager.retainSession("ari", "one", "runtime-one");
    vi.mocked(readConversation).mockImplementationOnce(async () => {
      socket.receive({ method: "event", params: { type: "message.complete", session_id: "runtime-one", seq: 42, payload: { text: "done" } } });
      return { conversation: { key, kind: "solo", id: "one", title: "Chat", updatedAt: 0, participants: [], working: false }, messages: [] };
    });
    const snapshot = await service.openForView("ari", "one");
    expect(snapshot.seq).toBe(0);
    expect(manager.eventsSince(retained, snapshot.generation, snapshot.seq).events).toMatchObject([{ type: "message.complete", seq: 42 }]);
  });
  it("pages large history and uses the same context mapping on older pages", async () => {
    const messages = Array.from({ length: 450 }, (_, id) => ({ id: String(id), role: "user" as const, text: buildAgentMessage({ userText: `row ${id}`, workspaceContext: { filePath: "doc.md" } }) }));
    vi.mocked(readConversation).mockResolvedValue({ conversation: { key, kind: "solo", id: "one", title: "Chat", updatedAt: 0, participants: [], working: false }, messages });
    const snapshot = await service.openForView("ari", "one");
    expect(snapshot.messages).toHaveLength(200);
    expect(snapshot.messages[0].text).toBe("row 250");
    expect(snapshot.olderCursor).toBe("250");
    const older = await service.historyPage(key, snapshot.olderCursor!);
    expect(older.messages).toHaveLength(200);
    expect(older.messages[0].text).toBe("row 50");
    expect(older.olderCursor).toBe("50");
    expect((await service.historyPage(key, older.olderCursor!)).messages).toHaveLength(50);
  });
  it("releases unclaimed media on a confirmed cancellation", async () => {
    socket.deferConsumption = true;
    const pending = service.sendPrompt(key, { text: "first", images: [{ content: "aGVsbG8=", mimeType: "image/png" }] });
    const rejected = expect(pending).rejects.toThrow("prompt_cancelled");
    await flush(); await flush();
    await service.command(key, "interrupt", {});
    await rejected;
    expect(socket.frames.find(frame => frame.method === "image.detach")?.params).toMatchObject({ session_id: "runtime-one", path: "/image" });
  });
  it.each(["message.complete", "error"])("rejects initialization %s before media admission", async type => {
    socket.deferConsumption = true;
    const pending = service.sendPrompt(key, { text: "first", images: [{ content: "aGVsbG8=", mimeType: "image/png" }] });
    const rejected = expect(pending).rejects.toMatchObject({ status: 502, message: "prompt_failed" });
    await flush(); await flush();
    socket.receive({ method: "event", params: { type, session_id: "runtime-one", seq: 100, payload: type === "error" ? { message: "Agent initialization failed" } : { text: "", status: "error", error: "Agent initialization failed", recoverable: true, error_surface: { layer: "runtime", code: "agent_init_failed", retryable: true } } } });
    await rejected;
    expect(socket.frames.filter(frame => frame.method === "image.detach")).toHaveLength(1);
  });
  it("keeps accepted media through disconnect and reconciles the claim via events.since", async () => {
    socket.deferConsumption = true;
    const pending = service.sendPrompt(key, { text: "first", images: [{ content: "aGVsbG8=", mimeType: "image/png" }] });
    await flush(); await flush();
    const oldSocket = socket;
    oldSocket.emit("close", { code: 1006 });
    socket = new FakeSocket();
    socket.replayEvents = [{ type: "message.start", session_id: "runtime-one", seq: 100 }];
    const connected = manager.connect(); await flush();
    socket.emit("open"); socket.receive({ method: "event", params: { type: "gateway.ready", payload: { replay_epoch: "e" } } });
    await connected; await pending;
    expect([...oldSocket.frames, ...socket.frames].filter(frame => frame.method === "image.detach")).toHaveLength(0);
    expect(socket.frames.some(frame => frame.method === "session.events.since")).toBe(true);
    expect(socket.frames.some(frame => frame.method === "prompt.submit")).toBe(false);
  });
  it("cleans up accepted media only after reconnect confirms a retained initialization failure", async () => {
    socket.deferConsumption = true;
    const pending = service.sendPrompt(key, { text: "first", images: [{ content: "aGVsbG8=", mimeType: "image/png" }] });
    const rejected = expect(pending).rejects.toMatchObject({ status: 502, message: "prompt_failed" });
    await flush(); await flush();
    const oldSocket = socket;
    oldSocket.emit("close", { code: 1006 });
    socket = new FakeSocket();
    socket.snapshot = { running: false, inflight: { user: "first", assistant: "", status: "error", error: "Agent initialization failed", recoverable: true, error_surface: { layer: "runtime", code: "agent_init_failed", retryable: true } } };
    const connected = manager.connect(); await flush();
    socket.emit("open"); socket.receive({ method: "event", params: { type: "gateway.ready", payload: { replay_epoch: "e" } } });
    await connected; await rejected;
    expect(oldSocket.frames.some(frame => frame.method === "image.detach")).toBe(false);
    expect(socket.frames.filter(frame => frame.method === "image.detach")).toHaveLength(1);
  });
  it("does not detach accepted media when interrupt reports not_interrupted", async () => {
    socket.deferConsumption = true;
    const pending = service.sendPrompt(key, { text: "first", images: [{ content: "aGVsbG8=", mimeType: "image/png" }] });
    await flush(); await flush();
    const call = vi.spyOn(manager, "callSession").mockResolvedValueOnce({ status: "not_interrupted", interrupted: false } as never);
    await service.command(key, "interrupt", {}); await flush();
    expect(socket.frames.some(frame => frame.method === "image.detach")).toBe(false);
    call.mockRestore();
    socket.receive({ method: "event", params: { type: "message.start", session_id: "runtime-one", seq: 100 } });
    await pending;
  });
  it("replays deltas arriving while subagent.list awaits after activation", async () => {
    socket.activeRows = [{ id: "runtime-one", session_key: "one", status: "working" }];
    socket.snapshot = { running: true, inflight: { user: "hello", assistant: "before" } };
    socket.onChildren = () => socket.receive({ method: "event", params: { type: "message.delta", session_id: "runtime-one", seq: 42, payload: { text: " after" } } });
    const snapshot = await service.openForView("ari", "one");
    expect(snapshot.seq).toBe(0);
    expect(snapshot.inflight?.assistant).toBe("before");
    expect(manager.eventsSince(service.retainedKey(key), snapshot.generation, snapshot.seq).events).toMatchObject([{ type: "message.delta", seq: 42 }]);
  });
  it.each(["send", "command"])("reports gateway_unavailable as 503 for %s", async action => {
    vi.spyOn(manager, "connect").mockRejectedValue(new Error("offline"));
    await expect(action === "send" ? service.sendPrompt(key, { text: "hello" }) : service.command(key, "interrupt", {})).rejects.toMatchObject({ status: 503, message: "gateway_unavailable" });
  });
});
