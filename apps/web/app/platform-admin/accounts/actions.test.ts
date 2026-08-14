import { beforeEach, describe, expect, it, vi } from "vitest";

const noStore = vi.fn();
const getSupabaseAdminClient = vi.fn();

vi.mock("next/cache", () => ({ unstable_noStore: noStore }));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));

type QueryResult = { data: unknown[]; error: null };

function query(result: QueryResult) {
  const builder = {
    select: vi.fn(),
    order: vi.fn(),
    in: vi.fn(),
    then: (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve),
  };
  builder.select.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  return builder;
}

describe("getAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads account joins in bounded URL-filter batches", async () => {
    const accountRows = Array.from({ length: 205 }, (_, index) => ({
      id: `account-${index + 1}`,
      name: `Recycler ${index + 1}`,
      role: "recycler",
      account_type: "organization",
      status: "active",
      created_at: "2026-08-14T00:00:00.000Z",
    }));
    const membershipRows = accountRows.map((account, index) => ({
      account_id: account.id,
      user_id: `user-${index + 1}`,
      is_primary: true,
      created_at: "2026-08-14T00:00:00.000Z",
    }));
    const userRows = membershipRows.map((membership) => ({
      id: membership.user_id,
      email: `${membership.user_id}@example.com`,
    }));

    const accountQuery = query({
      data: accountRows,
      error: null,
    });
    const publicProfileQuery = query({
      data: [{ account_id: "account-1", display_name: "Recycler One Ltd" }],
      error: null,
    });
    const privateProfileQuery = query({
      data: [{ account_id: "account-1", addresses_json: [{ city: "London" }] }],
      error: null,
    });
    const membershipQuery = query({
      data: membershipRows,
      error: null,
    });
    const userQuery = query({
      data: userRows,
      error: null,
    });

    const queries = new Map([
      ["accounts", accountQuery],
      ["account_profiles_public", publicProfileQuery],
      ["account_profiles_private", privateProfileQuery],
      ["account_memberships", membershipQuery],
      ["users", userQuery],
    ]);
    getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => queries.get(table)),
    });

    const { getAccounts } = await import("./actions");
    const accounts = await getAccounts();

    for (const builder of [publicProfileQuery, privateProfileQuery, membershipQuery, userQuery]) {
      expect(builder.in).toHaveBeenCalledTimes(3);
      for (const [, ids] of builder.in.mock.calls) {
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.length).toBeLessThanOrEqual(100);
      }
    }
    expect(accounts).toHaveLength(205);
    expect(accounts[0]).toEqual(expect.objectContaining({
      id: "account-1",
      display_name: "Recycler One Ltd",
      location: "London",
      email: "user-1@example.com",
    }));
  });
});
