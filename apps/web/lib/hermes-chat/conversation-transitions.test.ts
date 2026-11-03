import { describe, expect, it } from "vitest";
import { conversationTransition } from "./conversation-transitions";

const idle = { working: false, blocked: false, background: false };
describe("conversationTransition", () => {
  it("reports finished when a working chat goes idle", () => {
    expect(conversationTransition({ ...idle, working: true }, { working: false, blocked: false, background: false })).toBe("done");
  });
  it("treats a turn that ends with subagents still running as a silent handoff", () => {
    expect(conversationTransition({ ...idle, working: true }, { working: false, blocked: false, background: true })).toBeNull();
  });
  it("reports subagents finished once the background work ends", () => {
    expect(conversationTransition({ ...idle, background: true }, { working: false, blocked: false, background: false })).toBe("subagents");
  });
  it("stays quiet when the parent resumes after its subagents finish", () => {
    expect(conversationTransition({ ...idle, background: true }, { working: true, blocked: false, background: false })).toBeNull();
  });
  it("does not report subagents finished when the status is unknown", () => {
    expect(conversationTransition({ ...idle, background: true }, { working: false, blocked: false, background: null })).toBeNull();
  });
  it("reports input when a chat becomes blocked", () => {
    expect(conversationTransition({ ...idle, working: true }, { working: true, blocked: true, background: false })).toBe("input");
  });
  it("stays quiet on the first sighting, cron chats and unchanged rows", () => {
    expect(conversationTransition(undefined, { working: false })).toBeNull();
    expect(conversationTransition({ ...idle, working: true }, { working: false, source: "cron" })).toBeNull();
    expect(conversationTransition(idle, { working: false, blocked: false, background: false })).toBeNull();
    expect(conversationTransition({ ...idle, working: true, blocked: true }, { working: false, blocked: true, background: false })).toBeNull();
  });
});
