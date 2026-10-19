// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel, type ChatPanelHandle } from "./chat-panel";
import { conversationKey } from "@/lib/hermes-conversations";
import { getHermesEventsClient } from "@/lib/hermes-chat/events-client";
import { readFileSync } from "node:fs";

// Keep the actual TipTap editor, transport hook, reconciliation and slash wrapper.
vi.mock("./chat-message", () => ({ ChatMessage: () => null }));
vi.mock("./hero-suggestions", () => ({ HeroSuggestions: () => null }));
vi.mock("./chat-voice-input-button", () => ({ ChatVoiceInputButton: () => null }));
vi.mock("./chat-native/model-controls", () => ({ NativeModelControls: () => null }));
const key = conversationKey("solo", "phone-fixture", "alpha");
const endpoint = `/api/hermes/conversations/${encodeURIComponent(key)}`;
let fetchMock: ReturnType<typeof vi.fn>;
class FakeEventSource {
  static instance: FakeEventSource;
  listeners: Record<string, Array<(event: MessageEvent) => void>> = {};
  readyState = 1;
  constructor(readonly url: string) { FakeEventSource.instance = this; }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener); }
  close() { this.readyState = 2; }
  emit(type: string, data: unknown) { act(() => { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) } as MessageEvent); }); }
}
function snapshot(target = key, messages: unknown[] = []) {
  FakeEventSource.instance.emit("snapshot", { key: target, conversation: { id: "phone-fixture", profile: "alpha", title: "Synthetic", working: false, source: "crm" }, messages, running: false, generation: 1, seq: 0, pendingRequests: [], gateway: "connected" });
}
async function typeDraft(text: string) {
  const editor = await screen.findByRole("textbox", { name: "Message" });
  editor.focus();
  // Native contenteditable input is reconciled through real ProseMirror's MutationObserver.
  await act(async () => { editor.innerHTML = text.split("\n").map(line => `<p>${line}</p>`).join(""); fireEvent.input(editor, { inputType: "insertText", data: text }); await new Promise(resolve => setTimeout(resolve, 25)); });
  expect(editor.textContent).toBe(text.replaceAll("\n", ""));
  return editor;
}
function promptCalls() { return fetchMock.mock.calls.filter(([url]) => /\/(prompt|steer|slash-execute)$/.test(url)); }
beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
  fetchMock = vi.fn(async (url: string) => url === "/api/settings/cloud" ? Response.json({ status: "no_key" }) : Response.json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); getHermesEventsClient().close(); vi.unstubAllGlobals(); });
describe("phone composer readiness with the real TipTap editor", () => {
  it("types immediately, blocks Enter/button/imperative sends and submits the exact draft to the resolved profile", async () => {
    const ref = React.createRef<ChatPanelHandle>();
    const view = render(<ChatPanel ref={ref} initializing />);
    const editor = await typeDraft("Draft before discovery\nsecond line");
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(document.activeElement).toBe(editor);
    expect(screen.getByTitle("Send message")).toBeDisabled();
    fireEvent.keyDown(editor, { key: "Enter" });
    await act(() => ref.current!.sendNewMessage("Do not send"));
    expect(promptCalls()).toHaveLength(0);
    expect(editor.textContent).toBe("Draft before discoverysecond line");
    view.rerender(<ChatPanel ref={ref} initializing={false} nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    expect(screen.getByTitle("Send message")).toBeDisabled();
    snapshot();
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    await waitFor(() => expect(screen.getByTitle("Send message")).toBeEnabled());
    expect(promptCalls()).toHaveLength(0); // No auto-send on readiness.
    expect(promptCalls()).toHaveLength(0);
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(promptCalls()).toHaveLength(1));
    const [url, init] = promptCalls()[0];
    expect(url).toBe(`${endpoint}/prompt`);
    expect(JSON.parse(init.body)).toMatchObject({ text: "Draft before discovery\nsecond line", html: "<p>Draft before discovery</p><p>second line</p>" });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/chat" || url.startsWith("/api/web-sessions"))).toBe(false);
  });

  it("keeps an editable draft through hydration failure, reconnect and a new snapshot", async () => {
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    const editor = await typeDraft("Keep this retry draft");
    FakeEventSource.instance.emit("error", { error: "Synthetic history unavailable" });
    expect(screen.getByRole("alert")).toHaveTextContent("Synthetic history unavailable");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(promptCalls()).toHaveLength(0);
    expect(editor).toHaveAttribute("contenteditable", "true");
    FakeEventSource.instance.emit("resync", { key });
    expect(editor.textContent).toBe("Keep this retry draft");
    snapshot(key, [{ id: "history", role: "assistant", content: "Recovered synthetic history" }]);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    expect(editor.textContent).toBe("Keep this retry draft");
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(promptCalls()).toHaveLength(1));
    expect(JSON.parse(promptCalls()[0][1].body).text).toBe("Keep this retry draft");
  });

  it("never sends to a prior profile when identity changes while the new history is pending", async () => {
    const view = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    const editor = await typeDraft("New profile draft");
    const next = conversationKey("solo", "other-fixture", "beta");
    view.rerender(<ChatPanel initializing nativeConversationKey={next} initialSessionId={next} nativeTransport="gateway" />);
    fireEvent.keyDown(editor, { key: "Enter" });
    snapshot(key); // A late response for the prior profile cannot unlock send.
    expect(screen.getByTitle("Send message")).toBeDisabled();
    expect(promptCalls()).toHaveLength(0);
    view.rerender(<ChatPanel nativeConversationKey={next} initialSessionId={next} nativeTransport="gateway" />);
    snapshot(next);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(promptCalls()).toHaveLength(1));
    expect(promptCalls()[0][0]).toBe(`/api/hermes/conversations/${encodeURIComponent(next)}/prompt`);
    expect(JSON.parse(promptCalls()[0][1].body).text).toBe("New profile draft");
  });

  it("keeps typing while approval blocks send and preserves the draft until the request resolves", async () => {
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    FakeEventSource.instance.emit("request", { key, id: "pending-approval", method: "approval", params: { command: "synthetic", choices: ["once", "deny"] } });
    const editor = await typeDraft("Draft during approval");
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(screen.getByTitle("Send message")).toBeDisabled();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(promptCalls()).toHaveLength(0);
    expect(editor.textContent).toBe("Draft during approval");
    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    await waitFor(() => expect(screen.getByTitle("Send message")).toBeEnabled());
    expect(editor.textContent).toBe("Draft during approval");
  });

  it("keeps typing during a lost connection and never submits or queues the draft on reconnect", async () => {
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    FakeEventSource.instance.emit("gateway", { state: "lost" });
    const editor = await typeDraft("Disconnected draft");
    expect(screen.getByTitle("Send message")).toBeDisabled();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor.textContent).toBe("Disconnected draft");
    FakeEventSource.instance.emit("gateway", { state: "connected" });
    snapshot();
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    expect(editor.textContent).toBe("Disconnected draft");
    expect(promptCalls()).toHaveLength(0);
  });

  it("does not submit Shift+Enter or IME Enter on a ready conversation", async () => {
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    const editor = await typeDraft("Multiline composition");
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    expect(promptCalls()).toHaveLength(0);
    expect(editor.textContent).toContain("Multiline composition");
  });

  it("blocks slash execution until ready without clearing the typed command", async () => {
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    const editor = await typeDraft("/fast");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor.textContent).toBe("/fast");
    expect(promptCalls()).toHaveLength(0);
    snapshot();
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(promptCalls()).toHaveLength(1));
    expect(promptCalls()[0][0]).toBe(`${endpoint}/slash-execute`);
  });

  it("tracks visible keyboard height and removes the listener on unmount", async () => {
    const viewport = new EventTarget() as EventTarget & { height: number; scale: number };
    viewport.height = 780; viewport.scale = 1;
    const remove = vi.spyOn(viewport, "removeEventListener");
    vi.stubGlobal("visualViewport", viewport);
    const view = render(<ChatPanel initializing />);
    const panel = view.container.firstElementChild as HTMLElement;
    expect(panel.style.getPropertyValue("--chat-visible-height")).toBe("780px");
    viewport.height = 340; act(() => viewport.dispatchEvent(new Event("resize")));
    expect(panel.style.getPropertyValue("--chat-visible-height")).toBe("340px");
    viewport.scale = 2; viewport.height = 170; act(() => viewport.dispatchEvent(new Event("resize")));
    expect(panel.style.getPropertyValue("--chat-visible-height")).toBe("340px");
    view.unmount(); expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("contracts phone height/type and in-flow safe-area layout without changing desktop editor rules", () => {
    const editor = readFileSync(`${process.cwd()}/app/components/tiptap/chat-editor.tsx`, "utf8");
    const css = readFileSync(`${process.cwd()}/app/components/chat-composer.module.css`, "utf8");
    expect(editor).toMatch(/@media \(max-width: 767px\)[\s\S]*min-height: 96px/);
    expect(editor).toMatch(/font-size: 16px/);
    expect(editor).toContain("var(--chat-visible-height, 100dvh)");
    expect(editor).toContain('compact ? "12px" : "14px"');
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*position: relative/);
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("min-height: 44px");
  });
});
