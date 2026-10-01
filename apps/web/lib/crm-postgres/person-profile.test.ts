import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPostgresPersonProfile } from "./person-profile";

const { queryPgMock } = vi.hoisted(() => ({
  queryPgMock: vi.fn(),
}));

vi.mock("../postgres", () => ({
  queryPg: queryPgMock,
}));

describe("getPostgresPersonProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });


  it("counts accepted updates across all history and deduplicates clicked listings within each send", async () => {
    const observedAt = new Date("2026-09-30T10:00:00Z");
    const campaign = (sendId: string, fields: Record<string, unknown> = {}) => ({
      send_id: sendId,
      campaign_id: `campaign-${sendId}`,
      campaign_name: `Update ${sendId}`,
      listing_id: "listing-a",
      recipient_email: "buyer@example.com",
      state: "accepted",
      accepted_at: observedAt,
      delivered_at: null,
      bounced_at: null,
      provider_opened_at: null,
      provider_link_clicked_at: null,
      last_synced_at: observedAt,
      pitch_count: "105",
      ...fields,
    });
    const sends = [
      campaign("first", {
        delivered_at: observedAt,
        provider_opened_at: observedAt,
        provider_link_clicked_at: observedAt,
      }),
      campaign("second", { delivered_at: observedAt }),
      campaign("provider-only", {
        provider_opened_at: observedAt,
        provider_link_clicked_at: observedAt,
      }),
      campaign("tracking-pending", { last_synced_at: null }),
      campaign("grid-only"),
      ...Array.from({ length: 101 }, (_, index) => campaign(`historical-${index}`, {
        accepted_at: "2025-01-01T10:00:00Z",
        delivered_at: "2025-01-01T10:01:00Z",
      })),
      ...["frozen", "sending", "failed"].map((state) => campaign(state, {
        state,
        accepted_at: null,
        delivered_at: observedAt,
        provider_opened_at: observedAt,
        provider_link_clicked_at: observedAt,
        last_synced_at: null,
      })),
    ];
    const link = (sendId: string, ctaKey: string, listingId: string | null, clickedAt: Date | null = observedAt) => ({
      send_id: sendId,
      cta_key: ctaKey,
      listing_id: listingId,
      first_clicked_at: clickedAt,
      destination_url: "https://tracking.example.com/private-token",
      token: "private-token",
    });
    const links = [
      link("first", "listing-a-primary", "listing-a"),
      link("first", "listing-a-secondary", "listing-a"),
      link("first", "listing-b", "listing-b"),
      link("first", "grid", null),
      link("second", "listing-a-primary", "listing-a"),
      link("second", "listing-b", "listing-b", null),
      link("second", "sourcing", null, null),
      link("grid-only", "grid", null),
      link("failed", "listing-c", "listing-c"),
    ];
    queryPgMock.mockImplementation(async (sql: string) => {
      if (sql.includes("from crm_people")) {
        return [{
          id: "buyer",
          name: "Buyer",
          email: null,
          company_id: null,
          phone: null,
          job_title: null,
          linkedin_url: null,
          last_interaction_at: null,
          notes: "Existing notes",
          created_at: null,
          updated_at: null,
        }];
      }
      if (sql.includes("to_regclass")) return [{ available: true, links_available: true }];
      if (sql.includes("from crm_campaign_send_links")) return links;
      if (sql.includes("from crm_campaign_sends")) return sends;
      return [];
    });

    const profile = await getPostgresPersonProfile("buyer");

    expect(profile?.campaign_summary).toEqual({
      sent: 106,
      delivered: 103,
      opened: 2,
      clicked: 4,
      tracking_pending: 1,
    });
    expect(profile?.listing_engagement).toEqual([
      { listing_id: "listing-a", cta_key: "listing-a-primary", listing_title: null, listing_url: null, clicked_updates: 2 },
      { listing_id: "listing-b", cta_key: "listing-b", listing_title: null, listing_url: null, clicked_updates: 1 },
    ]);
    expect(profile?.campaigns.find((send) => send.send_id === "tracking-pending")?.last_synced_at).toBeNull();
    expect(JSON.stringify(profile)).not.toContain("private-token");
  });

  it("resolves cached titles in one listing lookup and exposes only safe canonical public links", async () => {
    vi.stubEnv("REBATTERY_SITE_URL", "https://rebattery.io");
    const observedAt = "2026-09-30T10:00:00Z";
    const listingIds = ["cached", "missing", "unsafe", "bad-slug"];
    queryPgMock.mockImplementation(async (sql: string) => {
      if (sql.includes("from crm_people")) { return [{
        id: "buyer", name: "Buyer", email: null, company_id: null, phone: null,
        job_title: null, linkedin_url: null, last_interaction_at: null, notes: null,
        created_at: null, updated_at: null,
      }]; }
      if (sql.includes("to_regclass")) { return [{ available: true, links_available: true, listings_available: true }]; }
      if (sql.includes("from crm_bulk_trade_lots")) { return [
        { listing_id: "cached", title: "  FPT battery modules  ", auction_slug: "fpt-battery-modules" },
        { listing_id: "bad-slug", title: "Battery lot", auction_slug: "../t/private-token" },
      ]; }
      if (sql.includes("from crm_campaign_send_links")) { return [{ send_id: "cached", cta_key: "FPT", listing_id: "cached", destination_url: "https://rebattery.io/t/private-token", first_clicked_at: observedAt }, { send_id: "missing", cta_key: "missing", listing_id: "missing", destination_url: "https://rebattery.io/marketplace/listings/safe-lot?token=private-token#recipient", first_clicked_at: null }, { send_id: "unsafe", cta_key: "unsafe", listing_id: "unsafe", destination_url: "https://rebattery.io.evil.example/marketplace/auctions/private-token", first_clicked_at: null }, { send_id: "bad-slug", cta_key: "bad-slug", listing_id: "bad-slug", destination_url: "https://rebattery.io/t/private-token", first_clicked_at: null }]; }
      if (sql.includes("from crm_campaign_sends")) { return listingIds.map((id) => ({
        send_id: id, campaign_id: "campaign", campaign_name: "Update", listing_id: id,
        auction_url: "https://rebattery.io/t/private-token", recipient_email: "buyer@example.com",
        state: "accepted", accepted_at: observedAt, delivered_at: null, bounced_at: null,
        provider_opened_at: null, provider_link_clicked_at: null, last_synced_at: observedAt, pitch_count: 1,
      })); }
      return [];
    });

    const profile = await getPostgresPersonProfile("buyer");
    expect(profile?.campaigns.find((send) => send.send_id === "cached")).toMatchObject({
      listing_title: "FPT battery modules",
      listing_url: "https://rebattery.io/marketplace/auctions/fpt-battery-modules",
    });
    expect(profile?.campaigns.find((send) => send.send_id === "missing")?.links[0]).toMatchObject({
      listing_title: null, listing_url: "https://rebattery.io/marketplace/listings/safe-lot",
    });
    for (const id of ["unsafe", "bad-slug"]) {
      expect(profile?.campaigns.find((send) => send.send_id === id)?.links[0].listing_url).toBeNull();
    }
    expect(profile?.listing_engagement[0]).toMatchObject({
      listing_title: "FPT battery modules", clicked_updates: 1,
      listing_url: "https://rebattery.io/marketplace/auctions/fpt-battery-modules",
    });
    expect(JSON.stringify(profile)).not.toContain("private-token");
    const cacheReads = queryPgMock.mock.calls.filter(([sql]) => sql.includes("from crm_bulk_trade_lots"));
    expect(cacheReads).toHaveLength(1);
    expect(cacheReads[0][1]).toEqual([listingIds]);
  });
});
