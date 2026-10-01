import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("reads Notes from custom field values for CRM profile pages", async () => {
    queryPgMock.mockImplementation(async (sql: string) => {
      if (sql.includes("from crm_people")) {
        return [
          {
            id: "gog:person:ari.sylafeta@gmail.com",
            name: "Ari Sylafeta",
            email: null,
            company_id: null,
            phone: null,
            status: null,
            job_title: null,
            linkedin_url: null,
            last_interaction_at: "2026-06-22T11:59:24Z",
            notes: "Typeform submission - Buyer Sourcing Criteria",
            created_at: null,
            updated_at: null,
          },
        ];
      }
      return [];
    });

    const profile = await getPostgresPersonProfile("gog:person:ari.sylafeta@gmail.com");

    expect(profile?.person.notes).toBe("Typeform submission - Buyer Sourcing Criteria");
    expect(profile?.person.last_interaction_at).toBe("2026-06-22T11:59:24Z");
    expect(profile?.campaign_summary).toEqual({
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      tracking_pending: 0,
    });
    expect(profile?.listing_engagement).toEqual([]);
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
      { listing_id: "listing-a", cta_key: "listing-a-primary", clicked_updates: 2 },
      { listing_id: "listing-b", cta_key: "listing-b", clicked_updates: 1 },
    ]);
    expect(profile?.campaigns.find((send) => send.send_id === "first")?.links).toEqual([
      { cta_key: "listing-a-primary", listing_id: "listing-a", first_clicked_at: observedAt.toISOString() },
      { cta_key: "listing-a-secondary", listing_id: "listing-a", first_clicked_at: observedAt.toISOString() },
      { cta_key: "listing-b", listing_id: "listing-b", first_clicked_at: observedAt.toISOString() },
      { cta_key: "grid", listing_id: null, first_clicked_at: observedAt.toISOString() },
    ]);
    expect(profile?.campaigns.find((send) => send.send_id === "second")?.links).toEqual([
      { cta_key: "listing-a-primary", listing_id: "listing-a", first_clicked_at: observedAt.toISOString() },
      { cta_key: "listing-b", listing_id: "listing-b", first_clicked_at: null },
      { cta_key: "sourcing", listing_id: null, first_clicked_at: null },
    ]);
    expect(profile?.campaigns.find((send) => send.send_id === "tracking-pending")?.last_synced_at).toBeNull();
    expect(JSON.stringify(profile)).not.toContain("private-token");
  });
});
