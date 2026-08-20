import { beforeEach, describe, expect, it, vi } from "vitest";

const noStore = vi.fn();
const getSupabaseAdminClient = vi.fn();

vi.mock("next/cache", () => ({ unstable_noStore: noStore }));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));

function makeBuilder(data: unknown[], count?: number, error: { message: string } | null = null) {
  const result = { data, error, ...(count === undefined ? {} : { count }) };
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

  it("hydrates provenance and bounded outbound context from canonical relations", async () => {
    const listing = makeBuilder([{
      id: "listing-1",
      title: "Pack stock",
      reference: "REF-1",
      seo_slug: "pack-stock",
      supplier_account_id: "supplier-1",
      created_by_user_id: "creator-1",
      channel_mode: "sale",
      listing_status: "published",
      visibility: "public",
      description: "Pack description",
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-19T00:00:00.000Z",
    }]);
    const specs = makeBuilder([{
      listing_id: "listing-1",
      quantity: 12,
      pack_kwh: 42,
      pack_weight_kg: 320,
      chemistry: "NMC",
      manufacturer: "Samsung SDI",
      model: "E-Z-Go",
      location_address: { city: "London", countryCode: "GB" },
      metadata_json: {
        source: "supplier_upload",
        source_url: "https://supplier.example/listing/1",
        generated_by: "catalogue-normalizer",
      },
      condition_json: { state: "used" },
    }]);
    const accounts = makeBuilder([
      { id: "supplier-1", name: "Supplier One", role: "supplier", sector: "battery_assembler" },
      { id: "buyer-1", name: "Buyer One", role: "buyer", sector: "energy_storage_oem" },
      { id: "recycler-1", name: "Recycler One", role: "recycler", sector: "battery_recycler" },
    ]);
    const purchaseOffers = makeBuilder([{ id: "offer-1", status: "submitted", buyer_account_id: "buyer-1", quantity_requested: 4, submitted_at: "2026-08-19T10:00:00.000Z" }], 2);
    const recyclingOffers = makeBuilder([{ id: "offer-2", status: "accepted", recycler_account_id: "recycler-1", submitted_at: "2026-08-18T10:00:00.000Z" }], 1);
    const links = makeBuilder([{ id: "link-1", link_type: "invited", state: "active", recycler_account_id: "recycler-1", created_at: "2026-08-18T10:00:00.000Z", updated_at: "2026-08-19T10:00:00.000Z", expires_at: "2026-09-01T00:00:00.000Z" }], 1);
    const conversations = makeBuilder([{ id: "conversation-1", status: "open", last_message_at: "2026-08-19T11:00:00.000Z", last_message_preview: "Can you share the pack details?" }], 1);
    const rpc = vi.fn().mockResolvedValue({ data: [{ listing_id: "listing-1", enquiry_count: 3, deal_count: 1 }], error: null });
    getSupabaseAdminClient.mockReturnValue({
      rpc,
      from: vi.fn((table: string) => ({
        listings: listing,
        listing_specs: specs,
        accounts,
        purchase_offers: purchaseOffers,
        recycling_offers: recyclingOffers,
        recycler_opportunity_links: links,
        conversations,
      }[table] ?? makeBuilder([]))),
    });

    const { getListingDetails } = await import("./actions");
    const result = await getListingDetails("listing-1");

    expect(result?.provenance).toMatchObject({ createdByUserId: "creator-1", sourceLabel: "supplier_upload", sourceUrl: "https://supplier.example/listing/1" });
    expect(result?.evidence).toMatchObject({ present: 9, total: 9, missing: [] });
    expect(result?.outbound).toMatchObject({ enquiryCount: 3, dealCount: 1, offerCount: 3, opportunityCount: 1, conversationCount: 1, lastMarketplaceContactAt: "2026-08-19T11:00:00.000Z" });
    expect(result?.outbound.recentOffers[0]).toMatchObject({ id: "offer-1", counterpartName: "Buyer One", kind: "purchase" });
    expect(result?.outbound.opportunityLinks[0]).toMatchObject({ id: "link-1", accountName: "Recycler One", state: "active" });
    expect(purchaseOffers.limit).toHaveBeenCalledWith(5);
    expect(conversations.limit).toHaveBeenCalledWith(5);
    expect(rpc).toHaveBeenCalledWith("get_listing_activity_counts", { listing_ids: ["listing-1"] });
  });

  it("keeps primary listing details available when ancillary activity reads fail", async () => {
    const listing = makeBuilder([{
      id: "listing-1",
      title: "Pack stock",
      reference: "REF-1",
      seo_slug: "pack-stock",
      supplier_account_id: "supplier-1",
      created_by_user_id: null,
      channel_mode: "sale",
      listing_status: "published",
      visibility: "public",
      description: null,
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-19T00:00:00.000Z",
    }]);
    const specs = makeBuilder([{ listing_id: "listing-1", metadata_json: {}, condition_json: {} }]);
    const accounts = makeBuilder([{ id: "supplier-1", name: "Supplier One", role: "supplier", sector: null }]);
    const failing = () => makeBuilder([], undefined, { message: "relation unavailable" });
    getSupabaseAdminClient.mockReturnValue({
      rpc: vi.fn().mockRejectedValue(new Error("rpc unavailable")),
      from: vi.fn((table: string) => {
        if (table === "listings") return listing;
        if (table === "listing_specs") return specs;
        if (table === "accounts") return accounts;
        return failing();
      }),
    });

    const { getListingDetails } = await import("./actions");
    const result = await getListingDetails("listing-1");

    expect(result?.title).toBe("Pack stock");
    expect(result?.outbound).toMatchObject({ enquiryCount: 0, dealCount: 0, offerCount: 0, opportunityCount: 0, conversationCount: 0 });
  });
});
