import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());
vi.mock("../postgres", () => ({ queryPg }));

describe("per-user CRM isolation", () => {
  beforeEach(() => {
    queryPg.mockReset();
    queryPg.mockResolvedValue([]);
  });

  it("scopes inbox lists and counts to the authenticated mailbox", async () => {
    const { getPostgresInbox } = await import("./inbox");
    const result = await getPostgresInbox(
      {
        search: "quote",
        senderFilter: "all",
        personId: null,
        limit: 50,
        offset: 0,
      },
      "11111111-1111-4111-8111-111111111111",
    );

    expect(result.threads).toEqual([]);
    const [sql, params] = queryPg.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("t.mailbox_owner_id = $5::uuid");
    expect(sql).toContain("m.mailbox_owner_id = $5::uuid");
    expect(params[4]).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("denies cross-mailbox thread detail by applying owner predicates", async () => {
    const { getPostgresInboxThread } = await import("./inbox-thread");
    const result = await getPostgresInboxThread(
      "alex-thread",
      "22222222-2222-4222-8222-222222222222",
    );

    expect(result).toBeNull();
    const [sql, params] = queryPg.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("m.mailbox_owner_id = $2::uuid");
    expect(sql).toContain("t.mailbox_owner_id = $2::uuid");
    expect(params).toEqual([
      "alex-thread",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });
});
