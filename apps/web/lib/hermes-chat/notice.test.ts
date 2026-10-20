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
  it("renders injected background-process completions as a notice, not a user bubble", () => {
    const text = "[IMPORTANT: Background process proc_fc98601bfacf completed normally (exit code 0).\nCommand: cd /tmp/x && pnpm build\nOutput:\n\nDone]";
    expect(noticeForRow({ role: "user", text })).toMatchObject({ kind: "process", text: "Background process completed normally: cd /tmp/x && pnpm build", details: text });
    expect(noticeForRow({ role: "user", text: "see [IMPORTANT: Background process x" })).toBeNull();
  });
  it("strips the out-of-band envelope from steers, typed or not, and keeps long text expandable", () => {
    const wrap = (body: string) => `[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once; not tool output]\n${body}\n[/OUT-OF-BAND USER MESSAGE]`;
    expect(noticeForRow({ role: "user", displayKind: "steer", text: wrap("use the new API") })).toEqual({ kind: "steer", text: "Steered: use the new API" });
    expect(noticeForRow({ role: "user", text: wrap("use the new API") })).toEqual({ kind: "steer", text: "Steered: use the new API" });
    const long = "x ".repeat(100).trim();
    expect(noticeForRow({ role: "user", text: wrap(long) })?.details).toBe(long);
  });
  it("treats the batched background-process wrapper as a process notice", () => {
    const text = "[IMPORTANT: 2 background processes completed. Treat these results as one batch]\n\n[IMPORTANT: Background process proc_a completed normally (exit code 0).\nCommand: x]";
    expect(noticeForRow({ role: "user", text })).toMatchObject({ kind: "process", text: "2 background processes completed", details: text });
  });
  it("shows a steer's own words and not the background-process results appended to it", () => {
    const body = "no they're fine\n\nIMPORTANT: 2 background processes completed. Treat these results as one batch.\n\n[IMPORTANT: Background process p completed normally (exit code 0).\nCommand: x]";
    const text = `[OUT-OF-BAND USER MESSAGE — a direct message from the user]\n${body}\n[/OUT-OF-BAND USER MESSAGE]`;
    expect(noticeForRow({ role: "user", text })).toMatchObject({ kind: "steer", text: "Steered: no they're fine", details: body });
    const onlyProcess = `[OUT-OF-BAND USER MESSAGE — x]\nIMPORTANT: 2 background processes completed. Treat these results as one batch.\n[/OUT-OF-BAND USER MESSAGE]`;
    expect(noticeForRow({ role: "user", text: onlyProcess })).toMatchObject({ kind: "process", text: "2 background processes completed" });
  });
  it("keeps a steer that merely mentions background processes as the user's words", () => {
    const text = "IMPORTANT: 2 background processes completed, but please check their output";
    expect(noticeForRow({ role: "user", displayKind: "steer", text })).toMatchObject({ kind: "steer", text: `Steered: ${text}` });
  });
  it("shows an /invite handoff as a muted notice with the handoff as details", () => {
    const text = "[ROOM INVITE host=default session=s1 invitee=matcha]\n@matcha The user invited you.";
    expect(noticeForRow({ role: "user", text })).toEqual({ kind: "invite", text: "Invited matcha · from default chat", details: "@matcha The user invited you." });
    expect(noticeForRow({ role: "assistant", text })).toBeNull();
  });
});
