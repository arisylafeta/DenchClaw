// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { goalFromState, goalVerdict, type GoalSnapshot } from "@/lib/hermes-chat/goal";
import { eventNotice } from "@/lib/hermes-chat/event-notices";
import { noticeForRow } from "@/lib/hermes-chat/notice";
import { initialState, reduce } from "@/lib/hermes-chat/reducer";
import { applySnapshot, initialReconcileState } from "@/lib/hermes-chat/reconcile";
import type { GatewayChatSnapshot } from "@/lib/hermes-chat/snapshot";
import { GoalCard, goalStatus, NativeTranscript, PromptDock } from "./index";

const ctx = { now: () => 1000, id: () => "id" };
const callbacks = { onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() };
// Shapes recorded from a live /goal run on the gateway.
const goal = (extra: Partial<GoalSnapshot> = {}): GoalSnapshot => ({
  title: "Say the numbers one, two and three in words, exactly one number per reply.", status: "active", turns_used: 1, max_turns: 20,
  contract: { outcome: "", verification: "one, two and three each appeared in a separate reply", constraints: "", boundaries: "", stop_when: "" },
  subgoals: [], gates: [], last_verdict: "continue", last_reason: "Only 'One' has been said so far.", ...extra,
});

describe("goal data", () => {
  it("reads Hermes' persisted state and treats a cleared goal as none", () => {
    const raw = { goal: "Ship it", status: "paused", turns_used: 20, max_turns: 20, paused_reason: "turn budget exhausted", subgoals: ["Tests pass"], gates: [{ command: "pnpm test", attempts: 1, max_retries: 3, last_exit_code: 1 }], contract: { verification: "CI green" }, waiting_until: 0 };
    expect(goalFromState(raw)).toMatchObject({ title: "Ship it", status: "paused", subgoals: ["Tests pass"], gates: [{ command: "pnpm test", last_exit_code: 1 }], contract: { verification: "CI green" } });
    expect(goalFromState({ ...raw, status: "cleared" })).toBeNull();
    expect(goalFromState(null)).toBeNull();
  });
  it("turns judge verdicts into short goal lines", () => {
    expect(goalVerdict("↻ Continuing toward goal (2/20): Three is still missing.")).toEqual({ verdict: "continue", text: "Goal turn 2 of 20 · Three is still missing.", reason: "Three is still missing." });
    expect(goalVerdict("✓ Goal achieved: All three said.").text).toBe("Goal achieved · All three said.");
    expect(eventNotice({ type: "status.update", payload: { kind: "goal", text: "✓ Goal achieved: All three said." } as never })).toMatchObject({ kind: "goal", text: "Goal achieved · All three said." });
    expect(eventNotice({ type: "session.control.update", payload: { control: { goal: goal() } } as never })).toBeNull();
  });
  it("shows continuation prompts as a goal line, not the user's bubble", () => {
    expect(noticeForRow({ role: "user", text: "[Continuing toward your standing goal]\nGoal: Ship it\n\nContinue working toward this goal." })).toMatchObject({ kind: "goal", text: "Continued toward the goal" });
    expect(noticeForRow({ role: "user", text: "Please keep [Continuing toward your standing goal] in mind" })).toBeNull();
  });
  it("tracks the goal from live updates and snapshots", () => {
    let state = reduce(initialState("s"), { type: "session.control.update", payload: { control: { goal: goal() } } as never }, ctx);
    expect(state.goal?.turns_used).toBe(1);
    state = reduce(state, { type: "session.control.update", payload: { control: { goal: null } } as never }, ctx);
    expect(state.goal).toBeNull();
    const snapshot: GatewayChatSnapshot = { key: "k", conversation: { id: "s", profile: "p", title: "", working: false }, messages: [], running: false, pendingRequests: [], generation: 1, seq: 1, goal: goal({ status: "done", last_verdict: "done" }) };
    const hydrated = applySnapshot(initialReconcileState("s", "k"), snapshot, 0, ctx);
    expect(hydrated.goal?.status).toBe("done");
  });
});

describe("goal card", () => {
  it("summarises status in one line and opens into contract and verdict", () => {
    const { container } = render(<GoalCard goal={goal()} busy onControl={vi.fn()} />);
    expect(screen.getByText("Turn 2 of 20")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Goal turn budget" })).toHaveAttribute("aria-valuenow", "1");
    expect(container.querySelector('[data-open="false"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Goal" }));
    expect(container.querySelector('section[data-open="true"]')).not.toBeNull();
    expect(screen.getByText("Verify")).toBeInTheDocument();
    expect(screen.getByText("Only 'One' has been said so far.")).toBeInTheDocument();
  });
  it("labels paused, blocked, waiting and done goals", () => {
    expect(goalStatus(goal({ status: "paused", turns_used: 20, paused_reason: "turn budget exhausted" })).label).toBe("Paused · budget used");
    expect(goalStatus(goal({ status: "paused", last_verdict: "blocked" })).tone).toBe("blocked");
    expect(goalStatus(goal({ wait_barrier: { type: "until", until_at: 1000 + 90, reason: "build" } }), 1_000_000).label).toBe("Waiting · 90s");
    expect(goalStatus(goal({ status: "done", turns_used: 3 })).label).toBe("Done in 3 turns");
  });
  it("pauses, resumes, clears and edits requirements through session controls", async () => {
    const onControl = vi.fn().mockResolvedValue({});
    const { rerender } = render(<GoalCard goal={goal({ subgoals: ["Say done at the end"] })} onControl={onControl} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    await waitFor(() => expect(onControl).toHaveBeenCalledWith("goal.pause", undefined));
    fireEvent.click(screen.getByRole("button", { name: "Goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove: Say done at the end" }));
    await waitFor(() => expect(onControl).toHaveBeenCalledWith("subgoal.remove", { index: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Add requirement" }));
    fireEvent.change(screen.getByLabelText("New requirement"), { target: { value: "Keep it short" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onControl).toHaveBeenCalledWith("subgoal.add", { text: "Keep it short" }));
    rerender(<GoalCard goal={goal({ status: "paused" })} onControl={onControl} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
    await waitFor(() => expect(onControl).toHaveBeenCalledWith("goal.resume", undefined));
    rerender(<GoalCard goal={goal({ status: "done" })} onControl={onControl} />);
    expect(screen.queryByRole("button", { name: "Pause goal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss goal" }));
    await waitFor(() => expect(onControl).toHaveBeenCalledWith("goal.clear", undefined));
  });
  it("offers to stop waiting when the goal waits on a barrier", async () => {
    const onControl = vi.fn().mockResolvedValue({});
    render(<GoalCard goal={goal({ wait_barrier: { type: "pid", target: 42, reason: "build" } })} onControl={onControl} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    await waitFor(() => expect(onControl).toHaveBeenCalledWith("goal.unwait", undefined));
  });
  it("shows a failed control inline", async () => {
    render(<GoalCard goal={goal()} onControl={vi.fn().mockRejectedValue(new Error("session_not_live"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("session_not_live");
  });
  it("docks above the input only when a goal exists", () => {
    const state = initialState("s");
    const { container, rerender } = render(<PromptDock state={state} subagents={state.subagents} callbacks={callbacks} goal={null} onGoalControl={vi.fn()} />);
    expect(container.querySelector("[data-prompt-dock]")).toBeNull();
    rerender(<PromptDock state={state} subagents={state.subagents} callbacks={callbacks} goal={goal()} onGoalControl={vi.fn()} />);
    expect(container.querySelector('[data-prompt-dock] section[aria-label="Goal"]')).not.toBeNull();
  });
});

it("renders one goal line per turn: the live verdict hides the matching continuation row", () => {
  let state = initialState("s");
  state = { ...state, messages: [
    { id: "1", role: "assistant", segments: [{ type: "text", id: "t1", text: "One", startedAt: 1 }], startedAt: 1, pending: false },
    { id: "v", role: "assistant", segments: [], startedAt: 2, pending: false, localNotice: true, notice: { kind: "goal", text: "Goal turn 1 of 20 · Two is missing." } },
    { id: "2", role: "user", segments: [{ type: "text", id: "t2", text: "[Continuing toward your standing goal]\nGoal: x", startedAt: 3 }], startedAt: 3, pending: false, notice: { kind: "goal", text: "Continued toward the goal" } },
    { id: "3", role: "assistant", segments: [{ type: "text", id: "t3", text: "Two", startedAt: 4 }], startedAt: 4, pending: false },
    { id: "4", role: "user", segments: [{ type: "text", id: "t4", text: "[Continuing toward your standing goal]\nGoal: x", startedAt: 5 }], startedAt: 5, pending: false, notice: { kind: "goal", text: "Continued toward the goal" } },
  ] };
  const { container } = render(<NativeTranscript state={state} callbacks={callbacks} />);
  expect([...container.querySelectorAll('[data-notice="goal"]')].map(node => node.textContent)).toEqual(["Goal turn 1 of 20 · Two is missing.", "Continued toward the goal"]);
  // The merged line still opens the prompt Hermes sent.
  fireEvent.click(container.querySelector('[data-notice="goal"] button')!);
  expect(container.querySelector('[data-notice="goal"]')?.textContent).toContain("[Continuing toward your standing goal]");
});
