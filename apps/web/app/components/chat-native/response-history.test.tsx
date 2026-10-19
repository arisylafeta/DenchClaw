// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce, type ChatState } from "@/lib/hermes-chat/reducer";
import type { GatewayEvent } from "@/lib/hermes-chat/events";
import { applyLive, applySnapshot, beginHydration, initialReconcileState } from "@/lib/hermes-chat/reconcile";
import { stateFromSnapshot, type GatewayChatSnapshot } from "@/lib/hermes-chat/snapshot";
import { NativeTranscript } from "./native-transcript";

const response = "The synthetic inventory review is complete. Pack A has a readable label and Pack B needs an isolation test before listing. Keep both records separate and retain the photographs. This is the complete response, including this final sentence.";
const final = "The additional synthetic check is complete. No inventory was changed.";
const callbacks = { onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() };
let nextId = 0;
const ctx = { now: () => 1000 + nextId, id: () => `history-${++nextId}` };
const event = (type: string, text?: string): GatewayEvent => ({ type, payload: text === undefined ? {} : { text } });
const startTool: GatewayEvent = { type: "tool.start", payload: { tool_id: "synthetic-check", name: "read_file", args: { path: "synthetic-inventory.md" } } };
const endTool: GatewayEvent = { type: "tool.complete", payload: { ...startTool.payload, result: "Synthetic check passed" } };
const advance = (state: ChatState, ...events: GatewayEvent[]) => events.reduce((current, frame) => reduce(current, frame, ctx), state);
const initial = () => advance(initialState("chat"), event("client.submit", "Review synthetic inventory"), event("message.start"), event("message.delta", response));

function expectVisibleResponse(container: HTMLElement, text = response) {
  const answers = [...container.querySelectorAll('[data-segment="text"], [data-segment="interim"]')].filter(node => !node.closest('[data-segment="work"]'));
  expect(answers.filter(node => node.textContent === text)).toHaveLength(1);
}
afterEach(cleanup);

describe("assistant response history across continued tool rounds", () => {
  it.each(["streaming", "interim", "complete"])("never demotes a visible %s answer when tools continue", boundary => {
    let state = initial();
    const view = render(<NativeTranscript state={state} callbacks={callbacks} />);
    expectVisibleResponse(view.container);
    if (boundary === "interim") state = advance(state, event("message.interim", response));
    if (boundary === "complete") state = advance(state, event("message.complete", response), event("message.start"));
    state = advance(state, startTool);
    view.rerender(<NativeTranscript state={state} callbacks={callbacks} />);
    expectVisibleResponse(view.container);
    const answer = view.container.querySelector('[data-segment="text"], [data-segment="interim"]')!;
    const tool = view.container.querySelector('[data-tool-id]')!;
    expect(answer.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    state = advance(state, endTool, event("message.delta", final), event("message.complete", final), event("message.complete", final));
    view.rerender(<NativeTranscript state={state} callbacks={callbacks} />);
    expectVisibleResponse(view.container);
    expectVisibleResponse(view.container, final);
    expect(view.container.querySelectorAll('[data-tool-id]')).toHaveLength(1);
    const finalAnswer = [...view.container.querySelectorAll('[data-segment="text"]')].find(node => node.textContent === final)!;
    expect(tool.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps streamed chunks, multiple tool rounds and reasoning in their own chronological blocks", () => {
    let state = advance(initialState("chat"), event("client.submit", "Synthetic question"), event("message.start"), event("reasoning.delta", "Private synthetic plan"), event("message.delta", response.slice(0, 80)), event("message.delta", response.slice(80)));
    state = advance(state, startTool, endTool, event("message.delta", "Additional public commentary."), { ...startTool, payload: { ...startTool.payload, tool_id: "second-check" } }, { ...endTool, payload: { ...endTool.payload, tool_id: "second-check" } }, event("message.delta", final), event("message.complete", final));
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks} />);
    expectVisibleResponse(container);
    expectVisibleResponse(container, "Additional public commentary.");
    expectVisibleResponse(container, final);
    const article = container.querySelector('article[aria-label="assistant message"]')!;
    expect([...article.children].map(node => node.getAttribute("data-segment"))).toEqual(["work", "text", "work", "text", "work", "text"]);
    expect(container.querySelectorAll('[data-tool-id]')).toHaveLength(2);
    expect([...container.querySelectorAll('.chat-prose')].some(node => node.textContent?.includes("Private synthetic plan"))).toBe(false);
  });

  const snapshot: GatewayChatSnapshot = {
    key: "p:chat", conversation: { id: "chat", profile: "p", title: "Synthetic", working: false }, generation: 0, seq: 10, running: false, pendingRequests: [],
    messages: [
      { id: "1", role: "user", text: "Review synthetic inventory" },
      { id: "2", role: "assistant", parts: [{ type: "text", text: response }] },
      { id: "3", role: "assistant", parts: [{ type: "reasoning", text: "Check the synthetic fixture only." }, { type: "tool-invocation", toolCallId: "synthetic-check", toolName: "read_file", args: { path: "synthetic-inventory.md" }, result: "Synthetic check passed" }] },
      { id: "4", role: "assistant", parts: [{ type: "text", text: final }] },
    ],
  };
  it("retains full chronological prose after reloading durable tool-round rows", () => {
    const state = stateFromSnapshot(snapshot, ctx);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks} />);
    expectVisibleResponse(container);
    expectVisibleResponse(container, final);
    const content = container.textContent!;
    expect(content.indexOf(response)).toBeLessThan(content.indexOf("Read synthetic-inventory.md"));
    expect(content.indexOf("Read synthetic-inventory.md")).toBeLessThan(content.indexOf(final));
  });
  it("does not duplicate responses or tools when a completion is reconciled with durable history", () => {
    let state = beginHydration(initialReconcileState("chat", "p:chat"));
    state = applySnapshot(state, { ...snapshot, messages: [], seq: 0 }, state.loadToken, ctx);
    state = applyLive(state, [event("client.submit", "Review synthetic inventory"), event("message.start"), event("message.delta", response), event("message.interim", response), startTool, endTool, event("message.delta", final), event("message.complete", final)], ctx);
    state = beginHydration(state);
    state = applySnapshot(state, snapshot, state.loadToken, ctx);
    state = applySnapshot(state, snapshot, state.loadToken, ctx);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks} />);
    expectVisibleResponse(container);
    expectVisibleResponse(container, final);
    expect(container.querySelectorAll('[data-tool-id]')).toHaveLength(1);
  });
});
