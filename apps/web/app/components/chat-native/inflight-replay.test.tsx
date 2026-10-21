// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applySnapshot, initialReconcileState } from "@/lib/hermes-chat/reconcile";
import { reduce } from "@/lib/hermes-chat/reducer";
import { stateFromSnapshot, unpersistedStream, type GatewayChatSnapshot } from "@/lib/hermes-chat/snapshot";
import { NativeTranscript } from "./index";

const ctx = { now: () => Date.now(), id: (() => { let n = 0; return () => `id-${++n}`; })() };
const callbacks = { onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() };
const NARRATION = "Not available as a tool; I'll find the session on disk.";
const t0 = Date.now() - 200_000;

/** Session 20261021_205538_165bbe at 21:00: rows persisted per model call while a 165s terminal call runs. */
function midTurnSnapshot(extra: Partial<GatewayChatSnapshot> = {}): GatewayChatSnapshot {
  return {
    key: "k", conversation: { id: "s", profile: "devon", title: "Chat", working: true }, running: true, pendingRequests: [], generation: 1, seq: 40,
    messages: [
      { id: "8793", role: "user", text: "please read this trace", pending: "inflight", timestamp: t0 },
      { id: "8794", role: "assistant", timestamp: t0 + 6_000, parts: [{ type: "reasoning", text: "Look up the session." }, { type: "tool-invocation", toolCallId: "a", toolName: "tool_describe", args: {}, result: "{}" }] },
      { id: "8796", role: "assistant", timestamp: t0 + 9_000, parts: [{ type: "tool-invocation", toolCallId: "b", toolName: "tool_search", args: {}, result: "{}" }] },
      { id: "8798", role: "assistant", timestamp: t0 + 14_000, parts: [{ type: "text", text: NARRATION }, { type: "tool-invocation", toolCallId: "c", toolName: "terminal", args: { command: "sqlite3 state.db" } }] },
    ],
    inflight: { user: "please read this trace", assistant: NARRATION, streaming: true },
    ...extra,
  };
}

describe("reload during a long tool call", () => {
  it("strips persisted narration from the live buffer", () => {
    expect(unpersistedStream(NARRATION, [NARRATION])).toBe("");
    expect(unpersistedStream(`${NARRATION}Next part`, [NARRATION])).toBe("Next part");
    expect(unpersistedStream(`One.Two.Three`, ["One.", "Two."])).toBe("Three");
    expect(unpersistedStream("Unrelated stream", ["Other text"])).toBe("Unrelated stream");
  });

  it("shows the narration once and the running tool live, not a stale finished block", () => {
    const state = stateFromSnapshot(midTurnSnapshot(), ctx);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks} />);
    expect(screen.getAllByText(NARRATION)).toHaveLength(1);
    // Before the fix the duplicate narration closed the block holding the running tool ("Thought for 3m 9s").
    const blocks = container.querySelectorAll('[data-segment="work"]');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].querySelector("summary")?.textContent).toMatch(/^Thought for/);
    expect(blocks[1]).toHaveAttribute("open");
    expect(blocks[1].querySelector("summary")?.textContent).toMatch(/^Thinking/);
    expect(blocks[1].textContent).toMatch(/Running a shell command\s*3m \d+s/);
    // The narration sits between the two blocks, not after the running tool.
    expect(container.textContent?.indexOf(NARRATION)).toBeLessThan(container.textContent!.indexOf("Running a shell command"));
  });

  it("keeps new streamed text that is not persisted yet, once", () => {
    const state = stateFromSnapshot(midTurnSnapshot({ inflight: { user: "please read this trace", assistant: `${NARRATION}Found it.`, streaming: true } }), ctx);
    render(<NativeTranscript state={state} callbacks={callbacks} />);
    expect(screen.getAllByText(NARRATION)).toHaveLength(1);
    expect(screen.getByText("Found it.")).toBeInTheDocument();
  });

  it("does not duplicate after a refresh and a later delta", () => {
    let state = initialReconcileState("s", "k");
    state = { ...state, loadToken: 1 };
    state = applySnapshot(state, midTurnSnapshot(), 1, ctx);
    state = applySnapshot({ ...state, hydrating: true }, midTurnSnapshot({ seq: 41 }), 1, ctx);
    state = { ...state, ...reduce(state, { type: "tool.complete", generation: 1, seq: 42, payload: { tool_id: "c", name: "terminal", result: "ok" } }, ctx) };
    state = { ...state, ...reduce(state, { type: "message.delta", generation: 1, seq: 43, payload: { text: "Done." } }, ctx) };
    render(<NativeTranscript state={state} callbacks={callbacks} />);
    expect(screen.getAllByText(NARRATION)).toHaveLength(1);
    expect(screen.getAllByText("Done.")).toHaveLength(1);
  });
});
