import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCampaignDetail, listCampaigns } from "./campaigns";

const { queryPgMock } = vi.hoisted(() => ({ queryPgMock: vi.fn() }));
vi.mock("../postgres", () => ({ queryPg: queryPgMock }));

const AT = "2026-10-01T10:00:00.000Z";
const EARLIER = "2026-10-01T09:00:00.000Z";
const campaign = (fields: Record<string, unknown> = {}) => ({
  id: "campaign-1", campaign_name: "Open battery auctions", status: "live",
  type: "supply_update", channel: "email-postmark", source_system: "dench-campaign",
  audience: "115 Supply Update contacts", audience_size: 115,
  launched_at: new Date(AT), last_invite_at: AT, metrics_refreshed_at: AT,
  invites_sent: 115, emails_delivered: 113, emails_opened: 24, emails_clicked: 13,
  emails_bounced: 3, opted_out: 2, created_at: new Date(AT), updated_at: AT,
  ...fields,
});
const send = (id: string, fields: Record<string, unknown> = {}) => ({
  send_id: id, campaign_id: "campaign-1", person_id: `person-${id}`,
  person_name: `Buyer ${id}`, company_id: "company-1", company_name: "Battery Buyers",
  recipient_email: `${id}@example.test`, state: "accepted", listing_id: "listing-a",
  auction_url: "https://www.rebattery.io/marketplace/auctions/battery-a",
  accepted_at: new Date(AT), delivered_at: null, bounced_at: null,
  provider_opened_at: null, provider_link_clicked_at: null, link_clicked_at: null,
  last_synced_at: AT, provider_message_id: "private-provider-message",
  tracking_token: "private-recipient-token", ...fields,
});
const link = (sendId: string, key: string, listingId: string | null, fields: Record<string, unknown> = {}) => ({
  send_id: sendId, cta_key: key, listing_id: listingId,
  destination_url: `https://www.rebattery.io/marketplace/auctions/${listingId === "listing-b" ? "battery-b" : "battery-a"}?recipient=private-recipient-token#private-fragment`,
  first_clicked_at: null, ...fields,
});

function detailRows(row: Record<string, unknown>, sends: Record<string, unknown>[], links: Record<string, unknown>[] = []) {
  queryPgMock.mockResolvedValueOnce([row])
    .mockResolvedValueOnce([{ available: true, links_available: true, listings_available: false }])
    .mockResolvedValueOnce(sends)
    .mockResolvedValueOnce(links);
}

beforeEach(() => {
  queryPgMock.mockReset();
  vi.stubEnv("REBATTERY_SITE_URL", "https://rebattery.io");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("campaign projections", () => {
  it("keeps the historical snapshot distinct from its shorter retained recipient ledger", async () => {
    const audience = `115 Supply Update contacts; exact send ledger SHA256 ${"a".repeat(64)}`;
    detailRows(campaign({ source_system: "gog-reconciled", audience }),
      Array.from({ length: 113 }, (_, index) => send(`retained-${index}`, { delivered_at: AT, provider_opened_at: AT })));

    const detail = await getCampaignDetail("campaign-1");
    expect(detail?.campaign.metrics).toEqual({ sent: 115, delivered: 113, opened: 24, clicked: 13, bounced: 3, opted_out: 2 });
    expect(detail?.campaign.metrics_basis).toBe("snapshot");
    expect(detail?.campaign.recipient_count).toBe(113);
    expect(detail?.campaign.audience).toBe("115 Supply Update contacts");
    expect(detail?.details.audience_raw).toBe(audience);
    expect(detail?.campaign.launched_at).toBe(AT);
    expect(detail?.details.created_at).toBe(AT);
    expect(detail?.recipients[0].send_id).toBe("retained-0");
    expect(detail?.recipients[0]).toMatchObject({ person_id: "person-retained-0", company_id: "company-1", company_name: "Battery Buyers" });
  });

  it("keeps the frozen cohort digest in audit details rather than the readable audience", async () => {
    const audience = `Frozen 2 recipients; SHA256 ${"b".repeat(64)}`;
    detailRows(campaign({ audience }), []);
    const detail = await getCampaignDetail("campaign-1");
    expect(detail?.campaign.audience).toBe("Frozen 2 recipients");
    expect(detail?.details.audience_raw).toBe(audience);
  });

  it("counts provider or link-only clicks once per accepted send and deduplicates each listing's recipients", async () => {
    detailRows(campaign(), [
      send("provider", { provider_link_clicked_at: AT, provider_opened_at: AT, delivered_at: AT }),
      send("link-only"),
      send("general-only"),
      send("pending", { last_synced_at: null }),
      send("delivered", { delivered_at: AT }),
      send("frozen", { state: "frozen", accepted_at: null, provider_opened_at: AT }),
    ], [
      link("provider", "battery-a", "listing-a", { first_clicked_at: new Date(EARLIER) }),
      link("provider", "battery-a-secondary", "listing-a", { first_clicked_at: AT }),
      link("link-only", "battery-a", "listing-a", { first_clicked_at: AT }),
      link("link-only", "battery-b", "listing-b", { first_clicked_at: AT }),
      link("general-only", "auction-grid", null, { first_clicked_at: AT }),
      link("pending", "battery-a", "listing-a"),
      link("delivered", "battery-b", "listing-b"),
      link("frozen", "battery-b", "listing-b", { first_clicked_at: AT }),
    ]);

    const detail = await getCampaignDetail("campaign-1");
    expect(detail?.campaign).toMatchObject({
      metrics_basis: "ledger", recipient_count: 6, tracking_pending: 1,
      metrics: { sent: 5, delivered: 2, opened: 1, clicked: 3, bounced: 0, opted_out: 2 },
      metrics_observed_at: AT,
    });
    expect(detail?.recipients.find((recipient) => recipient.send_id === "provider")?.clicked_at).toBe(EARLIER);
    expect(detail?.recipients.find((recipient) => recipient.send_id === "provider")?.listing_clicks).toEqual([
      { listing_id: "listing-a", label: "battery a", first_clicked_at: EARLIER },
    ]);
    expect(detail?.recipients.find((recipient) => recipient.send_id === "general-only")).toMatchObject({ clicked_at: AT, listing_clicks: [] });
    expect(detail?.recipients.find((recipient) => recipient.send_id === "pending")).toMatchObject({ clicked_at: null, tracking_pending: true });
    expect(detail?.listings).toEqual([
      {
        listing_id: "listing-a", label: "battery a", url: "https://www.rebattery.io/marketplace/auctions/battery-a",
        recipients: 3, clicked_recipients: 2,
      },
      {
        listing_id: "listing-b", label: "battery b", url: "https://www.rebattery.io/marketplace/auctions/battery-b",
        recipients: 3, clicked_recipients: 1,
      },
    ]);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("private-recipient-token");
    expect(serialized).not.toContain("private-provider-message");
    expect(serialized).not.toContain("private-fragment");
    expect(serialized).not.toContain("destination_url");
    expect(serialized).not.toContain("provider_message_id");
  });

  it("attributes general email CTAs only to accepted sends, deduplicates their first clicks, and keeps destinations private", async () => {
    const opaqueKey = "11111111-1111-4111-8111-111111111111";
    const tracked = { destination_url: "https://crm.rebattery.io/t/private-general-token?recipient=private-recipient-token#private-fragment" };
    detailRows(campaign(), [
      send("general", { listing_id: null, accepted_at: null }),
      send("provider-only", { listing_id: null, provider_link_clicked_at: AT }),
      send("rejected", { listing_id: null, state: "rejected", accepted_at: null, provider_link_clicked_at: AT }),
      send("queued", { listing_id: null, state: "queued", accepted_at: null }),
    ], [
      link("general", "auction_grid", null, { ...tracked, first_clicked_at: AT }),
      link("general", "auction_grid", null, { ...tracked, first_clicked_at: new Date(EARLIER) }),
      link("general", "auction_grid", null, { ...tracked, first_clicked_at: "invalid-date" }),
      link("general", opaqueKey, null, tracked),
      link("general", "battery-a", "listing-a"),
      link("provider-only", "supplier-contact", null, { destination_url: "http://www.rebattery.io/contact?recipient=private-recipient-token" }),
      link("rejected", "auction_grid", null, { ...tracked, first_clicked_at: EARLIER }),
      link("rejected", "supplier-contact", null, { ...tracked, first_clicked_at: EARLIER }),
      link("queued", "supplier-contact", null, { ...tracked, first_clicked_at: EARLIER }),
    ]);

    const detail = await getCampaignDetail("campaign-1");
    expect(detail?.other_destinations).toEqual([
      { cta_key: "auction_grid", label: "auction grid" },
      { cta_key: opaqueKey, label: "General destination" },
      { cta_key: "supplier-contact", label: "supplier contact" },
    ]);
    expect(detail?.recipients.find((recipient) => recipient.send_id === "general")).toMatchObject({
      clicked_at: EARLIER,
      other_clicks: [{ cta_key: "auction_grid", label: "auction grid", first_clicked_at: EARLIER }],
      listing_clicks: [],
    });
    for (const sendId of ["provider-only", "rejected", "queued"]) {
      expect(detail?.recipients.find((recipient) => recipient.send_id === sendId)).toMatchObject({
        other_clicks: [], listing_clicks: [],
      });
    }
    expect(detail?.campaign.metrics).toMatchObject({ sent: 2, clicked: 2 });
    expect(detail?.listings).toEqual([{
      listing_id: "listing-a", label: "battery a", url: "https://www.rebattery.io/marketplace/auctions/battery-a",
      recipients: 1, clicked_recipients: 0,
    }]);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("private-general-token");
    expect(serialized).not.toContain("private-recipient-token");
    expect(serialized).not.toContain("private-fragment");
    expect(serialized).not.toContain("destination_url");
  });

  it("keeps unchecked tracking unknown, including when a separate positive observation is available", async () => {
    detailRows(campaign(), [send("pending-a", { last_synced_at: null }), send("pending-b", { last_synced_at: null })]);
    const unchecked = await getCampaignDetail("campaign-1");
    expect(unchecked?.campaign).toMatchObject({
      metrics: { sent: 2, delivered: null, opened: null, clicked: null, bounced: null, opted_out: 2 },
      tracking_pending: 2, metrics_observed_at: null,
    });

    detailRows(campaign(), [send("pending-positive", { last_synced_at: null, provider_opened_at: AT })], [
      link("pending-positive", "battery-a", "listing-a", { first_clicked_at: AT }),
    ]);
    const positive = await getCampaignDetail("campaign-1");
    expect(positive?.campaign).toMatchObject({
      metrics: { sent: 1, delivered: null, opened: 1, clicked: 1, bounced: null },
      tracking_pending: 1, metrics_observed_at: null,
    });
  });

  it("returns all five campaigns while retaining separate snapshot and ledger bases", async () => {
    queryPgMock.mockResolvedValueOnce([
      campaign({ id: "historical", source_system: "gog-reconciled" }),
      campaign({ id: "ebus", source_system: "rebattery-platform", emails_opened: null }),
      campaign({ id: "proterra", source_system: "rebattery-platform" }),
      campaign({ id: "test" }),
      campaign({ id: "live" }),
    ]).mockResolvedValueOnce([{ available: true, links_available: true }]).mockResolvedValueOnce([
      send("live-pending", { campaign_id: "live", last_synced_at: null }),
      send("test-clicked", { campaign_id: "test", link_clicked_at: AT }),
    ]);

    const summaries = await listCampaigns();
    expect(summaries.map((row) => row.id)).toEqual(["historical", "ebus", "proterra", "test", "live"]);
    expect(summaries.find((row) => row.id === "historical")).toMatchObject({ metrics_basis: "snapshot", recipient_count: 0, metrics: { sent: 115, clicked: 13 } });
    expect(summaries.find((row) => row.id === "ebus")?.metrics.opened).toBeNull();
    expect(summaries.find((row) => row.id === "test")).toMatchObject({ metrics_basis: "ledger", recipient_count: 1, metrics: { sent: 1, clicked: 1 } });
    expect(summaries.find((row) => row.id === "live")).toMatchObject({ tracking_pending: 1, metrics: { sent: 1, opened: null, clicked: null } });
  });

  it.each([
    "https://www.rebattery.io/c/private-recipient-token",
    "https://crm.rebattery.io/t/private-recipient-token",
    "https://click.pstmrk.it/private-recipient-token",
    "https://www.rebattery.io.attacker.test/marketplace/auctions/battery-a",
    "https://private-user:private-password@www.rebattery.io/marketplace/auctions/battery-a",
    "http://www.rebattery.io/marketplace/auctions/battery-a",
    "javascript:alert('private-recipient-token')",
  ])("does not expose a tracked or unsafe listing destination (%s)", async (destination) => {
    detailRows(campaign(), [send("buyer")], [link("buyer", "battery-a", "listing-a", { destination_url: destination })]);
    const detail = await getCampaignDetail("campaign-1");
    expect(detail?.listings[0]).toMatchObject({ listing_id: "listing-a", label: "battery a", url: null, recipients: 1, clicked_recipients: 0 });
    expect(JSON.stringify(detail)).not.toContain(destination);
  });

  it("retains included but unclicked listings and never assigns a provider-wide click to a destination", async () => {
    detailRows(campaign(), [send("provider", { provider_link_clicked_at: AT })], [
      link("provider", "battery-a", "listing-a"),
      link("provider", "battery-b", "listing-b"),
      link("provider", "general-grid", null, { first_clicked_at: AT }),
    ]);
    const detail = await getCampaignDetail("campaign-1");
    expect(detail?.campaign.metrics.clicked).toBe(1);
    expect(detail?.listings.map((listing) => [listing.listing_id, listing.recipients, listing.clicked_recipients])).toEqual([
      ["listing-a", 1, 0], ["listing-b", 1, 0],
    ]);
    expect(detail?.recipients[0].listing_clicks).toEqual([]);
  });

  it("resolves tracked destinations through the captured auction cache without changing recipient deduplication or unclicked inclusion", async () => {
    const tracked = { destination_url: "https://www.rebattery.io/c/private-recipient-token" };
    queryPgMock.mockResolvedValueOnce([campaign()])
      .mockResolvedValueOnce([{ available: true, links_available: true, listings_available: true }])
      .mockResolvedValueOnce([send("clicked"), send("pending", { last_synced_at: null })])
      .mockResolvedValueOnce([
        link("clicked", "tesla", "listing-a", { ...tracked, first_clicked_at: AT }),
        link("clicked", "tesla-secondary", "listing-a", { ...tracked, first_clicked_at: EARLIER }),
        link("pending", "tesla", "listing-a", tracked),
        link("clicked", "kokam", "listing-b", tracked),
        link("pending", "kokam", "listing-b", tracked),
        link("clicked", "unsafe-slug", "listing-c", tracked),
        link("clicked", "general-grid", null, { ...tracked, first_clicked_at: AT }),
      ])
      .mockResolvedValueOnce([
        { listing_id: "listing-a", title: "Tesla Megapack 2503.2kWh", auction_slug: "tesla-megapack-577f-f300" },
        { listing_id: "listing-b", title: "Kokam NMC cells", auction_slug: "kokam-kcl255103en1-0-379kwh-nmc-e720-cf32" },
        { listing_id: "listing-c", title: "Unresolved listing", auction_slug: "../auth/private-recipient-token?redirect=1" },
      ]);

    const detail = await getCampaignDetail("campaign-1");
    expect(detail?.listings.find((listing) => listing.listing_id === "listing-a")).toEqual({
      listing_id: "listing-a", label: "Tesla Megapack 2503.2kWh",
      url: "https://rebattery.io/marketplace/auctions/tesla-megapack-577f-f300",
      recipients: 2, clicked_recipients: 1,
    });
    expect(detail?.listings.find((listing) => listing.listing_id === "listing-b")).toMatchObject({
      label: "Kokam NMC cells",
      url: "https://rebattery.io/marketplace/auctions/kokam-kcl255103en1-0-379kwh-nmc-e720-cf32",
      recipients: 2, clicked_recipients: 0,
    });
    expect(detail?.listings.find((listing) => listing.listing_id === "listing-c")).toMatchObject({
      label: "Unresolved listing", url: null,
    });
    expect(detail?.recipients.find((recipient) => recipient.send_id === "clicked")?.listing_clicks).toEqual([
      { listing_id: "listing-a", label: "Tesla Megapack 2503.2kWh", first_clicked_at: EARLIER },
    ]);
    expect(detail?.campaign).toMatchObject({ tracking_pending: 1, metrics: { sent: 2, clicked: 1 } });
    expect(JSON.stringify(detail)).not.toContain("private-recipient-token");
  });

  it("populates available technical fields, normalizes dates, and leaves absent audit fields unavailable", async () => {
    detailRows(campaign({
      source_system: undefined, objective: "Supply update", success_measure: "Replies",
      sender_identity: "supply@example.test", reply_owner: "Alex", reply_mailbox: "replies@example.test",
      message_version: "October", stock_snapshot_ref: "stock-2026-10", approved_manifest_sha256: "a".repeat(64),
      approved_by: "Alex", approved_at: new Date(AT), reviewed_at: "invalid-date", notes: "Saved campaign note",
    }), []);
    const detail = await getCampaignDetail("campaign-1");
    expect(detail?.campaign.metrics_basis).toBe("snapshot");
    expect(detail?.details).toMatchObject({
      source_system: null, objective: "Supply update", success_measure: "Replies", auction_slug: null,
      sender_identity: "supply@example.test", reply_owner: "Alex", reply_mailbox: "replies@example.test",
      message_version: "October", stock_snapshot_ref: "stock-2026-10", approved_manifest_sha256: "a".repeat(64),
      approved_by: "Alex", approved_at: AT, reviewed_at: null, notes: "Saved campaign note",
    });
  });

  it("uses the legacy primary listing only without CTA rows, with no invented destination click or UUID title", async () => {
    const listingId = "11111111-1111-4111-8111-111111111111";
    queryPgMock.mockResolvedValueOnce([campaign()])
      .mockResolvedValueOnce([{ available: true, links_available: false }])
      .mockResolvedValueOnce([send("legacy", {
        listing_id: listingId, provider_link_clicked_at: AT,
        auction_url: "https://www.rebattery.io/marketplace/auctions/ebus-batteries",
      })]);
    const legacy = await getCampaignDetail("campaign-1");
    expect(legacy?.campaign.metrics.clicked).toBe(1);
    expect(legacy?.listings).toEqual([{
      listing_id: listingId, label: "ebus batteries",
      url: "https://www.rebattery.io/marketplace/auctions/ebus-batteries",
      recipients: 1, clicked_recipients: 0,
    }]);
    expect(legacy?.recipients[0].listing_clicks).toEqual([]);
    expect(legacy?.recipients[0].other_clicks).toEqual([]);
    expect(legacy?.other_destinations).toEqual([]);

    detailRows(campaign(), [send("unavailable", { listing_id: listingId, auction_url: "https://www.rebattery.io/c/private-recipient-token" })]);
    const unavailable = await getCampaignDetail("campaign-1");
    expect(unavailable?.listings[0]).toMatchObject({ label: "Listing", url: null });
  });

  it("preserves snapshot-only installations without pretending an absent ledger was measured", async () => {
    queryPgMock.mockResolvedValueOnce([campaign({ source_system: "rebattery-platform" })])
      .mockResolvedValueOnce([{ available: false, links_available: false }]);
    const snapshot = await getCampaignDetail("campaign-1");
    expect(snapshot?.campaign.metrics.sent).toBe(115);
    expect(snapshot?.recipients).toEqual([]);
    expect(snapshot?.listings).toEqual([]);
    expect(snapshot?.other_destinations).toEqual([]);

    queryPgMock.mockResolvedValueOnce([campaign()])
      .mockResolvedValueOnce([{ available: false, links_available: false }]);
    const ledger = await getCampaignDetail("campaign-1");
    expect(ledger?.campaign.metrics).toEqual({ sent: null, delivered: null, opened: null, clicked: null, bounced: null, opted_out: 2 });
    expect(ledger?.other_destinations).toEqual([]);
  });

  it("represents an unknown campaign as missing", async () => {
    queryPgMock.mockResolvedValueOnce([]);
    expect(await getCampaignDetail("missing")).toBeNull();
  });
});
