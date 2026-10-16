// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel } from "./chat-panel";
import { conversationKey } from "@/lib/hermes-conversations";
vi.mock("./tiptap/chat-editor", () => ({ ChatEditor: ({ onSubmit }: { onSubmit: (text: string, files: unknown[], html: string) => void }) => <button onClick={() => onSubmit("Continue native", [], "<p>Continue native</p>")}>Submit fixture</button> }));
vi.mock("./chat-message", () => ({ ChatMessage: ({ message }: { message: unknown }) => <pre data-testid="rich-message">{JSON.stringify(message)}</pre> }));
vi.mock("./hero-suggestions", () => ({ HeroSuggestions: () => null }));
vi.mock("./chat-voice-input-button", () => ({ ChatVoiceInputButton: () => null }));
const key = conversationKey("solo", "native-existing", "alpha");
const endpoint = `/api/hermes/conversations/${encodeURIComponent(key)}`;
let fetchMock: ReturnType<typeof vi.fn>;
let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
let hold = false;
const emit = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
beforeEach(() => {
  hold = false; upstream = undefined;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollTo = vi.fn();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings/cloud") return Response.json({ status: "no_key" });
    if (url === endpoint && init?.method === "POST") return Response.json({ aborted: true });
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
afterEach(() => { try { upstream?.close(); } catch { /* Already finished. */ } vi.unstubAllGlobals(); });
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
