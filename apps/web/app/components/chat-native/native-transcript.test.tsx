// @vitest-environment jsdom
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState, reduce, type ChatState } from "@/lib/hermes-chat/reducer";
import type { GatewayEvent } from "@/lib/hermes-chat/events";
import { NativeTranscript, ApprovalCard, ClarifyCard, PromptDock, ReadOnlyNotice } from "./index";
import type { NativeTranscriptCallbacks } from "./types";
import { stateFromSnapshot, type GatewayChatSnapshot } from "@/lib/hermes-chat/snapshot";

let id = 0;
function events(frames: Array<[string, GatewayEvent["payload"], (string | number)?]>, base = initialState("chat")): ChatState {
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
  it("streams exposed reasoning as muted plain text, separate from tools and the final answer", async () => {
    const cb = callbacks();
    let state = events([["message.start", {}], ["thinking.delta", { text: "Status only" }]]);
    const { container, rerender } = render(<NativeTranscript state={state} callbacks={cb} />);
    expect(screen.queryByText("Status only")).toBeNull();
    state = events([["reasoning.delta", { text: "Check the schema.\n" }]], state);
    rerender(<NativeTranscript state={state} callbacks={cb} />);
    const text = screen.getByText("Check the schema.");
    expect(text.parentElement).toHaveClass("text-[12px]", "text-[var(--color-text-muted)]");
    expect(text).toHaveClass("whitespace-pre-wrap", "[overflow-wrap:anywhere]");
    state = events([["reasoning.delta", { text: "Then compare callers. <script>not executable</script>" }]], state);
    rerender(<NativeTranscript state={state} callbacks={cb} />);
    expect(text.textContent).toBe("Check the schema.\nThen compare callers. <script>not executable</script>");
    expect(container.querySelector("script")).toBeNull();
    state = events([
      ["tool.start", { tool_id: "read", name: "read_file", args: { path: "schema.sql" } }],
      ["tool.complete", { tool_id: "read", name: "read_file", result: "ok" }],
      ["message.delta", { text: "The final answer." }],
      ["message.complete", { text: "The final answer.", status: "complete" }],
    ], state);
    rerender(<NativeTranscript state={state} callbacks={cb} />);
    const work = container.querySelector<HTMLDetailsElement>('[data-segment="work"]')!;
    expect(work).not.toHaveAttribute("open");
    expect(within(work).getByText("Read schema.sql")).toBeInTheDocument();
    expect(work.querySelectorAll('[data-segment="reasoning"]')).toHaveLength(1);
    expect(work).not.toContainElement(screen.getByText("The final answer."));
    fireEvent.click(work.querySelector("summary")!);
    await waitFor(() => expect(work).toHaveAttribute("open"));
    expect(text).toBeVisible();
  });

  it("retains non-empty reasoning from history with zero-duration timestamps", async () => {
    const snapshot: GatewayChatSnapshot = {
      key: "test", conversation: { id: "test", profile: "test", title: "Test", working: false },
      messages: [{ id: "1", role: "assistant", timestamp: 1000, parts: [
        { type: "reasoning", text: "A stored reasoning summary." },
        { type: "text", text: "Stored answer." },
      ] }], running: false, pendingRequests: [], generation: 1, seq: 1,
    };
    const state = stateFromSnapshot(snapshot, { now: () => 2000, id: () => "id" });
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks()} />);
    const work = container.querySelector<HTMLDetailsElement>('[data-segment="work"]')!;
    expect(work).not.toHaveAttribute("open");
    fireEvent.click(work.querySelector("summary")!);
    await waitFor(() => expect(screen.getByText("A stored reasoning summary.")).toBeVisible());
    expect(work).not.toContainElement(screen.getByText("Stored answer."));
  });

  it("does not invent reasoning when the provider supplies only an answer", () => {
    const state = events([["message.start", {}], ["thinking.delta", { text: "Status only" }],
      ["message.delta", { text: "Just an answer." }], ["message.complete", { text: "Just an answer." }]]);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks()} />);
    expect(screen.getByText("Just an answer.")).toBeInTheDocument();
    expect(container.querySelector('[data-segment="reasoning"]')).toBeNull();
    expect(screen.queryByText("Status only")).toBeNull();
  });
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
    expect([...container.querySelectorAll("[data-segment]")].map(node => node.getAttribute("data-segment"))).toEqual(["interim", "work", "reasoning", "interim"]);
    expect(screen.getByText("Read README")).toBeInTheDocument();
    expect(screen.getByText("Ran a quick command")).toBeInTheDocument();
    expect(screen.queryByText(/pwd/)).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-tool-id]")).toHaveLength(2);
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("CRM")).not.toHaveAttribute("onclick");
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps finished prose visible between folded chronological tool blocks", () => {
    const state = events([
      ["client.submit", { text: "Why?", id: "u" }],
      ["message.start", {}],
      ["message.delta", { text: "Let me check the schema." }],
      ["tool.start", { tool_id: "a", name: "read_file", args: { path: "/x/schema.sql" } }],
      ["tool.complete", { tool_id: "a", name: "read_file", result: { content: "1|create table x" }, duration_s: 1 }],
      ["message.delta", { text: "Now the callers." }],
      ["tool.start", { tool_id: "b", name: "terminal", args: { command: "git status" } }],
      ["tool.complete", { tool_id: "b", name: "terminal", result: { output: "clean", exit_code: 0 } }],
      ["message.delta", { text: "Final answer text." }],
      ["message.complete", { text: "Final answer text.", status: "complete" }],
    ]);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks()} />);
    const work = container.querySelectorAll('[data-segment="work"]');
    expect(work).toHaveLength(2);
    expect(work[0]).not.toHaveAttribute("open");
    expect(within(work[0] as HTMLElement).getByText(/^Thought/)).toBeInTheDocument();
    expect(within(work[0] as HTMLElement).queryByText(/steps?$/)).toBeNull();
    expect(container.querySelectorAll("[data-tool-id]")).toHaveLength(2);
    expect(screen.getByText("Let me check the schema.")).toBeVisible();
    expect(screen.getByText("Now the callers.")).toBeVisible();
    expect(work[0]).not.toContainElement(screen.getByText("Let me check the schema."));
    expect(within(work[0] as HTMLElement).queryByText("Final answer text.")).toBeNull();
    expect(screen.getByText("Final answer text.")).toBeInTheDocument();
    // The answer is rendered after the folded work, with no stray empty blocks between tool calls.
    const answer = screen.getByText("Final answer text.");
    expect(work[1].compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("updates a running tool to done and collapses completed reasoning", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(5000);
    const live = events([["message.start", {}], ["reasoning.delta", { text: "Plan" }]]);
    const cb = callbacks();
    const { container, rerender } = render(<NativeTranscript state={live} callbacks={cb} />);
    clock.mockRestore();
    expect(container.querySelector('[data-segment="work"]')).toHaveAttribute("open");
    expect(screen.getByText(/^Thinking/)).toHaveTextContent(/^Thinking \d+s$/);
    const running = events([["tool.start", { tool_id: "t", name: "terminal", args: { command: "pwd" } }]], live);
    rerender(<NativeTranscript state={running} callbacks={cb} />);
    expect(screen.getByText("Running a quick command")).toBeInTheDocument();
    expect(screen.queryByText(/pwd/)).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-tool-id]")).toHaveLength(1);
    const done = events([["tool.complete", { tool_id: "t", name: "terminal", result: { exit_code: 0 }, duration_s: 2 }]], running);
    rerender(<NativeTranscript state={done} callbacks={cb} />);
    expect(screen.queryByText("Running a quick command")).not.toBeInTheDocument();
    expect(screen.getByText("Ran a quick command")).toBeInTheDocument();
    expect(screen.getByText("2s")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-tool-id]")).toHaveLength(1);
  });

  it("keeps tool errors folded away and only marks the step and the header as failed", () => {
    const state = events([["tool.complete", { tool_id: "edit", name: "edit_file", inline_diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+extra", result: { error: "Permission denied" } }]]);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks()} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    const step = container.querySelector("[data-tool-id] details") as HTMLDetailsElement;
    expect(step.open).toBe(false);
    expect(step.textContent).toContain("Permission denied");
    const work = container.querySelector('[data-segment="work"]') as HTMLDetailsElement;
    expect(work.dataset.failed).toBe("true");
    expect(work.querySelector("summary")?.className).toContain("text-[var(--color-error)]");
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

  it("drops a withdrawn approval from the dock so nothing actionable is left", () => {
    const state = events([["approval.request", { command: "danger" }, "srq-1"]]);
    const cb = callbacks();
    const { container, rerender } = render(<PromptDock state={state} subagents={state.subagents} callbacks={cb} />);
    expect(screen.getByRole("button", { name: "Run once" })).toBeInTheDocument();
    rerender(<PromptDock state={events([["request.cancel", { id: "srq-1" }]], state)} subagents={state.subagents} callbacks={cb} />);
    expect(screen.queryByRole("button", { name: "Run once" })).not.toBeInTheDocument();
    expect(container.querySelector("[data-prompt-dock]")).toBeNull();
  });

  it("answers the four-option question with one click", () => {
    const request = clarify([{ qid: "direction", question: "Which route?", choices: ["North", "East", "South", "West"] }]);
    const onClarify = vi.fn();
    render(<ClarifyCard request={request} onClarify={onClarify} />);
    fireEvent.click(screen.getByRole("radio", { name: /East/ }));
    expect(onClarify).toHaveBeenCalledWith(request, { direction: "East" });
  });

  it("supports multi-select, progress, free text and skip", () => {
    const request = clarify([{ qid: "colors", question: "Colors?", choices: ["Red", "Blue"], multi_select: true }, { qid: "note", question: "Why?" }, { qid: "optional", question: "Anything else?" }]);
    const onClarify = vi.fn();
    render(<ClarifyCard request={request} onClarify={onClarify} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Red/ })); fireEvent.click(screen.getByRole("checkbox", { name: /Blue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "Readable" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" })); fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onClarify).toHaveBeenCalledWith(request, { colors: "Red, Blue", note: "Readable", optional: null });
  });

  it("submits free text and Other", () => {
    const onClarify = vi.fn();
    const request = clarify([{ qid: "q", question: "Choose", choices: ["Default", "Other"] }]);
    render(<ClarifyCard request={request} onClarify={onClarify} />);
    fireEvent.click(screen.getByRole("radio", { name: /Other/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Other" }), { target: { value: "Custom" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Other" }), { key: "Enter" });
    expect(onClarify).toHaveBeenCalledWith(request, { q: "Custom" });
  });

  it("nests subagents, queues steer, opens tail and disables terminal controls", async () => {
    const state = events([
      ["subagent.start", { subagent_id: "parent", goal: "Research", model: "model-a" }],
      ["subagent.start", { subagent_id: "child", parent_id: "parent", goal: "Read sources" }],
      ["subagent.complete", { subagent_id: "child", status: "completed", summary: "Sources read" }],
    ]);
    const cb = callbacks();
    render(<PromptDock state={state} subagents={state.subagents} callbacks={cb} tails={{ parent: "Tail content" }} />);
    const parent = screen.getByRole("region", { name: "Subagent: Research" });
    const child = within(parent).getByRole("region", { name: "Subagent: Read sources" });
    expect(within(child).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(child).queryByRole("button", { name: "Steer" })).toBeNull();
    expect(within(child).getByText("Sources read")).toBeInTheDocument();
    fireEvent.click(within(parent).getAllByRole("button", { name: "Steer" })[0]);
    fireEvent.change(within(parent).getByRole("textbox", { name: "Steer subagent" }), { target: { value: "Check dates" } });
    fireEvent.click(within(parent).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("Steer queued, not yet delivered")).toBeInTheDocument());
    expect(cb.onSubagentSteer).toHaveBeenCalledWith("parent", "Check dates");
    fireEvent.click(within(parent).getAllByRole("button", { name: "View output" })[0]);
    expect(cb.onSubagentTail).toHaveBeenCalledWith("parent");
    await waitFor(() => expect(within(parent).getAllByRole("button", { name: "Stop" })[0]).toBeEnabled());
    fireEvent.click(within(parent).getAllByRole("button", { name: "Stop" })[0]);
    expect(cb.onSubagentInterrupt).toHaveBeenCalledWith("parent");
    expect(screen.getByText("Tail content")).toBeInTheDocument();
  });

  it("opens a finished tool's result preview as an accordion, and offers none while running", () => {
    const running = events([["tool.start", { tool_id: "r", name: "read_file", args: { path: "/a/plan.md" } }]]);
    const { container, rerender } = render(<NativeTranscript state={running} callbacks={callbacks()} />);
    expect(container.querySelector("[data-tool-id] details")).toBeNull();
    const done = events([["tool.complete", { tool_id: "r", name: "read_file", result: { content: "1|first line\n2|second line" } }]], running);
    rerender(<NativeTranscript state={done} callbacks={callbacks()} />);
    const details = container.querySelector("[data-tool-id] details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getByText("Read plan.md")).toBeInTheDocument();
    expect(within(details).getByText("2|second line")).toBeInTheDocument();
    expect(within(details).getByText("2 lines")).toBeInTheDocument();
    expect(container.querySelector('[data-preview="code"]')).not.toBeNull();
  });

  it("nests todos and never shows token or context usage in the transcript", () => {
    const state = events([["todo.updated", { todos: [{ id: "p", content: "Ship", status: "in_progress" }, { id: "c", parent: "p", content: "Review", status: "completed" }] }], ["session.usage", { usage: { input: 10, output: 20, context_used: 50, context_max: 100, cost_usd: 0.02 } }]]);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks()} />);
    expect(container.querySelector('[data-todo-id="p"] [data-todo-id="c"]')).not.toBeNull();
    expect(screen.getByText("Tasks · 1/2 done")).toBeInTheDocument();
    expect(screen.queryByText(/tokens in/)).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByText("$0.0200")).toBeNull();
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

describe("durable history shape", () => {
  it("shows N consecutive assistant rows from Hermes (one per tool round) as one turn with one work block", () => {
    const row = (id: string, role: string, parts: Record<string, unknown>[], timestamp: number) => ({ id, role, text: "", content: "", parts, timestamp });
    const snapshot = {
      key: "k", conversation: { id: "s", profile: "p", title: "T", working: false }, generation: 1, seq: 0, running: false, pendingRequests: [], html: [],
      messages: [
        row("1", "user", [{ type: "text", text: "Why?" }], 1_000_000),
        row("2", "assistant", [{ type: "tool-invocation", toolCallId: "a", toolName: "read_file", args: { path: "/x/a.ts" }, result: "ok" }], 1_020_000),
        row("3", "assistant", [{ type: "reasoning", text: "hmm" }, { type: "tool-invocation", toolCallId: "b", toolName: "terminal", args: { command: "git status" }, result: "clean" }], 1_050_000),
        row("4", "assistant", [{ type: "text", text: "Because of X." }], 1_090_000),
      ],
    } as unknown as GatewayChatSnapshot;
    const state = stateFromSnapshot(snapshot, { now: () => 0, id: () => "x" });
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks()} />);
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(container.querySelectorAll('[data-segment="work"]')).toHaveLength(1);
    expect(container.querySelectorAll("[data-tool-id]")).toHaveLength(2);
    expect(screen.getByText("Thought for 90s")).toBeInTheDocument(); // prompt sent at 1000s, answer row at 1090s
    expect(screen.getByText("Because of X.")).toBeInTheDocument();
  });
});

describe("emoji", () => {
  it("strips emoji from narration lines and status text", async () => {
    const { stripEmoji } = await import("./work-block");
    expect(stripEmoji("🔍 Searching the web… 🚀")).toBe("Searching the web…");
    expect(stripEmoji("Done ✅ 👍🏽 ok")).toBe("Done ok");
    expect(stripEmoji("Plain text 1.")).toBe("Plain text 1.");
  });
});

describe("dock", () => {
  it("keeps questions and subagents out of the transcript and answers with number keys", () => {
    const state = events([["subagent.start", { subagent_id: "s", goal: "Research" }], ["clarify.request", { questions: [{ qid: "q", question: "Which route?", choices: ["North", "East", "South", "West"] }] }, "srq-9"]]);
    const cb = callbacks();
    const transcript = render(<NativeTranscript state={state} callbacks={cb} />);
    expect(transcript.container.querySelector('[aria-label="Clarification"]')).toBeNull();
    expect(transcript.container.querySelector("[data-subagent-id]")).toBeNull();
    transcript.unmount();
    render(<PromptDock state={state} subagents={state.subagents} callbacks={cb} />);
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "3" });
    expect(cb.onClarify).toHaveBeenCalledWith(state.pendingRequests[0], { q: "South" });
    expect(screen.getByLabelText("Subagents")).toBeInTheDocument();
  });
});

describe("subagent group", () => {
  it("summarises many subagents on one closed line, with one closed accordion each and no activity trace", () => {
    const state = events([
      ["subagent.start", { subagent_id: "a", goal: "Research prices" }], ["subagent.tool", { subagent_id: "a", tool_name: "web_search", tool_preview: "battery" }],
      ["subagent.start", { subagent_id: "b", goal: "Review plan" }], ["subagent.complete", { subagent_id: "b", status: "completed", summary: "Looks fine" }],
    ]);
    const { container } = render(<PromptDock state={state} subagents={state.subagents} callbacks={callbacks()} />);
    const group = container.querySelector('details[aria-label="Subagents"]') as HTMLDetailsElement;
    expect(group.open).toBe(false);
    expect(within(group).getByText("1 subagent running · 1 done")).toBeInTheDocument();
    const rows = group.querySelectorAll("details.group\\/agent");
    expect(rows).toHaveLength(2);
    rows.forEach(row => expect((row as HTMLDetailsElement).open).toBe(false));
    expect(group.querySelector('[aria-label="Recent activity"]')).toBeNull();
  });
});

describe("artifact blocks in native answers", () => {
  const block = '```artifact\n{"kind":"mail_draft","id":"nat1"}\n```';
  const draft = { id: "nat1", state: "draft", subject: "Native draft", to_emails: ["a@example.test"], cc_emails: [], bcc_emails: [], from_email: "ari@example.test", body_text: "Hello there", body_html: null, links: [], warnings: [], approval: null };
  it("renders a draft card instead of a code block and opens it from the card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(draft))));
    const open = vi.fn();
    const state = events([["message.start", {}], ["message.delta", { text: `Saved.\n\n${block}` }], ["message.complete", { text: `Saved.\n\n${block}` }]]);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks()} onOpenArtifact={open} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open email draft: Native draft" }));
    expect(open).toHaveBeenCalledWith("~mail/draft/nat1", { title: "Native draft" });
    expect(container.querySelector("pre")).toBeNull();
    vi.unstubAllGlobals();
  });
});

