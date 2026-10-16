import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../postgres", () => ({ queryPg: vi.fn(async () => []) }));
import { queryPg } from "../postgres";
import { lookupMessageHtml, messageTextHash, saveMessageHtml } from "./message-html-store";
beforeEach(() => vi.clearAllMocks());
it("uses normalized text identity and parameterized session-scoped persistence", async () => {
  expect(messageTextHash("same\n text")).toBe(messageTextHash(" same text "));
  expect(messageTextHash("other")).not.toBe(messageTextHash("same text"));
  await saveMessageHtml("ari", "session'", "client", "same text", "<b>same text</b>");
  const [sql, values] = vi.mocked(queryPg).mock.calls[0];
  expect(sql).toContain("on conflict (profile, stored_session_id, client_message_id)");
  expect(sql).not.toContain("session'");
  expect(values).toEqual(["ari", "session'", "client", messageTextHash("same text"), "<b>same text</b>"]);
  await lookupMessageHtml("alex", "other");
  expect(vi.mocked(queryPg).mock.calls[1]).toEqual([expect.stringContaining("order by created_at, client_message_id"), ["alex", "other"]]);
});
