import { beforeEach, describe, expect, it, vi } from "vitest";

const noStore = vi.fn();
const getSupabaseAdminClient = vi.fn();

vi.mock("next/cache", () => ({ unstable_noStore: noStore }));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));

function makeBuilder(data: unknown[], count?: number) {
  const result = { data, error: null, ...(count === undefined ? {} : { count }) };
  const builder = Object.assign(Promise.resolve(result), {
    select: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    in: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(),
  });
  for (const method of ["select", "order", "range", "in", "gte", "lte", "eq", "or", "limit"] as const) {
    builder[method].mockReturnValue(builder);
  }
  builder.maybeSingle.mockResolvedValue({ data: data[0] ?? null, error: null });
  return builder;
}

describe("marketplace listings reads", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies bounded capacity and weight filters with deterministic sorting", async () => {
    const marketplace = makeBuilder([
      {
        id: "listing-1",
        title: "Pack stock",
        listing_status: "published",
        visibility: "public",
        channel_mode: "sale",
        supplier_account_id: "supplier-1",
        supplier_display_name: "Supplier One",
        pack_kwh: 42,
        pack_weight_kg: 320,
        quantity: 12,
        chemistry: "NMC",
        location_city: "London",
        location_region: null,
        location_country: "GB",
        seo_slug: "pack-stock",
        created_at: "2026-08-18T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
      },
    ], 1);
    const listings = makeBuilder([{ id: "listing-1", reference: "REF-1", seo_slug: "pack-stock" }]);
    getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => table === "listings_marketplace_v" ? marketplace : listings),
    });

    const { getListingPage } = await import("./actions");
    const result = await getListingPage({
      page: 2,
      minKwh: "10",
      maxKwh: "100",
      minWeightKg: "100",
      maxWeightKg: "500",
      status: "published",
      channel: "sale",
      sort: "capacity_desc",
    });

    expect(result.rows[0]).toMatchObject({
      id: "listing-1",
      reference: "REF-1",
      packKwh: 42,
      packWeightKg: 320,
      supplierName: "Supplier One",
    });
    expect(marketplace.order).toHaveBeenNthCalledWith(1, "pack_kwh", { ascending: false, nullsFirst: false });
    expect(marketplace.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(marketplace.range).toHaveBeenCalledWith(25, 49);
    expect(marketplace.gte).toHaveBeenCalledWith("pack_kwh", 10);
    expect(marketplace.lte).toHaveBeenCalledWith("pack_kwh", 100);
    expect(marketplace.gte).toHaveBeenCalledWith("pack_weight_kg", 100);
    expect(marketplace.lte).toHaveBeenCalledWith("pack_weight_kg", 500);
    expect(marketplace.eq).toHaveBeenCalledWith("listing_status", "published");
    expect(marketplace.eq).toHaveBeenCalledWith("channel_mode", "sale");
  });

  it("normalizes swapped ranges and preserves the all-listings default", async () => {
    const marketplace = makeBuilder([], 0);
    getSupabaseAdminClient.mockReturnValue({ from: vi.fn(() => marketplace) });

    const { getListingPage } = await import("./actions");
    const result = await getListingPage({ minKwh: "90", maxKwh: "10", minWeightKg: "400", maxWeightKg: "200" });

    expect(result.filters).toMatchObject({ minKwh: "10", maxKwh: "90", minWeightKg: "200", maxWeightKg: "400", sort: "updated_desc", status: "", channel: "" });
    expect(marketplace.eq).not.toHaveBeenCalled();
    expect(marketplace.order).toHaveBeenNthCalledWith(1, "updated_at", { ascending: false, nullsFirst: false });
  });

  it("reads location from the marketplace view's JSON address instead of stale columns", async () => {
    const marketplace = makeBuilder([
      {
        id: "listing-1",
        title: "Pack stock",
        listing_status: "published",
        visibility: "public",
        channel_mode: "sale",
        supplier_account_id: "supplier-1",
        supplier_display_name: "Supplier One",
        pack_kwh: 42,
        pack_weight_kg: 320,
        quantity: 12,
        chemistry: "NMC",
        location_address: {
          city: "London",
          region: "Greater London",
          countryCode: "GB",
        },
        filter_location_country: "GB",
        seo_slug: "pack-stock",
        created_at: "2026-08-18T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
      },
    ], 1);
    const listings = makeBuilder([{ id: "listing-1", reference: "REF-1", seo_slug: "pack-stock" }]);
    getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "listings_marketplace_v") return marketplace;
        return listings;
      }),
    });

    const { getListingPage } = await import("./actions");
    const result = await getListingPage();

    expect(result.rows[0]).toMatchObject({
      locationCity: "London",
      locationRegion: "Greater London",
      locationCountry: "GB",
    });
    expect(String(marketplace.select.mock.calls[0]?.[0])).not.toContain("location_city");
    expect(String(marketplace.select.mock.calls[0]?.[0])).toContain("location_address");
  });

  it("does not apply text search operators to the enum-backed specs chemistry field", async () => {
    const marketplace = makeBuilder([{ id: "listing-1" }], 1);
    const listings = makeBuilder([{ id: "listing-1" }]);
    const specs = makeBuilder([{ listing_id: "listing-1" }]);
    getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "listings_marketplace_v") return marketplace;
        if (table === "listing_specs") return specs;
        return listings;
      }),
    });

    const { getListingPage } = await import("./actions");
    await getListingPage({ search: "battery" });

    expect(String(specs.or.mock.calls[0]?.[0])).not.toContain("chemistry.ilike");
  });
});
