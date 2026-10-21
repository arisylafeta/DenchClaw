import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../hermes-native", () => ({
  dashboardToken: vi.fn(), invalidateDashboardToken: vi.fn(),
  assertProfile: vi.fn((profile: string) => { if (profile !== "ari") throw new Error("unknown"); return { workspaceDir: "/workspace" }; }),
  nativeFetch: vi.fn(async () => Response.json({ source: "crm" })),
  hermesProfiles: vi.fn(() => ["ari", "matcha"]),
  inviteToConversation: vi.fn(async () => ({ key: "group-key", kind: "group" })),
  readConversation: vi.fn(async () => ({ conversation: { key: "one", source: "crm" }, messages: [] })),
  soloConversation: vi.fn((profile: string, row: { id: string }) => ({ key: encodeURIComponent(JSON.stringify(["solo", profile, row.id])), profile, ...row })),
}));
vi.mock("./message-html-store", () => ({ lookupMessageHtml: vi.fn(async () => []), saveMessageHtml: vi.fn() }));
vi.mock("../chat-image-attachments", () => ({ hydrateMessageImageAttachments: vi.fn(() => ({ attachments: [], skipped: [] })), buildChatImageHydrationErrorMessage: vi.fn(() => null) }));
vi.mock("../workspace", () => ({ resolveAgentWorkspacePrefix: () => "/source-workspace" }));
vi.mock("../hermes-session-goal", () => ({ persistedSessionGoal: vi.fn(async () => null) }));
import { inviteToConversation, nativeFetch, readConversation } from "../hermes-native";
import { hydrateMessageImageAttachments } from "../chat-image-attachments";
import { HermesGatewayManager, type GatewaySocket } from "./manager";
import { skillCollisionDirective, HermesChatService } from "./chat-service";
import { conversationKey } from "../hermes-conversations";
import { buildAgentMessage } from "../agent-message";
import { EventConnection } from "../../app/api/hermes/events/registry";
import { applyLive, applySnapshot, initialReconcileState } from "../hermes-chat/reconcile";
import type { GatewayChatSnapshot as ClientSnapshot } from "../hermes-chat/snapshot";

type Frame = { id?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
class FakeSocket implements GatewaySocket {
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  frames: Frame[] = [];
  failPrompt = false;
  busy = false;
  autoContinue = false;
  steerUnsupported = false;
  configResults: Record<string, unknown>[] = [];
  failConfig = false;
  slashErrorCode?: number;
  addEventListener(type: string, handler: (event: unknown) => void) { (this.listeners[type] ??= []).push(handler); }
  deferConsumption = false;
  activeRows: { id: string; session_key: string; status: string }[] = [];
  snapshot: Record<string, unknown> = {};
  children: Record<string, unknown>[] = [];
  replayEvents: unknown[] = [];
  onChildren?: () => void;
  emit(type: string, event: unknown = {}) { for (const handler of this.listeners[type] ?? []) handler(event); }
  receive(frame: Frame) { this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", ...frame }) }); }
  send(text: string) {
    const frame = JSON.parse(text) as Frame; this.frames.push(frame);
    if (!frame.method || frame.method === "event") return;
    if (frame.method === "subagent.list") this.onChildren?.();
    if (frame.method === "prompt.submit" && this.failPrompt) { this.receive({ id: frame.id, error: { code: 4001, message: "stale" } }); return; }
    if (frame.method === "session.steer" && this.steerUnsupported) { this.receive({ id: frame.id, error: { code: 4010, message: "agent does not support steer" } }); return; }
    if (frame.method === "config.set" && this.failConfig) { this.receive({ id: frame.id, error: { code: 4001, message: "stale" } }); return; }
    if (frame.method === "slash.exec" && this.slashErrorCode) { this.receive({ id: frame.id, error: { code: this.slashErrorCode, message: "slash refused" } }); return; }
    const result = frame.method === "session.resume" ? { session_id: `runtime-${frame.params?.session_id}`, running: this.busy, auto_continue: this.autoContinue ? { attempt: 1 } : undefined }
      : frame.method === "session.usage" ? { context_used: 42100, context_max: 200000 }
      : frame.method === "subagent.list" ? { subagents: this.children }
      : frame.method === "session.active_list" ? { sessions: this.activeRows }
      : frame.method === "session.activate" ? { session_id: frame.params?.session_id, session_key: "one", info: { profile_name: "ari", lazy: false, cwd: "/workspace", branch: "", project: {}, model: "test", skills: {}, tools: {} }, ...this.snapshot }
      : frame.method === "image.attach_bytes" ? { attached: true, path: "/image" }
      : frame.method === "session.create" ? { session_id: "runtime-one", stored_session_id: "one" }
      : frame.method === "session.interrupt" ? { status: "interrupted" }
      : frame.method === "session.steer" ? { status: this.busy ? "queued" : "rejected" }
      : frame.method === "prompt.submit" ? { status: this.busy ? "queued" : "streaming" }
      : frame.method === "model.options" ? { model: "test", provider: "openai", providers: [{ slug: "openai", name: "OpenAI", models: ["test", "expensive"], capabilities: { test: { fast: false, reasoning: true } } }] }
      : frame.method === "config.get" ? { value: "high", display: "hide" }
      : frame.method === "config.set" ? this.configResults.shift() ?? { key: frame.params?.key, value: frame.params?.value }
      : frame.method === "command.dispatch" ? { type: "skill", message: frame.params?.arg, display: "Skill loaded" }
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
const image = { content: "aGVsbG8=", mimeType: "image/png", fileName: "a.png" };
/** The next send's `[Attached files: …]` prefix resolves to these images on disk. */
function attachOnNextSend(...images: typeof image[]) {
  vi.mocked(hydrateMessageImageAttachments).mockReturnValueOnce({ attachmentPaths: images.map(i => i.fileName), imagePaths: images.map(i => i.fileName), attachments: images, skipped: [] });
}
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
  it("reads context occupancy from the attached runtime without resuming idle history", async () => {
    const idle = await service.openForView("ari", "one");
    expect(idle.usage).toBeNull();
    expect(socket.frames.some(frame => frame.method === "session.resume" || frame.method === "session.usage")).toBe(false);
    socket.activeRows = [{ id: "runtime-one", session_key: "one", status: "working" }];
    const live = await service.openForView("ari", "one");
    expect(live.usage).toEqual({ context_used: 42100, context_max: 200000 });
    expect(socket.frames.find(frame => frame.method === "session.usage")?.params).toEqual({ session_id: "runtime-one", profile: "ari" });
    vi.spyOn(manager, "callSession").mockRejectedValueOnce(new Error("usage unsupported"));
    expect((await service.openForView("ari", "one")).usage).toBeNull();
  });
  it("includes already-running children from the verified runtime in the view snapshot", async () => {
    socket.activeRows = [{ id: "runtime-one", session_key: "one", status: "working" }];
    socket.snapshot = { running: true };
    socket.children = [{ subagent_id: "child", goal: "Research", status: "running", model: "test" }];
    const view = await service.openForView("ari", "one");
    expect(view).toMatchObject({ subagents: socket.children });
    expect(socket.frames.filter(frame => frame.method === "subagent.list").map(frame => frame.params)).toEqual([{ session_id: "runtime-one", profile: "ari" }]);
  });
  it("admits workers arriving during the history read and applies list-racing completion after the snapshot", async () => {
    socket.activeRows = [{ id: "runtime-one", session_key: "one", status: "working" }];
    socket.snapshot = { running: true };
    socket.children = [{ subagent_id: "listed", goal: "Already running", status: "running" }];
    socket.onChildren = () => socket.receive({ method: "event", params: { type: "subagent.complete", session_id: "runtime-one", seq: 41, payload: { subagent_id: "listed", status: "completed", summary: "Finished during list" } } });
    let release!: () => void;
    let reading = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.mocked(readConversation).getMockImplementation()!;
    vi.mocked(readConversation).mockImplementationOnce(async (...args) => { reading = true; await gate; return read(...args); });
    const ctx = { now: () => 1000, id: () => "synthetic" };
    let state = initialReconcileState("one", key);
    const emitted: string[] = [];
    const connection = new EventConnection("synthetic-user", (type, payload) => {
      emitted.push(type);
      if (type === "snapshot") state = applySnapshot(state, payload as ClientSnapshot, state.loadToken, ctx);
      if (type === "gw") state = applyLive(state, [payload as Parameters<typeof applyLive>[1][number]], ctx);
    }, service);
    try {
      const pending = connection.update([key], []);
      await flush(); await flush();
      expect(reading).toBe(true);
      socket.receive({ method: "event", params: { type: "subagent.start", session_id: "runtime-one", seq: 42, payload: { subagent_id: "during-history", goal: "New work" } } });
      expect(emitted).toEqual([]); // Admission deliberately holds live frames until history establishes its boundary.
      release(); await pending;
      expect(emitted).toEqual(["snapshot", "gw", "gw"]);
      expect(state.subagents.items.map(child => [child.id, child.status])).toEqual([["listed", "completed"], ["during-history", "running"]]);
    } finally { release(); connection.close(); }
  });
  it("offers /invite and turns it into a group conversation without touching the Hermes slash worker", async () => {
    const commands = await service.slashComplete(key, { text: "/inv" });
    expect(commands.items[0]).toMatchObject({ text: "/invite" });
    const agents = await service.slashComplete(key, { text: "/invite " });
    expect(agents.items.map(item => item.text)).toEqual(["matcha"]);
    expect(agents.replace_from).toBe("/invite ".length);
    expect((await service.slashComplete(key, { text: "/invite ma" })).items.map(item => item.text)).toEqual(["matcha"]);
    socket.frames.length = 0;
    expect(await service.slashExecute(key, { command: "/invite matcha look at pricing" })).toEqual({ conversation: { key: "group-key", kind: "group" } });
    expect(inviteToConversation).toHaveBeenCalledWith(key, "matcha", "look at pricing");
    expect(socket.frames.some(frame => ["slash.exec", "session.resume"].includes(frame.method ?? ""))).toBe(false);
    await expect(service.slashExecute(key, { command: "/invite" })).rejects.toThrow("invite_needs_agent");
    await expect(service.slashExecute(key, { command: "/invite nobody" })).rejects.toThrow("unknown_profile");
    await expect(service.slashExecute(key, { command: "/invite ari" })).rejects.toThrow("invite_same_agent");
  });
  it("runs a skill whose name collides with a built-in as a prompt instead of showing Hermes' refusal", async () => {
    const note = "slash command /handoff unavailable — name taken by built-in; use /skill handoff";
    expect(skillCollisionDirective({ output: note }, "to matcha")).toEqual({ type: "send", message: 'Use the "handoff" skill: to matcha', notice: expect.stringContaining("ran the handoff skill") });
    expect(skillCollisionDirective({ output: note }, "")).toMatchObject({ message: 'Use the "handoff" skill.' });
    const ordinary = { output: "Compressed 12 messages" };
    expect(skillCollisionDirective(ordinary, "")).toBe(ordinary);
  });
  it("keeps slash completion read-only and session-scoped, then resumes execution with only the 4018 dispatch fallback", async () => {
    expect(await service.slashComplete(key, { text: "/exa" })).toEqual({ items: [], replace_from: 1, catalog: {} });
    expect(socket.frames.filter(frame => ["complete.slash", "commands.catalog"].includes(frame.method ?? "")).map(frame => frame.params)).toEqual([
      { text: "/exa", profile: "ari" }, { profile: "ari" },
    ]);
    expect(socket.frames.some(frame => frame.method === "session.resume")).toBe(false);
    await expect(service.slashExecute(key, { command: "/usr/local" })).rejects.toThrow("invalid_slash_command");
    await expect(service.slashComplete(key, { text: `/${"x".repeat(65_536)}` })).rejects.toThrow("invalid_slash_text");
    socket.slashErrorCode = 4018;
    const arg = "first line\n  indented second line";
    expect(await service.slashExecute(key, { command: `/Exa ${arg}` })).toEqual({ type: "skill", message: arg, display: "Skill loaded" });
    expect(socket.frames.find(frame => frame.method === "slash.exec")?.params).toEqual({ session_id: "runtime-one", profile: "ari", command: `/Exa ${arg}` });
    expect(socket.frames.find(frame => frame.method === "command.dispatch")?.params).toEqual({ session_id: "runtime-one", profile: "ari", name: "exa", arg });
    expect(socket.frames.filter(frame => frame.method === "session.resume")).toHaveLength(1);
    await service.slashComplete(key, { text: "/exa" });
    expect(socket.frames.filter(frame => frame.method === "complete.slash").at(-1)?.params).toEqual({ text: "/exa", profile: "ari", session_id: "runtime-one" });
    socket.slashErrorCode = 4010;
    await expect(service.slashExecute(key, { command: "/exa" })).rejects.toThrow("slash refused");
    expect(socket.frames.filter(frame => frame.method === "command.dispatch")).toHaveLength(1);
  });
  it("returns native model inventory and live reasoning from only the conversation runtime", async () => {
    manager.retainSession("ari", "one", "runtime-one");
    manager.retainSession("ari", "two", "runtime-two");
    const result = await service.modelOptions(key);
    expect(result).toMatchObject({ model: "test", provider: "openai", reasoning: { value: "high", display: "hide" }, providers: [{ capabilities: { test: { reasoning: true } } }] });
    expect(socket.frames.filter(frame => ["model.options", "config.get"].includes(frame.method ?? "")).map(frame => frame.params)).toEqual([
      { session_id: "runtime-one", profile: "ari" },
      { session_id: "runtime-one", profile: "ari", key: "reasoning" },
      { session_id: "runtime-one", profile: "ari", key: "fast" },
    ]);
    expect(socket.frames.some(frame => frame.method === "session.resume")).toBe(false);
  });
  it("forwards session flags, provider and explicit expensive-model confirmation without changing native results", async () => {
    manager.retainSession("ari", "one", "runtime-one");
    const warning = { key: "model", value: "expensive", warning: "Costs more", confirm_required: true, confirm_message: "Costs more", scope: "session", deferred: false };
    const accepted = { key: "model", value: "expensive", warning: "", confirm_required: false, confirm_message: "", scope: "session", deferred: true };
    socket.configResults.push(warning, accepted);
    expect(await service.command(key, "model", { model: "expensive", provider: "custom:team" })).toEqual(warning);
    expect(await service.command(key, "model", { model: "expensive", provider: "custom:team", confirm: true })).toEqual(accepted);
    expect(socket.frames.filter(frame => frame.method === "config.set").map(frame => frame.params)).toEqual([
      { session_id: "runtime-one", profile: "ari", key: "model", value: "expensive --provider custom:team --session", scope: "session", confirm_expensive_model: false },
      { session_id: "runtime-one", profile: "ari", key: "model", value: "expensive --provider custom:team --session", scope: "session", confirm_expensive_model: true },
    ]);
  });
  it("forwards reasoning effort with explicit session scope and preserves the native result", async () => {
    manager.retainSession("ari", "one", "runtime-one");
    expect(await service.command(key, "reasoning", { effort: "none" })).toEqual({ key: "reasoning", value: "none" });
    expect(socket.frames.find(frame => frame.method === "config.set")?.params).toEqual({ session_id: "runtime-one", profile: "ari", key: "reasoning", value: "none", scope: "session" });
  });
  it("reads an idle chat's models without resuming it, and resumes only to apply a session-scoped pick", async () => {
    vi.mocked(nativeFetch).mockImplementation(async () => Response.json({ session: { source: "crm", model: "stored-model" } }));
    expect(await service.modelOptions(key)).toMatchObject({ model: "stored-model" });
    expect(socket.frames.some(frame => frame.method === "session.resume")).toBe(false);
    expect(socket.frames.find(frame => frame.method === "model.options")?.params).toMatchObject({ profile: "ari" });
    await service.command(key, "reasoning", { effort: "high" });
    expect(socket.frames.map(frame => frame.method).filter(method => ["session.resume", "config.set"].includes(method ?? ""))).toEqual(["session.resume", "config.set"]);
    expect(socket.frames.find(frame => frame.method === "config.set")?.params).toMatchObject({ key: "reasoning", value: "high", scope: "session" });
  });
  it.each(["cron", "webhook"])("blocks model and reasoning controls for read-only %s conversations", async source => {
    manager.retainSession("ari", "one", "runtime-one");
    vi.mocked(nativeFetch).mockImplementation(async () => Response.json({ session: { source } }));
    await expect(service.modelOptions(key)).rejects.toMatchObject({ status: 409, message: "automation_read_only" });
    await expect(service.command(key, "model", { model: "test" })).rejects.toMatchObject({ status: 409, message: "automation_read_only" });
    await expect(service.command(key, "reasoning", { effort: "high" })).rejects.toMatchObject({ status: 409, message: "automation_read_only" });
    expect(socket.frames.some(frame => ["model.options", "config.get", "config.set"].includes(frame.method ?? ""))).toBe(false);
  });
  it("rejects profile access before touching Hermes", async () => {
    const foreign = conversationKey("solo", "one", "foreign");
    await expect(service.modelOptions(foreign)).rejects.toMatchObject({ status: 404 });
    await expect(service.command(foreign, "model", { model: "test" })).rejects.toMatchObject({ status: 404 });
    await expect(service.command(foreign, "reasoning", { effort: "high" })).rejects.toMatchObject({ status: 404 });
    expect(nativeFetch).not.toHaveBeenCalled();
  });
  it.each([
    ["model", { model: "test --global" }],
    ["model", { model: "--once" }],
    ["model", { model: "—global" }],
    ["model", { model: "test", provider: "openai --global" }],
    ["model", { model: "test", confirm: "true" }],
    ["model", { model: "test", scope: "global" }],
    ["reasoning", { effort: "show" }],
    ["reasoning", { effort: "high", scope: "global" }],
  ] as [string, Record<string, unknown>][])("rejects unsafe %s input %j before config.set", async (action, body) => {
    manager.retainSession("ari", "one", "runtime-one");
    await expect(service.command(key, action, body)).rejects.toMatchObject({ status: 400 });
    expect(socket.frames.some(frame => frame.method === "config.set")).toBe(false);
  });
  it("forwards allowlisted goal controls to session.control and refuses anything else", async () => {
    manager.retainSession("ari", "one", "runtime-one");
    await service.command(key, "control", { action: "goal.pause" });
    await service.command(key, "control", { action: "subgoal.add", args: { text: "Tests pass" } });
    await service.command(key, "control", { action: "subgoal.remove", args: { index: 2 } });
    expect(socket.frames.filter(frame => frame.method === "session.control").map(frame => frame.params)).toEqual([
      { session_id: "runtime-one", profile: "ari", action: "goal.pause" },
      { session_id: "runtime-one", profile: "ari", action: "subgoal.add", args: { text: "Tests pass" } },
      { session_id: "runtime-one", profile: "ari", action: "subgoal.remove", args: { index: 2 } },
    ]);
    for (const body of [{ action: "goal.gate.add", args: { text: "rm -rf /" } }, { action: "subgoal.add" }, { action: "subgoal.remove", args: { index: 0 } }, { action: "loop.stop" }, { action: "goal.pause", extra: true }]) {
      await expect(service.command(key, "control", body)).rejects.toMatchObject({ status: 400 });
    }
    expect(socket.frames.filter(frame => frame.method === "session.control")).toHaveLength(3);
  });
  it("does not replay a stale config mutation into another runtime", async () => {
    manager.retainSession("ari", "one", "runtime-one");
    socket.failConfig = true;
    await expect(service.command(key, "model", { model: "test" })).rejects.toThrow("session_not_live");
    expect(socket.frames.filter(frame => frame.method === "config.set")).toHaveLength(1);
    expect(manager.session(JSON.stringify(["ari", "one"]))?.runtimeId).toBeUndefined();
  });
  it("does not resume an idle history view", async () => {
    await service.openForView("ari", "one");
    expect(socket.frames.some(frame => frame.method === "session.resume")).toBe(false);
  });
  it("rejects REST automation sources before mutation", async () => {
    vi.mocked(nativeFetch).mockResolvedValue(Response.json({ session: { source: "cron" } }));
    await expect(service.sendPrompt(key, { text: "hello" })).rejects.toMatchObject({ status: 409, message: "automation_read_only" });
    expect(socket.frames.some(frame => frame.method === "prompt.submit")).toBe(false);
  });
  it("serializes attachment staging; images cannot ride a steer so they submit plainly, never queued", async () => {
    socket.busy = true;
    attachOnNextSend(image); attachOnNextSend(image);
    await Promise.all([service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" }), service.sendPrompt(key, { text: "[Attached files: a.png]\n\nsecond" })]);
    expect(socket.frames.filter(frame => ["image.attach_bytes", "prompt.submit"].includes(frame.method ?? "")).map(frame => frame.method)).toEqual(["image.attach_bytes", "prompt.submit", "image.attach_bytes", "prompt.submit"]);
    expect(socket.frames.filter(frame => frame.method === "prompt.submit").every(frame => frame.params?.queued === undefined)).toBe(true);
  });
  it("stages a file attached twice only once, retaining distinct images", async () => {
    attachOnNextSend(image, { ...image, fileName: "renamed.png" }, { ...image, content: "ZGlmZmVyZW50", fileName: "b.png" });
    await service.sendPrompt(key, { text: "[Attached files: a.png, renamed.png, b.png]\n\nInspect" });
    const staged = socket.frames.filter(frame => frame.method === "image.attach_bytes");
    expect(staged.map(frame => frame.params?.content_base64)).toEqual(["aGVsbG8=", "ZGlmZmVyZW50"]);
  });
  it("detaches staged images and never retries stale prompt mutations", async () => {
    socket.failPrompt = true;
    attachOnNextSend(image);
    await expect(service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" })).rejects.toThrow("session_not_live");
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
  it("surfaces auto-continue when the send starts a turn", async () => {
    socket.autoContinue = true;
    const result = await service.sendPrompt(key, { text: "continue" });
    expect(result.autoContinue).toBe(true);
    expect(socket.frames.find(frame => frame.method === "prompt.submit")?.params?.queued).toBeUndefined();
  });
  it("steers a busy turn instead of queueing, and starts a turn when idle", async () => {
    socket.busy = true;
    const steered = await service.sendPrompt(key, { text: "use the other API" });
    expect(steered.status).toBe("steered");
    expect(socket.frames.find(frame => frame.method === "session.steer")?.params).toMatchObject({ text: "use the other API" });
    expect(socket.frames.some(frame => frame.method === "prompt.submit")).toBe(false);
    socket.busy = false; socket.frames.length = 0;
    const started = await service.sendPrompt(key, { text: "new turn" });
    expect(started.status).toBe("streaming");
    expect(socket.frames.map(frame => frame.method).filter(method => ["session.steer", "prompt.submit"].includes(method ?? ""))).toEqual(["session.steer", "prompt.submit"]);
    expect(socket.frames.find(frame => frame.method === "prompt.submit")?.params?.queued).toBeUndefined();
  });
  it("submits the text when a resumed session has no agent to steer yet", async () => {
    socket.steerUnsupported = true;
    const started = await service.sendPrompt(key, { text: "let's continue" });
    expect(started.status).toBe("streaming");
    expect(socket.frames.find(frame => frame.method === "prompt.submit")?.params).toMatchObject({ text: "let's continue" });
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
    attachOnNextSend(image); attachOnNextSend(image);
    const first = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" });
    await flush(); await flush();
    const second = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nsecond" });
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
    expect(socket.frames.find(frame => frame.method === "prompt.submit")?.params).toMatchObject({ text: "[Context: workspace file '/source-workspace/doc.md']\n\ninspect", });
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
    attachOnNextSend(image); attachOnNextSend(image);
    const first = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" });
    await flush(); await flush();
    const second = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nsecond" });
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
    attachOnNextSend(image); const pending = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" });
    const rejected = expect(pending).rejects.toThrow("prompt_cancelled");
    await flush(); await flush();
    await service.command(key, "interrupt", {});
    await rejected;
    expect(socket.frames.find(frame => frame.method === "image.detach")?.params).toMatchObject({ session_id: "runtime-one", path: "/image" });
  });
  it.each(["message.complete", "error"])("rejects initialization %s before media admission", async type => {
    socket.deferConsumption = true;
    attachOnNextSend(image); const pending = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" });
    const rejected = expect(pending).rejects.toMatchObject({ status: 502, message: "prompt_failed" });
    await flush(); await flush();
    socket.receive({ method: "event", params: { type, session_id: "runtime-one", seq: 100, payload: type === "error" ? { message: "Agent initialization failed" } : { text: "", status: "error", error: "Agent initialization failed", recoverable: true, error_surface: { layer: "runtime", code: "agent_init_failed", retryable: true } } } });
    await rejected;
    expect(socket.frames.filter(frame => frame.method === "image.detach")).toHaveLength(1);
  });
  it("keeps accepted media through disconnect and reconciles the claim via events.since", async () => {
    socket.deferConsumption = true;
    attachOnNextSend(image); const pending = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" });
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
    attachOnNextSend(image); const pending = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" });
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
    attachOnNextSend(image); const pending = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" });
    await flush(); await flush();
    const call = vi.spyOn(manager, "callSession").mockResolvedValueOnce({ status: "not_interrupted", interrupted: false } as never);
    await service.command(key, "interrupt", {}); await flush();
    expect(socket.frames.some(frame => frame.method === "image.detach")).toBe(false);
    call.mockRestore();
    socket.receive({ method: "event", params: { type: "message.start", session_id: "runtime-one", seq: 100 } });
    await pending;
  });
  it.each([
    ["reasoning.delta", { text: "thinking" }],
    ["tool.start", { tool_id: "call-1", name: "terminal", args: { command: "pwd" } }],
    ["tool.complete", { tool_id: "call-1", name: "terminal", result: "/workspace" }],
  ])("accepts a real %s event as media claim when start was missed", async (type, payload) => {
    socket.deferConsumption = true;
    attachOnNextSend(image); const pending = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" });
    await flush(); await flush();
    socket.receive({ method: "event", params: { type, session_id: "runtime-one", seq: 100, payload } });
    await pending;
    expect(socket.frames.some(frame => frame.method === "image.detach")).toBe(false);
  });
  it("detaches unclaimed images on an interrupted terminal event", async () => {
    socket.deferConsumption = true;
    attachOnNextSend(image); const pending = service.sendPrompt(key, { text: "[Attached files: a.png]\n\nfirst" });
    const rejected = expect(pending).rejects.toMatchObject({ status: 409, message: "prompt_cancelled" });
    await flush(); await flush();
    socket.receive({ method: "event", params: { type: "message.complete", session_id: "runtime-one", seq: 100, payload: { text: "", status: "interrupted" } } });
    await rejected;
    expect(socket.frames.filter(frame => frame.method === "image.detach")).toHaveLength(1);
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
