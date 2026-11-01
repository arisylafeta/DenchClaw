// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesConversation } from "../hermes-conversations";

const show = vi.fn();
vi.mock("../agent-notify", () => ({ appIsBackgrounded: () => true, showAgentNotification: (n: unknown) => show(n) }));
import { useConversationNotifications } from "./use-conversation-notifications";

const row = (over: Partial<HermesConversation>): HermesConversation => ({
  key: "k1", kind: "solo", id: "s1", profile: "devon", title: "Fix mic", updatedAt: 1, participants: [], working: false, blocked: false, ...over,
});

describe("useConversationNotifications", () => {
  beforeEach(() => show.mockClear());
  it("baselines the first listing, then notifies on finish and on waiting for input", () => {
    const { rerender } = renderHook(({ rows }) => useConversationNotifications(rows, undefined), { initialProps: { rows: [row({ working: true })] } });
    expect(show).not.toHaveBeenCalled();
    rerender({ rows: [row({ working: false })] });
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: "done", title: "Fix mic" }));
    rerender({ rows: [row({ working: true })] });
    rerender({ rows: [row({ working: true, blocked: true })] });
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "input", body: "Waiting for your input" }));
  });
  it("ignores cron chats and unknown status", () => {
    const { rerender } = renderHook(({ rows }) => useConversationNotifications(rows, undefined), { initialProps: { rows: [row({ working: true, source: "cron" }), row({ key: "k2", working: true })] } });
    rerender({ rows: [row({ working: false, source: "cron" }), row({ key: "k2", working: null })] });
    expect(show).not.toHaveBeenCalled();
  });
});
