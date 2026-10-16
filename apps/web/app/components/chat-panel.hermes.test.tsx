// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel, type ChatPanelHandle } from "./chat-panel";
import { conversationKey } from "@/lib/hermes-conversations";
import { getHermesEventsClient } from "@/lib/hermes-chat/events-client";
vi.mock("./tiptap/chat-editor", () => ({ ChatEditor: ({ onSubmit, onNativeFileDrop }: { onSubmit: (text: string, files: unknown[], html: string) => void; onNativeFileDrop?: (files: FileList) => void }) => <><button onClick={() => onSubmit("Continue native", [], "<p>Continue native</p>")}>Submit fixture</button><button onClick={() => onNativeFileDrop?.([new File(["picture"], "pic.png", { type: "image/png" })] as unknown as FileList)}>Attach image fixture</button></> }));
vi.mock("./chat-message", () => ({ ChatMessage: ({ message }: { message: unknown }) => <pre data-testid="rich-message">{JSON.stringify(message)}</pre> }));
vi.mock("./hero-suggestions", () => ({ HeroSuggestions: () => null }));
vi.mock("./chat-voice-input-button", () => ({ ChatVoiceInputButton: () => null }));
vi.mock("@/lib/chat-image-preparation", () => ({ prepareFilesForChatUpload: async (files: FileList) => ({ files: Array.from(files), errors: [] }) }));
const key = conversationKey("solo", "native-existing", "alpha");
const endpoint = `/api/hermes/conversations/${encodeURIComponent(key)}`;
let fetchMock: ReturnType<typeof vi.fn>;
let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
let hold = false;
const emit = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
class FakeEventSource {
  static instance: FakeEventSource;
  listeners: Record<string, Array<(event: MessageEvent) => void>> = {};
  readyState = 1;
  constructor(readonly url: string) { FakeEventSource.instance = this; }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener); }
  close() { this.readyState = 2; }
  emit(type: string, data: unknown) { act(() => { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) } as MessageEvent); }); }
}
const gatewaySnapshot = (overrides: Record<string, unknown> = {}) => ({ key, conversation: { id: "native-existing", profile: "alpha", title: "Native", working: false, source: "crm" }, messages: [{ id: "history", role: "assistant", parts: [{ type: "tool-invocation", toolCallId: "saved", toolName: "terminal", args: { command: "old command" }, result: "saved gateway result" }] }], running: false, generation: 1, seq: 0, pendingRequests: [], ...overrides });
function openGateway(overrides: Record<string, unknown> = {}) {
  FakeEventSource.instance.emit("connection", { connectionId: "tab-connection" });
  FakeEventSource.instance.emit("snapshot", gatewaySnapshot(overrides));
}
beforeEach(() => {
  hold = false; upstream = undefined;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  URL.createObjectURL = vi.fn(() => "blob:picture");
  URL.revokeObjectURL = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings/cloud") return Response.json({ status: "no_key" });
    if (url === endpoint && init?.method === "POST") return Response.json({ aborted: true });
    if (url === "/api/hermes/events/subscriptions" || url.startsWith(`${endpoint}/`)) return Response.json({});
    if (url === endpoint) return Response.json({ messages: [{ id: "native-history", role: "assistant", content: "Native history", parts: [{ type: "reasoning", text: "Saved reasoning" }, { type: "tool-invocation", toolCallId: "tool1", toolName: "terminal", args: { command: "fixture" }, result: "saved output" }, { type: "text", text: "Native history" }] }] });
    if (url === "/api/chat") {
      const bytes = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        upstream = controller;
        controller.enqueue(bytes.encode(emit({ type: "text-start", id: "answer" }) + emit({ type: "text-delta", id: "answer", delta: "Continued through existing transport" })));
        if (!hold) { controller.enqueue(bytes.encode(emit({ type: "text-end", id: "answer" }) + emit({ type: "finish" }))); controller.close(); }
        else init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* Already cancelled. */ } });
      } }), { headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); if (FakeEventSource.instance) getHermesEventsClient().close(); try { upstream?.close(); } catch { /* Already finished. */ } vi.unstubAllGlobals(); });
describe("existing ChatPanel with native Hermes identity", () => {
  it("loads native rich history and submits via the existing transport with immutable profile, HTML and file context", async () => {
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} fileContext={{ path: "fixture.md", filename: "fixture.md" }} />);
    await waitFor(() => expect(screen.getByTestId("rich-message").textContent).toContain("Saved reasoning"));
    expect(screen.getByTestId("rich-message").textContent).toContain("saved output");
    fireEvent.click(screen.getByRole("button", { name: "Submit fixture" }));
    await waitFor(() => expect(screen.getAllByTestId("rich-message").some((m) => m.textContent?.includes("Continued through existing transport"))).toBe(true));
    const request = fetchMock.mock.calls.find(([url]) => url === "/api/chat");
    expect(JSON.parse(request![1].body)).toMatchObject({ sessionId: "native-existing", hermesProfile: "alpha", userHtml: "<p>Continue native</p>", workspaceContext: expect.any(Object) });
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith("/api/web-sessions"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith("/api/chat/stream"))).toBe(false);
  });
  it("retains stop behavior and actual runtime callbacks for the pinned native solo", async () => {
    hold = true;
    const runtime = vi.fn();
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} onRuntimeStateChange={runtime} />);
    await screen.findByTestId("rich-message");
    fireEvent.click(screen.getByRole("button", { name: "Submit fixture" }));
    await waitFor(() => expect(runtime.mock.calls.some(([state]) => state.sessionId === key && state.isStreaming)).toBe(true));
    fireEvent.click(await screen.findByTitle("Stop generating"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "stop" }) })));
    await waitFor(() => expect(runtime.mock.calls.at(-1)![0].isStreaming).toBe(false));
  });
});
describe("existing ChatPanel with a native Hermes group", () => {
  const groupKey = conversationKey("group", "room-1");
  const groupEndpoint = `/api/hermes/conversations/${encodeURIComponent(groupKey)}`;
  it("renders room history with who said it, posts sends to the room log instead of /api/chat, and picks up new replies", async () => {
    let replied = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings/cloud") return Response.json({ status: "no_key" });
      if (url.startsWith(groupEndpoint) && init?.method === "POST") { const { eventId, message } = JSON.parse(init.body as string); return Response.json({ conversation: { working: true }, cursor: 3, messages: [{ id: eventId, role: "user", text: message, content: message }] }); }
      if (url.startsWith(groupEndpoint)) {
        const messages = url.includes("since_seq=0") && !replied ? [] : replied ? [{ id: "e3", role: "assistant", text: "Mailvin reply", content: "Mailvin reply", profile: "mailvin", name: "Mailvin" }] : [];
        return Response.json(url.includes("since_seq") ? { conversation: { working: false }, cursor: 3, messages } : { conversation: { working: false }, cursor: 2, messages: [{ id: "e1", role: "user", text: "hello", content: "hello" }, { id: "e2", role: "assistant", text: "Hi from the group", content: "Hi from the group", profile: "investigator", name: "InvestiGator" }] });
      }
      return new Response(null, { status: 404 });
    });
    render(<ChatPanel nativeConversationKey={groupKey} initialSessionId={groupKey} headerBadge={<span>Group badge</span>} />);
    await waitFor(() => expect(screen.getAllByTestId("rich-message").some((m) => m.textContent?.includes("Hi from the group"))).toBe(true));
    expect(screen.getByText("InvestiGator")).toBeInTheDocument();
    expect(screen.getByText("Group badge")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit fixture" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === groupEndpoint && init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([url, init]) => url === groupEndpoint && init?.method === "POST")!;
    expect(JSON.parse(post[1].body)).toMatchObject({ message: "Continue native", eventId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/chat")).toBe(false);
    replied = true;
    await waitFor(() => expect(screen.getByText("Mailvin")).toBeInTheDocument(), { timeout: 5000 });
  }, 10000);
});

describe("gateway ChatPanel solo transport", () => {
  it("sends uploaded image bytes, attachment prefixes and context through imperative sends", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/workspace/upload") return Response.json({ ok: true, path: "uploads/pic.png" });
      if (url.startsWith("/api/workspace/raw-file")) return { ok: true, blob: async () => new Blob(["picture"], { type: "image/png" }) };
      return Response.json({});
    });
    const ref = React.createRef<ChatPanelHandle>();
    render(<ChatPanel ref={ref} nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" fileContext={{ path: "notes.md", filename: "notes.md" }} />);
    openGateway();
    fireEvent.click(screen.getByRole("button", { name: "Attach image fixture" }));
    await waitFor(() => expect(screen.getByAltText("pic.png")).toHaveAttribute("src", "blob:picture"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/workspace/upload")).toBe(true));
    // Wait for the upload result to replace its pending placeholder before submitting.
    await waitFor(() => expect(screen.getByAltText("pic.png")).toHaveStyle({ opacity: "1" }));
    await act(() => ref.current!.sendNewMessage("Inspect image"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === `${endpoint}/prompt`)).toBe(true));
    const post = fetchMock.mock.calls.find(([url]) => url === `${endpoint}/prompt`)!;
    expect(JSON.parse(post[1].body)).toMatchObject({ text: "[Attached files: uploads/pic.png]\n\nInspect image", context: { filePath: "notes.md" }, html: "<p>Inspect image</p>", images: [{ content: "cGljdHVyZQ==", mimeType: "image/png", fileName: "pic.png" }] });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/chat")).toBe(false);
  });
  it("renders snapshot tools and updates a live tool in place without the SDK transport", async () => {
    const { container } = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    openGateway();
    expect(screen.getByText("saved gateway result")).toBeInTheDocument();
    FakeEventSource.instance.emit("gw", { key, generation: 1, seq: 1, type: "tool.start", payload: { tool_id: "live", name: "terminal", args: { command: "pwd" } } });
    const row = container.querySelectorAll("[data-tool-id]")[1];
    expect(container.querySelectorAll("[data-tool-id]")).toHaveLength(2);
    FakeEventSource.instance.emit("gw", { key, generation: 1, seq: 2, type: "tool.complete", payload: { tool_id: "live", name: "terminal", result: "live result", duration_s: 2 } });
    expect(container.querySelectorAll("[data-tool-id]")[1]).toBe(row);
    expect(screen.getByText("live result")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/chat" || url === endpoint)).toBe(false);
  });
  it("answers approvals and four-option clarify questions using request identities", async () => {
    const runtime = vi.fn();
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" onRuntimeStateChange={runtime} />);
    openGateway({ running: true, messages: [] });
    FakeEventSource.instance.emit("request", { key, id: "srq-approval", method: "approval", params: { request_id: "approval-payload", command: "pwd", choices: ["once", "deny"] } });
    expect(runtime.mock.calls.at(-1)![0]).toMatchObject({ awaiting: true, isStreaming: true, sessionId: key });
    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${endpoint}/approval`, expect.objectContaining({ body: JSON.stringify({ request_id: "approval-payload", choice: "once" }) })));
    FakeEventSource.instance.emit("request", { key, id: "srq-clarify", method: "clarify", params: { questions: [{ qid: "direction", question: "Which route?", choices: ["North", "East", "South", "West"] }] } });
    fireEvent.click(screen.getByRole("button", { name: "West" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${endpoint}/clarify`, expect.objectContaining({ body: JSON.stringify({ request_id: "srq-clarify", answers: { direction: "West" } }) })));
  });
  it("renders subagent progress and sends queued prompts directly; Stop interrupts", async () => {
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    openGateway({ running: true });
    FakeEventSource.instance.emit("gw", { key, generation: 1, seq: 1, type: "subagent.start", payload: { subagent_id: "researcher", goal: "Research sources", model: "model-a" } });
    expect(screen.getByRole("region", { name: "Subagent: Research sources" })).toBeInTheDocument();
    FakeEventSource.instance.emit("gw", { key, generation: 1, seq: 2, type: "subagent.complete", payload: { subagent_id: "researcher", status: "completed", summary: "Sources checked" } });
    expect(screen.getByText("Sources checked")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit fixture" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === `${endpoint}/prompt`)).toBe(true));
    expect(screen.getByText("1 queued")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Stop generating"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${endpoint}/interrupt`, expect.objectContaining({ method: "POST", body: "{}" })));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/chat")).toBe(false);
  });
  it("unsubscribes hidden panels and switches sessions without interrupting", async () => {
    const { rerender } = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" visible />);
    openGateway({ running: true });
    rerender(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" visible={false} />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith("/subscriptions") && JSON.parse(init.body).remove.includes(key))).toBe(true));
    const other = conversationKey("solo", "other", "alpha");
    rerender(<ChatPanel nativeConversationKey={other} initialSessionId={other} nativeTransport="gateway" visible />);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/interrupt"))).toBe(false);
  });
  it("blocks automation sends and branches to a new selected conversation", async () => {
    const branched = vi.fn();
    const branch = { key: "branch", kind: "solo", title: "Branch" };
    fetchMock.mockImplementation(async (url: string) => Response.json(url.endsWith("/branch") ? { conversation: branch } : {}));
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" onBranched={branched} />);
    openGateway({ conversation: { id: "native-existing", profile: "alpha", title: "Cron", working: false, source: "cron" } });
    expect(screen.getByLabelText("Read-only conversation")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit fixture" }));
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/prompt"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Continue as new chat" }));
    await waitFor(() => expect(branched).toHaveBeenCalledWith(branch));
  });
  it.each(["gateway_transport", "automation_read_only"])("surfaces %s without falling back to SSE", async error => {
    fetchMock.mockImplementation(async (url: string) => Response.json(url.endsWith("/prompt") ? { error } : {}, { status: url.endsWith("/prompt") ? 409 : 200 }));
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    openGateway();
    fireEvent.click(screen.getByRole("button", { name: "Submit fixture" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(error));
    if (error === "automation_read_only") expect(screen.getByLabelText("Read-only conversation")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/prompt"))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/chat")).toBe(false);
  });
});
