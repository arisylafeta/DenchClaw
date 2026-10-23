// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel, type ChatPanelHandle } from "./chat-panel";
import { conversationKey } from "@/lib/hermes-conversations";
import { getHermesEventsClient } from "@/lib/hermes-chat/events-client";
import { ownerAccess } from "@/lib/hermes-chat/access-fixture";
// Keep PNG tests scoped to attachment ingestion, not model-options network fixtures.
vi.mock("./chat-native/model-controls", () => ({ NativeModelControls: () => null }));
const transport = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("@ai-sdk/react", async importOriginal => {
  const actual = await importOriginal<typeof import("@ai-sdk/react")>();
  return { ...actual, useChat: (...args: Parameters<typeof actual.useChat>) => {
    const chat = actual.useChat(...args);
    return { ...chat, error: transport.error ?? chat.error };
  } };
});
vi.mock("./tiptap/chat-editor", () => ({ ChatEditor: () => null }));
vi.mock("./hero-suggestions", () => ({ HeroSuggestions: () => null }));
vi.mock("./chat-voice-input-button", () => ({ ChatVoiceInputButton: () => null }));
const key = conversationKey("solo", "png-fixture", "alpha");
const otherKey = conversationKey("solo", "png-fixture", "beta");
const fixturePng = () => new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0))], "synthetic.png", { type: "image/png" });
function pick(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [fixturePng()] } });
}
function snapshot(k = key) {
  FakeEventSource.instance.emit("connection", { connectionId: "fixture" });
  FakeEventSource.instance.emit("snapshot", { key: k, gateway: "connected", conversation: { id: "png-fixture", profile: k === key ? "alpha" : "beta", working: false, source: "crm", access: ownerAccess }, messages: [], pendingRequests: [], running: false, generation: 1, seq: 0 });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
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
  transport.error = null;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  URL.createObjectURL = vi.fn(() => "blob:synthetic-png");
  URL.revokeObjectURL = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); getHermesEventsClient().close(); vi.unstubAllGlobals(); });
describe("PNG file-picker ingestion", () => {
  it("dismisses attachment errors without clearing an unrelated transport error", async () => {
    transport.error = new Error("transport offline");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/workspace/upload" ? Response.json({ error: "upload refused" }, { status: 500 }) : Response.json({})));
    const { container } = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    pick(container);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("upload refused"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss attachment error" }));
    expect(screen.getByRole("alert")).toHaveTextContent("transport offline");
    expect(screen.getByRole("alert")).not.toHaveTextContent("upload refused");
    expect(screen.queryByRole("button", { name: "Dismiss attachment error" })).not.toBeInTheDocument();
  });

  it("does not resurrect a dismissed error when another file from the batch fails late", async () => {
    const late = deferred<Response>();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/workspace/upload"
      ? ++calls === 1 ? Response.json({ error: "first failure" }, { status: 500 }) : late.promise
      : Response.json({})));
    const { container } = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [fixturePng(), fixturePng()] } });
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss attachment error" }));
    await act(async () => late.reject(new Error("late failure")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("dismisses an attachment failure without removing a successfully attached file", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/workspace/upload"
      ? ++attempt === 1 ? Response.json({ ok: true, path: "assets/synthetic.png" }) : Response.json({ error: "disk full" }, { status: 500 })
      : Response.json({})));
    const { container } = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    pick(container);
    await waitFor(() => expect(screen.getByAltText("synthetic.png")).toHaveStyle({ opacity: "1" }));
    pick(container);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("disk full"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss attachment error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByAltText("synthetic.png")).toHaveStyle({ opacity: "1" });
  });

  it("clears the old error at retry and ignores an older attempt's late failure", async () => {
    const old = deferred<Response>();
    const retry = deferred<Response>();
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/workspace/upload"
      ? ++attempt === 1 ? Response.json({ error: "first failure" }, { status: 500 }) : attempt === 2 ? old.promise : retry.promise
      : Response.json({})));
    const { container } = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    pick(container);
    await screen.findByRole("alert");
    pick(container);
    await waitFor(() => expect(attempt).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    pick(container);
    await waitFor(() => expect(attempt).toBe(3));
    await act(async () => retry.resolve(Response.json({ ok: true, path: "assets/synthetic.png" })));
    await act(async () => old.reject(new Error("late old failure")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByAltText("synthetic.png")).toHaveStyle({ opacity: "1" });
  });

  it.each(["failure", "success"])("does not apply an old chat's pending upload %s in a different profile", async (result) => {
    const upload = deferred<Response>();
    let started = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/workspace/upload") { started = true; return upload.promise; }
      return Response.json({});
    }));
    const { container, rerender } = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    pick(container);
    await waitFor(() => expect(started).toBe(true));
    rerender(<ChatPanel nativeConversationKey={otherKey} initialSessionId={otherKey} nativeTransport="gateway" />);
    snapshot(otherKey);
    await act(async () => result === "failure" ? upload.reject(new Error("old profile failure")) : upload.resolve(Response.json({ ok: true, path: "assets/old.png" })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByAltText("synthetic.png")).not.toBeInTheDocument();
  });

  it("clears an existing attachment error when changing conversations", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/workspace/upload" ? Response.json({ error: "old failure" }, { status: 500 }) : Response.json({})));
    const { container, rerender } = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    pick(container);
    await screen.findByRole("alert");
    rerender(<ChatPanel nativeConversationKey={otherKey} initialSessionId={otherKey} nativeTransport="gateway" />);
    snapshot(otherKey);
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
    FakeEventSource.instance.emit("snapshot", { key, gateway: "connected", conversation: { id: "png-fixture", profile: "alpha", working: false, source: "crm", access: ownerAccess }, messages: [], pendingRequests: [], running: false, generation: 1, seq: 0 });
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File([png], "synthetic.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(`synthetic.png: ${detail}`));
    expect(screen.queryByAltText("synthetic.png")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/prompt"))).toBe(false);
  });
});
