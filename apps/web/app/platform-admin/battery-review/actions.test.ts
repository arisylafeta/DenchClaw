import { beforeEach, describe, expect, it, vi } from "vitest";

const noStore = vi.fn();
const getSupabaseAdminClient = vi.fn();

vi.mock("next/cache", () => ({ unstable_noStore: noStore }));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));

function evidenceQuery(result: Record<string, unknown>) {
  const builder = {
    select: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    // Supabase query builders are intentionally awaitable.
    // oxlint-disable-next-line unicorn/no-thenable
    then: (resolve: (value: Record<string, unknown>) => unknown) =>
      Promise.resolve(result).then(resolve),
  };
  builder.select.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.range.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.or.mockReturnValue(builder);
  return builder;
}

describe("battery evidence review reads", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a safe compatibility state before the evidence migration", async () => {
    const builder = evidenceQuery({
      data: null,
      error: { code: "42703", message: "column battery_evidence.status does not exist" },
      count: null,
    });
    getSupabaseAdminClient.mockReturnValue({ from: vi.fn(() => builder) });

    const { getBatteryEvidencePage } = await import("./actions");
    const page = await getBatteryEvidencePage();

    expect(page).toEqual({
      rows: [],
      totalCount: 0,
      page: 1,
      pageSize: 25,
      schemaReady: false,
    });
  });

  it("returns pending immutable evidence without creating candidate rows", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      canonical_application_id: null,
      status: "pending",
      submitted_values: { marketed_kwh: 60 },
    };
    const builder = evidenceQuery({ data: [row], error: null, count: 1 });
    getSupabaseAdminClient.mockReturnValue({ from: vi.fn(() => builder) });

    const { getBatteryEvidencePage } = await import("./actions");
    const page = await getBatteryEvidencePage();

    expect(page.schemaReady).toBe(true);
    expect(page.totalCount).toBe(1);
    expect(page.rows[0]).toMatchObject({
      ...row,
      canonical_context: null,
      differences: [],
    });
    expect(builder.eq).toHaveBeenCalledWith("status", "pending");
  });
});
