import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/postgres", () => ({ queryPg: vi.fn() }));
const nativeFetch = vi.fn();
vi.mock("@/lib/hermes-native", () => ({ listConversations: vi.fn(), nativeFetch: (...a: unknown[]) => nativeFetch(...a) }));
vi.mock("@/lib/web-push", () => ({ sendPushToUser: vi.fn(), vapidConfig: () => null }));
import { lastTurnSummary, pushFor } from "./push-watcher";
import { conversationKey } from "./hermes-conversations";

const was = { working: true, blocked: false, background: false };
const row = { key: "k%201", title: "Fix bug", profile: "devon", working: false, blocked: false, background: false, access: { ownerId: "u1" } };

describe("pushFor", () => {
  it("builds a finished push with a deep link to the chat", () => {
    expect(pushFor("u1", was, row)).toMatchObject({ kind: "done", title: "Fix bug", body: "Finished", tag: "agent-k%201", chat: "k%201", url: "/?chat=k%2520" + "1" });
  });
  it("builds a needs-input push", () => {
    expect(pushFor("u1", was, { ...row, working: true, blocked: true })).toMatchObject({ kind: "input", body: "Waiting for your input" });
  });
  it("puts the last-turn summary in the body", () => {
    expect(pushFor("u1", was, row, "Fixed the mic bug.")).toMatchObject({ kind: "done", body: "Fixed the mic bug." });
  });
  it("stays silent when a turn ends with subagents still working, then reports them", () => {
    expect(pushFor("u1", was, { ...row, background: true })).toBeNull();
    expect(pushFor("u1", { working: false, blocked: false, background: true }, row, "All three checks pass.")).toMatchObject({ kind: "done", body: "Subagents finished: All three checks pass." });
  });
  it("never pushes another user's chat", () => {
    expect(pushFor("u2", was, row)).toBeNull();
    expect(pushFor("u2", was, { ...row, access: null })).toBeNull();
  });
  it("stays quiet without an edge", () => {
    expect(pushFor("u1", undefined, row)).toBeNull();
    expect(pushFor("u1", { working: false, blocked: false, background: false }, row)).toBeNull();
  });
});

describe("lastTurnSummary", () => {
  const page = (data: unknown[]) => nativeFetch.mockResolvedValue({ json: async () => ({ data }) });
  it("summarises the last assistant reply of the turn, skipping tool rows", async () => {
    page([{ role: "user", content: "go" }, { role: "assistant", content: "Older." }, { role: "tool", content: "x" }, { role: "assistant", content: "**All done.** Tests pass." }]);
    expect(await lastTurnSummary(conversationKey("solo", "s1", "devon"))).toBe("All done. Tests pass.");
  });
  it("does not reach back past the user message into an earlier turn", async () => {
    page([{ role: "assistant", content: "Earlier turn." }, { role: "user", content: "again" }]);
    expect(await lastTurnSummary(conversationKey("solo", "s1", "devon"))).toBe("");
  });
  it("is empty for groups and on read errors", async () => {
    expect(await lastTurnSummary(conversationKey("group", "r1"))).toBe("");
    nativeFetch.mockRejectedValue(new Error("down"));
    expect(await lastTurnSummary(conversationKey("solo", "s1", "devon"))).toBe("");
  });
});
