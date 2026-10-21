// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PromptDock } from "./index";
import { initialState, reduce } from "@/lib/hermes-chat/reducer";
import type { GatewayEvent } from "@/lib/hermes-chat/events";

const cb = { onApproval() {}, onClarify() {}, onSubagentTail() {}, onSubagentSteer() {}, onSubagentInterrupt() {}, onRetry() {} } as never;
const started = (extra: Record<string, unknown> = {}) => reduce(initialState("s"), { type: "subagent.start", payload: { subagent_id: "a", goal: "Review diff", task_index: 0, task_count: 1, ...extra } } as GatewayEvent, { now: () => 1000, id: () => "m-1" });

describe("subagent profile avatar", () => {
  it("shows the parent's profile when the child reports none", () => {
    const state = started();
    const { container } = render(<PromptDock state={state} subagents={state.subagents} profile="devon" callbacks={cb} />);
    expect(container.querySelector('[data-subagent-avatar="devon"]')).not.toBeNull();
  });
  it("prefers the child's own profile", () => {
    const state = started({ profile: "orchas" });
    const { container } = render(<PromptDock state={state} subagents={state.subagents} profile="devon" callbacks={cb} />);
    expect(container.querySelector('[data-subagent-avatar="orchas"]')).not.toBeNull();
    expect(container.querySelector('[data-subagent-avatar="devon"]')).toBeNull();
  });
  it("shows only icons while running: no pixel grid anywhere in the dock", () => {
    const state = started();
    const { container } = render(<PromptDock state={state} subagents={state.subagents} profile="devon" callbacks={cb} />);
    expect(container.querySelector(".chat-pixel-cell")).toBeNull();
    expect(container.querySelector('[data-group-avatar="devon"]')).not.toBeNull();
    expect(container.querySelector('[data-subagent-avatar="devon"]')).not.toBeNull();
  });
  it("falls back to a flat dot, not the grid, when no profile is known", () => {
    const state = started();
    const { container } = render(<PromptDock state={state} subagents={state.subagents} callbacks={cb} />);
    expect(container.querySelector(".chat-pixel-cell")).toBeNull();
    expect(container.querySelector("[data-group-avatars] .rounded-full")).not.toBeNull();
  });
});
