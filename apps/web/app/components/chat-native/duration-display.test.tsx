// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Segment } from "@/lib/hermes-chat/reducer";
import type { Subagent } from "@/lib/hermes-chat/subagents";
import { ChainOfThought } from "../chain-of-thought";
import { PromptDock } from "./prompt-dock";
import type { NativeTranscriptCallbacks } from "./types";
import { WorkBlock } from "./work-block";

const start = 1_000_000;
const callbacks: NativeTranscriptCallbacks = {
  onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(),
  onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn(),
};
const reasoning = (seconds?: number): Segment => ({
  type: "reasoning", id: "reason", text: "Plan", startedAt: start,
  ...(seconds === undefined ? {} : { completedAt: start + seconds * 1000 }),
});
const agent = (overrides: Partial<Subagent> = {}): Subagent => ({
  id: "worker", parentId: null, depth: 0, goal: "Inspect timers", taskIndex: 0, taskCount: 1,
  status: "running", startedAt: start, updatedAt: start,
  filesRead: [], filesWritten: [], outputTail: [], activity: [], ...overrides,
});
function Dock({ worker }: { worker: Subagent }) {
  return <PromptDock state={{ sessionId: "chat", pendingRequests: [] }} subagents={{ items: [worker], retiredIds: [] }} callbacks={callbacks} />;
}
const boundaries = [
  [119, "119s"], [120, "2m 0s"], [126, "2m 6s"], [3599, "59m 59s"],
  [3600, "1h 0m"], [3840, "1h 4m"], [7199, "1h 59m"], [7200, "2h 0m"],
] as const;

describe("thinking and subagent duration displays", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps native thinking and docked subagent clocks ticking across both unit thresholds", () => {
    const { container } = render(<><WorkBlock work={[reasoning()]} live /><Dock worker={agent()} /></>);
    let elapsed = 0;
    for (const [seconds, expected] of boundaries) {
      act(() => { vi.advanceTimersByTime((seconds - elapsed) * 1000); });
      elapsed = seconds;
      expect(container.querySelector('[data-segment="work"] > summary')).toHaveTextContent(`Thinking ${expected}`);
      const subagent = screen.getByRole("region", { name: "Subagent: Inspect timers" });
      expect(subagent.querySelector("summary")).toHaveTextContent(`Running · ${expected}`);
    }
  });

  it.each(boundaries)("formats finished thinking and supplied subagent duration at %s seconds", (seconds, expected) => {
    const { container } = render(<><WorkBlock work={[reasoning(seconds + 0.9)]} live={false} /><Dock worker={agent({ status: "completed", durationSeconds: seconds + 0.9, updatedAt: start + 999_000 })} /></>);
    expect(screen.getByText(`Thought for ${expected}`)).toBeInTheDocument();
    expect(container.querySelector('[data-segment="reasoning"]')).toHaveTextContent(`Thought${expected}`);
    const subagent = screen.getByRole("region", { name: "Subagent: Inspect timers" });
    expect(subagent.querySelector("summary")).toHaveTextContent(`Done · ${expected}`);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(subagent.querySelector("summary")).toHaveTextContent(`Done · ${expected}`);
    expect(screen.getByText(`Thought for ${expected}`)).toBeInTheDocument();
  });

  it("uses terminal timestamps when subagent duration is absent and stops ticking on completion", () => {
    const { rerender } = render(<Dock worker={agent()} />);
    act(() => { vi.advanceTimersByTime(126_000); });
    rerender(<Dock worker={agent({ status: "failed", updatedAt: start + 120_999 })} />);
    const subagent = screen.getByRole("region", { name: "Subagent: Inspect timers" });
    expect(subagent.querySelector("summary")).toHaveTextContent("Failed · 2m 0s");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(subagent.querySelector("summary")).toHaveTextContent("Failed · 2m 0s");
  });

  it("applies the same boundaries to legacy thinking and retains its finished duration", () => {
    const { rerender } = render(<ChainOfThought parts={[{ kind: "reasoning", text: "Plan", isStreaming: true }]} isStreaming />);
    let elapsed = 0;
    for (const [seconds, expected] of boundaries) {
      act(() => { vi.advanceTimersByTime((seconds - elapsed) * 1000); });
      elapsed = seconds;
      expect(screen.getByRole("button", { name: `Thinking for ${expected}` })).toBeInTheDocument();
    }
    rerender(<ChainOfThought parts={[{ kind: "reasoning", text: "Plan", isStreaming: false }]} />);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByRole("button", { name: "Thought for 2h 0m" })).toBeInTheDocument();
  });
});
