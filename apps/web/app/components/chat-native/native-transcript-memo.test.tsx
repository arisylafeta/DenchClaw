// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState, type ChatMessage, type ChatState } from "@/lib/hermes-chat/reducer";
import { NativeTranscript } from "./index";

const msg = (id: string, role: "user" | "assistant", text: string): ChatMessage => ({ id, role, startedAt: 1000, completedAt: 2000, pending: false, status: "complete",
  segments: [{ id: `${id}:t`, type: "text", text, startedAt: 1000, completedAt: 2000 }] } as ChatMessage);
const callbacks = () => ({ onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() });

describe("transcript turn memoization", () => {
  it("re-renders only the turn that changed, even with fresh inline callbacks and merged assistant rows", () => {
    const seen: string[] = [];
    const base = initialState("chat");
    const state = (messages: ChatMessage[]): ChatState => ({ ...base, messages });
    const rows = [msg("u1", "user", "ask one"), msg("a1", "assistant", "one"), msg("a1b", "assistant", "one more"), msg("u2", "user", "ask two"), msg("a2", "assistant", "two"), msg("u3", "user", "ask three"), msg("a3", "assistant", "three")];
    const view = (s: ChatState) => <NativeTranscript state={s} callbacks={callbacks()} renderMarkdown={(t) => { seen.push(t); return t; }} onOpenArtifact={() => undefined} onSendPrompt={() => undefined} userHtml={() => undefined} />;
    const { rerender, container } = render(view(state(rows)));
    expect(seen.length).toBeGreaterThanOrEqual(3);
    seen.length = 0;
    rerender(view(state(rows)));
    expect(seen).toEqual([]);
    rerender(view(state(rows.map(m => m.id === "a2" ? msg("a2", "assistant", "two!") : m))));
    expect(seen).toEqual(["two!"]);
    expect(container.querySelectorAll("article[data-settled='true']").length).toBeGreaterThan(3);
  });
});
