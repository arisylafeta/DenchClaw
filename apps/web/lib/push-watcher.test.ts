import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/postgres", () => ({ queryPg: vi.fn() }));
vi.mock("@/lib/hermes-native", () => ({ listConversations: vi.fn() }));
vi.mock("@/lib/web-push", () => ({ sendPushToUser: vi.fn(), vapidConfig: () => null }));
import { pushFor } from "./push-watcher";

const was = { working: true, blocked: false };
const row = { key: "k%201", title: "Fix bug", profile: "devon", working: false, blocked: false, access: { ownerId: "u1" } };

describe("pushFor", () => {
  it("builds a finished push with a deep link to the chat", () => {
    expect(pushFor("u1", was, row)).toMatchObject({ kind: "done", title: "Fix bug", body: "Finished", tag: "agent-k%201", chat: "k%201", url: "/?chat=k%2520" + "1" });
  });
  it("builds a needs-input push", () => {
    expect(pushFor("u1", was, { ...row, working: true, blocked: true })).toMatchObject({ kind: "input", body: "Waiting for your input" });
  });
  it("never pushes another user's chat", () => {
    expect(pushFor("u2", was, row)).toBeNull();
    expect(pushFor("u2", was, { ...row, access: null })).toBeNull();
  });
  it("stays quiet without an edge", () => {
    expect(pushFor("u1", undefined, row)).toBeNull();
    expect(pushFor("u1", { working: false, blocked: false }, row)).toBeNull();
  });
});
