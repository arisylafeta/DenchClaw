import { describe, expect, it } from "vitest";
import { conversationTransition } from "./conversation-transitions";

describe("conversationTransition", () => {
  it("reports finished when a working chat goes idle", () => {
    expect(conversationTransition({ working: true, blocked: false }, { working: false, blocked: false })).toBe("done");
  });
  it("reports input when a chat becomes blocked", () => {
    expect(conversationTransition({ working: true, blocked: false }, { working: true, blocked: true })).toBe("input");
  });
  it("stays quiet on the first sighting, cron chats, unchanged and blocked-finish rows", () => {
    expect(conversationTransition(undefined, { working: false })).toBeNull();
    expect(conversationTransition({ working: true, blocked: false }, { working: false, source: "cron" })).toBeNull();
    expect(conversationTransition({ working: false, blocked: false }, { working: false, blocked: false })).toBeNull();
    expect(conversationTransition({ working: true, blocked: false }, { working: false, blocked: true })).toBe("input");
    expect(conversationTransition({ working: true, blocked: true }, { working: false, blocked: true })).toBeNull();
  });
});
