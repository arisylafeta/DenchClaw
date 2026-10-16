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
