// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { describeError } from "@/lib/hermes-chat/error-copy";
import { eventNotice } from "@/lib/hermes-chat/event-notices";
import { stateFromSnapshot, type GatewayChatSnapshot } from "@/lib/hermes-chat/snapshot";
import { NativeTranscript } from "./index";

const ctx = { now: () => 1000, id: () => "id" };
const callbacks = { onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() };
const snapshot = (messages: GatewayChatSnapshot["messages"]): GatewayChatSnapshot => ({ key: "k", conversation: { id: "s", profile: "p", title: "", working: false }, messages, running: false, pendingRequests: [], generation: 1, seq: 1 });

describe("error copy", () => {
  it("turns Hermes surfaces and raw strings into plain language, keeping the raw text as detail", () => {
    expect(describeError("content_policy_blocked: model declined (content_filter)", { layer: "provider", code: "content_policy_blocked", retryable: false, provider: "anthropic" }))
      .toMatchObject({ title: "Anthropic declined this request", detail: expect.stringContaining("content_filter") });
    expect(describeError("Error code: 429 - rate limit").title).toBe("The model is rate limiting requests");
    expect(describeError("Gateway disconnected. Reconnect before sending another message. gateway_unavailable").title).toBe("Lost connection to Hermes");
    expect(describeError("Traceback (most recent call last):\n  File x\nValueError: bad")).toEqual({ title: "Traceback (most recent call last):", detail: "Traceback (most recent call last):\n  File x\nValueError: bad" });
    expect(describeError(undefined).title).toBe("Something went wrong");
  });

  it("does not announce auto titles in the transcript", () => {
    expect(eventNotice({ type: "session.title", payload: { title: "20261021_181644_fefc33 please read this trace" } as never })).toBeNull();
  });

  it("renders a persisted failed turn as an error card, not as assistant prose", () => {
    const state = stateFromSnapshot(snapshot([
      { id: "1", role: "user", text: "Do the thing" },
      { id: "2", role: "assistant", displayKind: "failed_turn", text: "Your request was not processed. Send it again if you still want me to carry it out.",
        displayMetadata: JSON.stringify({ error: "content_policy_blocked: model declined (content_filter)", error_surface: { layer: "provider", code: "content_policy_blocked", retryable: false, provider: "anthropic" } }) },
    ]), ctx);
    const { container } = render(<NativeTranscript state={state} callbacks={callbacks} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Anthropic declined this request");
    expect(container.querySelector(".chat-prose")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers retry only on the latest failed turn", () => {
    const failed = (id: string) => ({ id, role: "assistant", displayKind: "failed_turn", text: "Failed", displayMetadata: { error: "timeout", error_surface: { layer: "provider", code: "timeout", retryable: true } } });
    const state = stateFromSnapshot(snapshot([{ id: "1", role: "user", text: "a" }, failed("2"), { id: "3", role: "user", text: "b" }, failed("4")]), ctx);
    render(<NativeTranscript state={state} callbacks={callbacks} />);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });
});
