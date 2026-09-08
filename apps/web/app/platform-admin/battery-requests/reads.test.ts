import { beforeEach, describe, expect, it, vi } from "vitest";
const { currentUser, getSupabaseAdminClient } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
}));
vi.mock("next/cache", () => ({ unstable_noStore: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  currentUser,
  ALLOWED_EMAILS: new Set(["ari@rebattery.io", "alex@rebattery.io"]),
}));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));
import { getBatteryRequests } from "./reads";
function client(results: Array<{ data: unknown[] | null; count: number | null; error: unknown }>) {
  let index = 0;
  const query = {
    select: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    ilike: vi.fn(),
    // Supabase query builders intentionally implement PromiseLike.
    // oxlint-disable-next-line unicorn/no-thenable
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(results[Math.min(index++, results.length - 1)]).then(resolve, reject),
  };
  for (const method of ["select", "order", "range", "ilike"] as const) {
    query[method].mockReturnValue(query);
  }
  const from = vi.fn(() => query);
  getSupabaseAdminClient.mockReturnValue({ from });
  return { query, from };
}
beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ email: "ari@rebattery.io" });
});
describe("battery request reads", () => {
  it.each([null, { email: "someone@example.test" }])(
    "denies unauthorized access: %j",
    async (user) => {
      currentUser.mockResolvedValue(user);
      await expect(getBatteryRequests()).rejects.toThrow("Unauthorized");
      expect(getSupabaseAdminClient).not.toHaveBeenCalled();
    },
  );
  it("selects only request fields with bounded deterministic pagination", async () => {
    currentUser.mockResolvedValue({ email: "alex@rebattery.io" });
    const { query, from } = client([{ data: [{ id: "synthetic" }], count: 51, error: null }]);
    expect(
      await getBatteryRequests({ page: "2", email: " test_100%@example.test " }),
    ).toMatchObject({ page: 2, totalPages: 3, totalCount: 51 });
    expect(from).toHaveBeenCalledExactlyOnceWith("battery_requests");
    expect(query.select).toHaveBeenCalledWith(
      "id, contact_email, intent, request_json, created_at",
      { count: "exact" },
    );
    expect(query.order.mock.calls).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(query.range).toHaveBeenCalledWith(25, 49);
    expect(query.ilike).toHaveBeenCalledWith("contact_email", "%test\\_100\\%@example.test%");
  });
  it("refetches the last real page for an out-of-range bookmark", async () => {
    const { query } = client([
      { data: [], count: 26, error: null },
      { data: [{ id: "last" }], count: 26, error: null },
    ]);
    expect(await getBatteryRequests({ page: "999" })).toMatchObject({
      page: 2,
      rows: [{ id: "last" }],
    });
    expect(query.range.mock.calls).toEqual([
      [24950, 24974],
      [25, 49],
    ]);
  });
  it.each(["NaN", "Infinity", "-4", "1.5"])(
    "handles invalid page %s and empty data",
    async (page) => {
      const { query } = client([{ data: [], count: 0, error: null }]);
      expect(await getBatteryRequests({ page })).toMatchObject({
        rows: [],
        page: 1,
        totalPages: 1,
        totalCount: 0,
      });
      expect(query.range).toHaveBeenCalledWith(0, 24);
    },
  );
  it("recovers from a PostgREST 416 when an old page no longer exists", async () => {
    const { query } = client([
      { data: null, count: null, error: { code: "PGRST103", message: "Range not satisfiable" } },
      { data: [{ id: "first" }], count: 3, error: null },
    ]);
    expect(await getBatteryRequests({ page: "99" })).toMatchObject({
      page: 1,
      totalPages: 1,
      rows: [{ id: "first" }],
    });
    expect(query.range.mock.calls).toEqual([
      [2450, 2474],
      [0, 24],
    ]);
  });

  it("does not expose database diagnostics", async () => {
    client([{ data: null, count: null, error: { message: "private@example.test secret" } }]);
    await expect(getBatteryRequests()).rejects.toThrow(/^Unable to load battery requests$/);
  });
});
