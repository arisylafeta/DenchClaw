import { describe, expect, it } from "vitest";
import { noticeForRow } from "@/lib/hermes-chat/notice";

const envelope = "[ASYNC DELEGATION BATCH COMPLETE — deleg_1f478446]\nA background fan-out unit...\n\n--- ✓ TASK 1/1: Implement the buyer-context UI (status=completed, api_calls=47, 581.64s) ---\nDone.";
describe("noticeForRow", () => {
  it("uses Hermes' typed display_text for async delegation rows", () => {
    const notice = noticeForRow({ role: "user", displayKind: "async_delegation_complete", displayMetadata: JSON.stringify({ display_text: "Subagent Task Completed: Implement the buyer-context UI" }), text: envelope });
    expect(notice).toMatchObject({ kind: "delegation", text: "Subagent Task Completed: Implement the buyer-context UI" });
    expect(notice?.details).toBe(envelope);
  });
  it("recognises untyped legacy rows by prefix and builds a line from the task header", () => {
    expect(noticeForRow({ role: "user", text: envelope })).toMatchObject({ kind: "delegation", text: "Subagent task completed: Implement the buyer-context UI" });
  });
  it("covers the other typed kinds and shows steer text", () => {
    expect(noticeForRow({ role: "user", displayKind: "internal_notification", text: "x" })?.kind).toBe("notification");
    expect(noticeForRow({ role: "user", displayKind: "auto_continue", text: "go" })?.text).toBe("Hermes resumed an interrupted turn");
    expect(noticeForRow({ role: "user", displayKind: "steer", text: "use the new API" })?.text).toBe("Steered: use the new API");
    expect(noticeForRow({ role: "user", displayKind: "model_switch", text: "m" })?.kind).toBe("model");
  });
  it("never turns real user text or assistant rows into notices", () => {
    expect(noticeForRow({ role: "user", text: "please explain [ASYNC DELEGATION BATCH COMPLETE" })).toBeNull();
    expect(noticeForRow({ role: "assistant", displayKind: "steer", text: "x" })).toBeNull();
    expect(noticeForRow({ role: "user", displayKind: null, text: "hello" })).toBeNull();
  });
});
