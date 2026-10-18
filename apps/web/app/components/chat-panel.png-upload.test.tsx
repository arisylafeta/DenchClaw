// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel, type ChatPanelHandle } from "./chat-panel";
import { conversationKey } from "@/lib/hermes-conversations";
import { getHermesEventsClient } from "@/lib/hermes-chat/events-client";
vi.mock("./tiptap/chat-editor", () => ({ ChatEditor: () => null }));
vi.mock("./hero-suggestions", () => ({ HeroSuggestions: () => null }));
vi.mock("./chat-voice-input-button", () => ({ ChatVoiceInputButton: () => null }));
const key = conversationKey("solo", "png-fixture", "alpha");
class FakeEventSource {
  static instance: FakeEventSource;
  listeners: Record<string, Array<(event: MessageEvent) => void>> = {};
  readyState = 1;
  constructor() { FakeEventSource.instance = this; }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener); }
  close() { this.readyState = 2; }
  emit(type: string, data: unknown) { act(() => { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) } as MessageEvent); }); }
}
beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  URL.createObjectURL = vi.fn(() => "blob:synthetic-png");
  URL.revokeObjectURL = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); getHermesEventsClient().close(); vi.unstubAllGlobals(); });
describe("PNG file-picker ingestion", () => {
  it("preserves valid PNG bytes and the exact profile in the send payload", async () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const png = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "/api/workspace/upload") return Response.json({ ok: true, path: "assets/synthetic.png" });
      if (url.startsWith("/api/workspace/raw-file")) return { ok: true, blob: async () => new Blob([png], { type: "image/png" }) };
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const ref = React.createRef<ChatPanelHandle>();
    const { container } = render(<ChatPanel ref={ref} nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    FakeEventSource.instance.emit("connection", { connectionId: "fixture" });
    FakeEventSource.instance.emit("snapshot", { key, conversation: { id: "png-fixture", profile: "alpha", working: false, source: "crm" }, messages: [], pendingRequests: [], running: false, generation: 1, seq: 0 });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File([png], "synthetic.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByAltText("synthetic.png")).toHaveStyle({ opacity: "1" }));
    await act(() => ref.current!.sendNewMessage("Inspect this"));
    const post = fetchMock.mock.calls.find(([url]) => url === `/api/hermes/conversations/${encodeURIComponent(key)}/prompt`);
    expect(post).toBeDefined();
    expect(JSON.parse(String(post![1]!.body))).toMatchObject({ text: "[Attached files: assets/synthetic.png]\n\nInspect this", images: [{ content: base64, mimeType: "image/png", fileName: "synthetic.png" }] });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    [401, { error: "Unauthorized" }, "Unauthorized"],
    [400, { error: "File is too large (max 25 MB)" }, "File is too large (max 25 MB)"],
    [500, null, "Upload failed (HTTP 500)"],
    [200, { ok: true }, "Upload response did not include a file path"],
  ])("shows the upload error instead of silently dropping the PNG (%s)", async (status, body, detail) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/workspace/upload") return body === null
        ? new Response("upstream failed", { status: Number(status) })
        : Response.json(body, { status: Number(status) });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    FakeEventSource.instance.emit("connection", { connectionId: "fixture" });
    FakeEventSource.instance.emit("snapshot", { key, conversation: { id: "png-fixture", profile: "alpha", working: false, source: "crm" }, messages: [], pendingRequests: [], running: false, generation: 1, seq: 0 });
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File([png], "synthetic.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(`synthetic.png: ${detail}`));
    expect(screen.queryByAltText("synthetic.png")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/prompt"))).toBe(false);
  });
});
