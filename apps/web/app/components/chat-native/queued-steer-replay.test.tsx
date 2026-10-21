// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { applyLive, initialReconcileState, markSteerPending, submitOptimistic, type ReconcileState } from "@/lib/hermes-chat/reconcile";
import { messageText } from "@/lib/hermes-chat/reducer";
import type { GatewayEvent } from "@/lib/hermes-chat/events";
import { NativeTranscript, PromptDock } from "./index";
import { displayTurns } from "./work-block";
import recorded from "./fixtures/queued-steer-capture.json";

/**
 * Recorded from the live gateway (throwaway CRM session): prompt A, then "ones dos tres" sent 1.5s later
 * while A was still thinking. session.steer answered "queued" (accepted), A finished without a tool
 * call, and Hermes ran the steer as its own next turn.
 */
const capture = recorded as unknown as { events: (GatewayEvent & { t: number; local?: string })[] };
let n = 0;
const ctx = { now: () => 1000, id: () => `id-${++n}` };
const callbacks = { onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() };
const live = (state: ReconcileState, until: number, from = -1) => applyLive(state, capture.events.filter(event => !event.local && event.t > from && event.t <= until), ctx);
const texts = (state: ReconcileState, ids: string[]) => displayTurns(state.messages.filter(message => !ids.includes(message.id))).map(message => `${message.role}:${messageText(message).slice(0, 10)}`);

it("keeps a steer the agent never read out of the transcript, then shows it as its own turn after the reply", () => {
  let state: ReconcileState = { ...initialReconcileState("s", "k"), hydrating: false, generation: 1 };
  state = submitOptimistic(state, { clientId: "a", text: "Reply with exactly one short sentence about the colour blue." });
  state = live(state, 1528);
  state = submitOptimistic(state, { clientId: "b", text: "ones dos tres" });
  state = markSteerPending(state, "b");
  const waiting = () => state.messages.filter(message => message.source === "queued").map(message => message.id);
  expect(waiting()).toEqual(["b"]);
  // Before: the prompt and the steer sat together with A's reply below both.
  state = live(state, 3194, 1528);
  expect(texts(state, waiting())).toEqual(["user:Reply with", "assistant:Blue is th"]);
  const { rerender } = render(<><NativeTranscript state={state} queuedMessageIds={waiting()} callbacks={callbacks} /><PromptDock state={state} subagents={state.subagents} callbacks={callbacks} queued={[{ id: "b", text: "ones dos tres", steer: true }]} /></>);
  expect(screen.getByLabelText("Waiting messages")).toHaveTextContent("Steerones dos tresafter this step");
  expect(screen.getAllByText("ones dos tres")).toHaveLength(1);
  state = live(state, 99_999, 3194);
  expect(waiting()).toEqual([]);
  expect(texts(state, [])).toEqual(["user:Reply with", "assistant:Blue is th", "user:ones dos t", "assistant:TLDR: That"]);
  rerender(<NativeTranscript state={state} callbacks={callbacks} />);
  expect(screen.getAllByText("ones dos tres")).toHaveLength(1);
});

it("places an accepted steer inline when the agent reads it after a tool batch", () => {
  let state: ReconcileState = { ...initialReconcileState("s", "k"), hydrating: false };
  state = submitOptimistic(state, { clientId: "a", text: "Do work" });
  state = applyLive(state, [{ type: "message.start" }, { type: "tool.start", payload: { tool_id: "t", name: "terminal", args: { command: "pwd" } } }], ctx);
  state = markSteerPending(submitOptimistic(state, { clientId: "b", text: "Also check logs" }), "b");
  expect(state.messages.at(-1)).toMatchObject({ id: "b", source: "queued", steerPending: true });
  state = applyLive(state, [{ type: "tool.complete", payload: { tool_id: "t", name: "terminal", result: "ok" } }, { type: "message.delta", payload: { text: "Checked logs too." } }], ctx);
  expect(state.messages.find(message => message.id === "b")).toMatchObject({ source: "optimistic", pending: false });
  expect(displayTurns(state.messages).map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(messageText(state.messages.at(-1)!)).toBe("Checked logs too.");
});
