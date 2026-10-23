// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel, type ChatPanelHandle } from "./chat-panel";
import { conversationKey } from "@/lib/hermes-conversations";
import { getHermesEventsClient } from "@/lib/hermes-chat/events-client";
import { ownerAccess } from "@/lib/hermes-chat/access-fixture";


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
  FakeEventSource.instance.emit("snapshot", { key: target, conversation: { id: "phone-fixture", profile: "alpha", title: "Synthetic", working: false, source: "crm", access: ownerAccess }, messages, running: false, generation: 1, seq: 0, pendingRequests: [], gateway: "connected" });
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
  it("uses the requested placeholder before the user starts typing", async () => {
    render(<ChatPanel initializing />);
    const editor = await screen.findByRole("textbox", { name: "Message" });
    expect(editor.querySelector("[data-placeholder]")).toHaveAttribute("data-placeholder", "What are we cooking?");
  });
  it("offers an agent choice rather than an endless loading skeleton for an unbound draft", async () => {
    const choose = vi.fn();
    const view = render(<ChatPanel conversationUnselected onChooseConversation={choose} />);
    const editor = await typeDraft("Draft before choosing an agent");
    expect(screen.getByTitle("Send message")).toBeDisabled();
    expect(screen.queryByLabelText("Loading chat history")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose an agent to send this draft" }));
    expect(choose).toHaveBeenCalledWith();
    view.rerender(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
    await waitFor(() => expect(screen.getByTitle("Send message")).toBeEnabled());
    expect(promptCalls()).toHaveLength(0);
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(promptCalls()).toHaveLength(1));
    expect(JSON.parse(promptCalls()[0][1].body).text).toBe("Draft before choosing an agent");
  });

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

  it("routes the compact answer to its exact request and restores the hidden normal draft", async () => {
    render(<ChatPanel compact nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    const editor = await typeDraft("Keep my normal draft");
    expect(editor).toHaveClass("chat-editor-multiline");
    FakeEventSource.instance.emit("request", { key, id: "clarify-exact", method: "clarify", params: { questions: [{ qid: "location-exact", question: "Where?", choices: ["Here", "Other"] }] } });
    const answer = await screen.findByRole("textbox", { name: "Other" });
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(editor.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Other/ }));
    expect(answer).toHaveFocus();
    fireEvent.change(answer, { target: { value: "Berlin" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === `${endpoint}/clarify`)).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === `${endpoint}/clarify`)!;
    expect(JSON.parse(init.body)).toMatchObject({ request_id: "clarify-exact", answers: { "location-exact": "Berlin" } });
    expect(promptCalls()).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor));
    expect(editor.textContent).toBe("Keep my normal draft");
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

  it("keeps slash output in the transcript across resync and surfaces command errors", async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/slash-execute') ? Response.json({ output: 'Synthetic output\nFull second line' }) : Response.json({}));
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    const editor = await typeDraft('/help');
    fireEvent.keyDown(editor, { key: 'Enter' });
    const result = await screen.findByRole('button', { name: /Ran \/help/ });
    expect(screen.queryByText('Command output')).toBeNull();
    fireEvent.click(result);
    expect(screen.getByText(/Full second line/, { selector: 'pre' })).toBeTruthy();
    snapshot();
    expect(screen.getByRole('button', { name: /Ran \/help/ })).toBeTruthy();
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/slash-execute') ? Response.json({ error: 'Synthetic command failure' }, { status: 400 }) : Response.json({}));
    await typeDraft('/help');
    fireEvent.keyDown(editor, { key: 'Enter' });
    const status = await screen.findByRole('alert');
    expect(status.textContent).toContain('/help: Synthetic command failure');
    expect(screen.queryByRole('button', { name: /Failed \/help/ })).toBeNull();
  });

  it("queues rewrite commands in the transcript and cancels before idle", async () => {
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    FakeEventSource.instance.emit('gw', { key, type: 'message.start', session_id: 'phone-fixture', generation: 1, seq: 1 });
    const editor = await typeDraft('/compress');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await screen.findByText(/\/compress queued until the reply finishes/);
    expect(promptCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued command' }));
    expect(screen.queryByText(/queued until the reply finishes/)).toBeNull();
    FakeEventSource.instance.emit('gw', { key, type: 'message.complete', session_id: 'phone-fixture', generation: 1, seq: 2, payload: { text: 'Finished' } });
    await act(async () => {});
    expect(promptCalls()).toHaveLength(0);
  });

  it("runs a queued rewrite once after idle and retains its result through hydration", async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/slash-execute') ? Response.json({ output: 'Compressed synthetic history' }) : Response.json({}));
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    FakeEventSource.instance.emit('gw', { key, type: 'message.start', session_id: 'phone-fixture', generation: 1, seq: 1 });
    const editor = await typeDraft('/compress');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await screen.findByText(/\/compress queued until the reply finishes/);
    FakeEventSource.instance.emit('gw', { key, type: 'message.complete', session_id: 'phone-fixture', generation: 1, seq: 2, payload: { text: 'Finished' } });
    snapshot();
    await screen.findByText(/Ran \/compress: Compressed synthetic history/);
    snapshot();
    expect(screen.getByText(/Ran \/compress: Compressed synthetic history/)).toBeTruthy();
    expect(screen.queryByText(/queued until the reply finishes/)).toBeNull();
    expect(promptCalls()).toHaveLength(1);
  });

  it("docks the command list on top of the input instead of floating over the page", async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/slash-complete') ? Response.json({ items: [{ text: '/compress', display: '/compress', meta: 'Compress the conversation' }], replace_from: 1, catalog: {} }) : Response.json({}));
    const view = render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    await typeDraft('/comp');
    const dock = await waitFor(() => { const node = view.container.querySelector('[data-slash-dock]'); if (!node) throw new Error('no dock'); return node; });
    expect(await screen.findByRole('option', { name: /\/compress/ })).toBeTruthy();
    expect(dock.closest('[role="dialog"]')).toBeNull();
    expect(dock.parentElement?.querySelector('.ProseMirror, [contenteditable]')).toBeTruthy();
  });

  it("retries a refused rewrite command only once instead of looping", async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/slash-execute') ? Response.json({ output: 'session busy — Hermes is still replying. Stop the current reply first' }) : Response.json({}));
    render(<ChatPanel nativeConversationKey={key} initialSessionId={key} nativeTransport="gateway" />);
    snapshot();
    const editor = await typeDraft('/compress');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await screen.findByText(/\/compress queued until the reply finishes/);
    snapshot();
    expect((await screen.findByRole('alert')).textContent).toContain('Hermes still reports the session as busy');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(promptCalls()).toHaveLength(2);
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


});
