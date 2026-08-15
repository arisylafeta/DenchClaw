import { beforeEach, describe, expect, it, vi } from "vitest";

const noStore = vi.fn();
const getSupabaseAdminClient = vi.fn();

vi.mock("next/cache", () => ({ unstable_noStore: noStore }));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));

describe("battery review reads", () => {
  beforeEach(() => vi.clearAllMocks());

  it("paginates filter rows past the Supabase response cap", async () => {
    const firstPage = Array.from({ length: 1_000 }, () => ({
      manufacturer: "Existing maker",
      chemistry: "LFP",
    }));
    const range = vi.fn((from: number) => Promise.resolve({
      data: from === 0
        ? firstPage
        : [{ manufacturer: "Later maker", chemistry: "NMC" }],
      error: null,
    }));
    const builder = {
      select: vi.fn(),
      order: vi.fn(),
      range,
    };
    builder.select.mockReturnValue(builder);
    builder.order.mockReturnValue(builder);
    getSupabaseAdminClient.mockReturnValue({ from: vi.fn(() => builder) });

    const { getBatteryFilterOptions } = await import("./actions");
    const options = await getBatteryFilterOptions();

    expect(range).toHaveBeenCalledWith(0, 999);
    expect(range).toHaveBeenCalledWith(1_000, 1_999);
    expect(options).toEqual({
      manufacturers: ["Existing maker", "Later maker"],
      chemistries: ["LFP", "NMC"],
    });
  });

  it("keeps catalogue list payloads to the fields rendered in the table", async () => {
    const result = { data: [{ id: "battery-1", manufacturer: "Maker" }], error: null, count: 1 };
    const builder = {
      select: vi.fn(),
      order: vi.fn(),
      range: vi.fn(),
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    builder.select.mockReturnValue(builder);
    builder.order.mockReturnValue(builder);
    builder.range.mockReturnValue(builder);
    getSupabaseAdminClient.mockReturnValue({ from: vi.fn(() => builder) });

    const { getBatteryReviewPage } = await import("./actions");
    await getBatteryReviewPage({ tab: "canonical" });

    const selectedColumns = builder.select.mock.calls[0][0] as string;
    expect(selectedColumns).not.toContain("*");
    expect(selectedColumns).toContain("catalogue_image_url");
  });
});
