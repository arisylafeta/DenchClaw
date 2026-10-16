// @vitest-environment jsdom
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState, reduce, type ChatState } from "@/lib/hermes-chat/reducer";
import type { GatewayEvent } from "@/lib/hermes-chat/events";
import { NativeTranscript, ApprovalCard, ClarifyCard, ReadOnlyNotice } from "./index";
import type { NativeTranscriptCallbacks } from "./types";

function events(frames: Array<[string, GatewayEvent["payload"], (string | number)?]>, base = initialState("chat")): ChatState {
  let id = 0;
  return frames.reduce((state, [type, payload, requestId], index) => reduce(state, { type, payload, requestId }, { now: () => 1000 + index * 1000, id: () => `m-${++id}` }), base);
}
function callbacks(): NativeTranscriptCallbacks {
  return { onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() };
}
function approval() {
  return events([["approval.request", { command: "rm generated.txt", tool_name: "terminal", choices: ["once", "session", "always", "deny"], allow_session: true, allow_permanent: true }, "srq-1"]]).pendingRequests[0];
}
function clarify(questions: NonNullable<NonNullable<GatewayEvent["payload"]>["questions"]>) {
  return events([["clarify.request", { questions }, "srq-2"]]).pendingRequests[0];
}

describe("native transcript", () => {
  it("preserves prose, reasoning, grouped tools, and interim ordering", () => {
    const state = events([
      ["client.submit", { text: "Research CRM", id: "user" }],
      ["message.start", {}], ["message.delta", { text: "First narration" }],
      ["reasoning.delta", { text: "Think carefully" }],
      ["tool.start", { tool_id: "read", name: "read_file", args: { path: "README" } }],
      ["tool.complete", { tool_id: "read", name: "read_file", result: "read" }],
      ["tool.start", { tool_id: "shell", name: "terminal", args: { command: "pwd" } }],
      ["tool.complete", { tool_id: "shell", name: "terminal", result: { exit_code: 0 } }],
      ["message.delta", { text: "Last narration" }],
      ["message.interim", { text: "Last narration" }],
    ]);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks()} queuedMessageIds={["user"]} userHtml={() => '<span class="mention" onclick="bad()">CRM</span><script>unsafe()</script>'} />);
    expect([...container.querySelectorAll("[data-segment]")].map(node => node.getAttribute("data-segment"))).toEqual(["interim", "reasoning", "tool-run", "interim"]);
    expect(screen.getByText("Explored 1 file, ran 1 command")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-tool-id]")).toHaveLength(2);
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("CRM")).not.toHaveAttribute("onclick");
    expect(container.querySelector("script")).toBeNull();
  });

  it("updates a running tool to done and collapses completed reasoning", () => {
    const live = events([["message.start", {}], ["reasoning.delta", { text: "Plan" }]]);
    const cb = callbacks();
    const { container, rerender } = render(<NativeTranscript state={live} callbacks={cb} />);
    expect(container.querySelector('[data-segment="reasoning"]')).toHaveAttribute("open");
    const running = events([["tool.start", { tool_id: "t", name: "terminal", args: { command: "pwd" } }]], live);
    rerender(<NativeTranscript state={running} callbacks={cb} />);
    expect(screen.getByText("Running pwd")).toBeInTheDocument();
    expect(container.querySelector('[data-segment="reasoning"]')).not.toHaveAttribute("open");
    const done = events([["tool.complete", { tool_id: "t", name: "terminal", result: { exit_code: 0 }, duration_s: 2 }]], running);
    rerender(<NativeTranscript state={done} callbacks={cb} />);
    expect(screen.queryByText("Running pwd")).not.toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Exit code: 0")).toBeInTheDocument();
  });

  it("shows tool errors and unified diff file counts", () => {
    const state = events([["tool.complete", { tool_id: "edit", name: "edit_file", inline_diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+extra", result: { error: "Permission denied" } }]]);
    render(<NativeTranscript state={state} callbacks={callbacks()} />);
    expect(screen.getByText("Permission denied", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("file.ts: +2 −1")).toBeInTheDocument();
  });

  it.each(["Run once", "Allow for session", "Deny"])("submits %s with the wire choice", label => {
    const onApproval = vi.fn();
    const request = approval();
    render(<ApprovalCard request={request} onApproval={onApproval} />);
    expect(screen.getByRole("region", { name: "Approval required" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onApproval).toHaveBeenCalledWith(request, ({ "Run once": "once", "Allow for session": "session", Deny: "deny" })[label]);
  });

  it("requires inline confirmation before always allowing", () => {
    const onApproval = vi.fn(); const request = approval();
    render(<ApprovalCard request={request} onApproval={onApproval} />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(onApproval).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm always allow" }));
    expect(onApproval).toHaveBeenCalledWith(request, "always");
  });

  it("retains a withdrawn approval without actionable buttons", () => {
    const state = events([["approval.request", { command: "danger" }, "srq-1"]]);
    const cb = callbacks();
    const { rerender } = render(<NativeTranscript state={state} callbacks={cb} />);
    rerender(<NativeTranscript state={events([["request.cancel", { id: "srq-1" }]], state)} callbacks={cb} />);
    expect(screen.getByText("Resolved or withdrawn")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run once" })).not.toBeInTheDocument();
  });

  it("answers the four-option question with one click", () => {
    const request = clarify([{ qid: "direction", question: "Which route?", choices: ["North", "East", "South", "West"] }]);
    const onClarify = vi.fn();
    render(<ClarifyCard request={request} onClarify={onClarify} />);
    fireEvent.click(screen.getByRole("button", { name: "East" }));
    expect(onClarify).toHaveBeenCalledWith(request, { direction: "East" });
  });

  it("supports multi-select, progress, free text and skip", () => {
    const request = clarify([{ qid: "colors", question: "Colors?", choices: ["Red", "Blue"], multi_select: true }, { qid: "note", question: "Why?" }, { qid: "optional", question: "Anything else?" }]);
    const onClarify = vi.fn();
    render(<ClarifyCard request={request} onClarify={onClarify} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Red" })); fireEvent.click(screen.getByRole("checkbox", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Question 2 of 3")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "Readable" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" })); fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onClarify).toHaveBeenCalledWith(request, { colors: "Red, Blue", note: "Readable", optional: null });
  });

  it("submits free text and Other", () => {
    const onClarify = vi.fn();
    const request = clarify([{ qid: "q", question: "Choose", choices: ["Default", "Other"] }]);
    render(<ClarifyCard request={request} onClarify={onClarify} />);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Other" }), { target: { value: "Custom" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onClarify).toHaveBeenCalledWith(request, { q: "Custom" });
  });

  it("nests subagents, queues steer, opens tail and disables terminal controls", async () => {
    const state = events([
      ["subagent.start", { subagent_id: "parent", goal: "Research", model: "model-a" }],
      ["subagent.start", { subagent_id: "child", parent_id: "parent", goal: "Read sources" }],
      ["subagent.complete", { subagent_id: "child", status: "completed", summary: "Sources read" }],
    ]);
    const cb = callbacks();
    render(<NativeTranscript state={state} callbacks={cb} subagentTails={{ parent: "Tail content" }} />);
    const parent = screen.getByRole("region", { name: "Subagent: Research" });
    const child = within(parent).getByRole("region", { name: "Subagent: Read sources" });
    expect(within(child).getByRole("button", { name: "Interrupt" })).toBeDisabled();
    expect(within(child).getByRole("textbox")).toBeDisabled();
    fireEvent.change(within(parent).getAllByRole("textbox")[0], { target: { value: "Check dates" } });
    fireEvent.click(within(parent).getAllByRole("button", { name: "Queue steer" })[0]);
    await waitFor(() => expect(screen.getByText("Steer queued (not yet delivered)")).toBeInTheDocument());
    expect(cb.onSubagentSteer).toHaveBeenCalledWith("parent", "Check dates");
    fireEvent.click(within(parent).getAllByRole("button", { name: "Open tail" })[0]);
    expect(cb.onSubagentTail).toHaveBeenCalledWith("parent");
    expect(screen.getByText("Tail content")).toBeInTheDocument();
  });

  it("nests todos and renders usage fields", () => {
    const state = events([["todo.updated", { todos: [{ id: "p", content: "Ship", status: "in_progress" }, { id: "c", parent: "p", content: "Review", status: "completed" }] }], ["session.usage", { usage: { input: 10, output: 20, context_used: 50, context_max: 100, cost_usd: 0.02 } }]]);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks()} />);
    expect(container.querySelector('[data-todo-id="p"] [data-todo-id="c"]')).not.toBeNull();
    expect(screen.getByText("Tasks · 1/2 done")).toBeInTheDocument();
    expect(screen.getByText("10 tokens in / 20 out")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("value", "50");
    expect(screen.getByText("$0.0200")).toBeInTheDocument();
  });

  it.each([true, false])("only offers explicit retry for retryable=%s", retryable => {
    const cb = callbacks();
    const state = events([["message.complete", { status: "error", error: "Rate limited", partial: true, text: "Retained", error_surface: { layer: "provider", code: "429", retryable, resets_at: 1800000000 } }]]);
    render(<NativeTranscript state={state} callbacks={cb} />);
    expect(screen.getByText("Partial response retained")).toBeInTheDocument();
    if (retryable) { fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(cb.onRetry).toHaveBeenCalledOnce(); }
    else expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers a branch action for read-only automation", () => {
    const onBranch = vi.fn(); render(<ReadOnlyNotice source="cron" onBranch={onBranch} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue as new chat" }));
    expect(onBranch).toHaveBeenCalledOnce();
  });
});
