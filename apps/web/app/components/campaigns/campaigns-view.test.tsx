// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CampaignDetail, CampaignRecipient, CampaignSummary } from "@/lib/campaigns";
import { buildEntryLink } from "@/lib/workspace-links";
import { CampaignsView, type CampaignsViewProps } from "./campaigns-view";

const AT = "2026-09-29T10:30:00.000Z";
const summary: CampaignSummary = {
  id: "historical", name: "Battery offer", status: "sent", type: "bulk_trade", channel: "email", audience: "battery_buyers",
  launched_at: AT, last_invite_at: AT, audience_size: 115,
  metrics: { sent: 115, delivered: 113, opened: 24, clicked: 13, bounced: 3, opted_out: 0 },
  metrics_basis: "snapshot", metrics_observed_at: AT, recipient_count: 113, tracking_pending: 1,
};

function recipient(overrides: Partial<CampaignRecipient>): CampaignRecipient {
  return { send_id: "send", person_id: "person", person_name: "Contact", company_id: null, company_name: null,
    recipient_email: "contact@example.test", state: "accepted", accepted_at: AT, delivered_at: null, bounced_at: null,
    opened_at: null, clicked_at: null, last_synced_at: AT, tracking_pending: false, listing_clicks: [], ...overrides };
}
const recipients = [
  recipient({ send_id: "a", person_id: "person:a", person_name: "Ada", company_name: "North Batteries", recipient_email: "ada@example.test", delivered_at: AT, opened_at: AT,
    listing_clicks: [{ listing_id: "internal-listing-1", label: "Nissan Leaf 40 kWh", first_clicked_at: AT }] }),
  recipient({ send_id: "b", person_id: "person:b", person_name: "Ben", company_name: "South Parts", recipient_email: "ben@example.test", state: "bounced", bounced_at: AT }),
  recipient({ send_id: "c", person_id: "person:c", person_name: "Cora", recipient_email: "cora@example.test", tracking_pending: true, last_synced_at: null }),
  recipient({ send_id: "d", person_id: "person:d", person_name: "Dev", recipient_email: "dev@example.test", delivered_at: AT }),
];
const detail: CampaignDetail = {
  campaign: summary, recipients,
  listings: [
    { listing_id: "internal-listing-1", label: "Nissan Leaf 40 kWh", url: "https://rebattery.io/marketplace/auctions/nissan-leaf", recipients: 3, clicked_recipients: 1,
      clicked_people: [{ person_id: "person:a", name: "Ada", company_name: "North Batteries" }] },
    { listing_id: "internal-listing-2", label: "Renault Zoe 52 kWh", url: null, recipients: 2, clicked_recipients: 0, clicked_people: [] },
  ],
  details: { auction_slug: null, source_system: "reconciled", audience_raw: "battery_buyers", notes: "Approved historical outreach.",
    created_at: AT, updated_at: AT, objective: null, success_measure: null, message_version: "offer-v2", stock_snapshot_ref: null,
    sender_identity: null, reply_owner: null, reply_mailbox: null, approved_manifest_sha256: null, approved_by: null, approved_at: null, reviewed_at: null },
};
const props: CampaignsViewProps = { campaignId: "historical", onOpenCampaign: vi.fn(), onBack: vi.fn(), onNavigatePerson: vi.fn() };
function mockDetail(value: CampaignDetail = detail) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value))));
}
function visiblePeople() {
  return within(screen.getByRole("table", { name: "Recipients" })).queryAllByRole("link").map((link) => link.textContent);
}

afterEach(() => vi.unstubAllGlobals());

describe("CampaignsView", () => {
  it("filters real observations including listing-only clicks and intersects search without replacing its control", async () => {
    mockDetail();
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await screen.findByRole("table", { name: "Recipients" });
    expect(visiblePeople()).toEqual(["Ada", "Ben", "Cora", "Dev"]);
    const activity = screen.getByRole("group", { name: "Recipient activity" });
    await user.click(within(activity).getByRole("button", { name: "Clicked", exact: true }));
    expect(visiblePeople()).toEqual(["Ada"]);
    await user.click(within(activity).getByRole("button", { name: "Opened", exact: true }));
    expect(visiblePeople()).toEqual(["Ada"]);
    await user.click(within(activity).getByRole("button", { name: "Bounced", exact: true }));
    expect(visiblePeople()).toEqual(["Ben"]);
    await user.click(within(activity).getByRole("button", { name: "Tracking pending", exact: true }));
    expect(visiblePeople()).toEqual(["Cora"]);
    await user.click(within(activity).getByRole("button", { name: "All", exact: true }));
    const search = screen.getByRole("searchbox", { name: "Search recipients" });
    await user.type(search, "NORTH");
    expect(visiblePeople()).toEqual(["Ada"]);
    await user.click(within(activity).getByRole("button", { name: "Bounced", exact: true }));
    expect(visiblePeople()).toEqual([]);
    expect(screen.getByRole("searchbox", { name: "Search recipients" })).toBe(search);
    await user.clear(search);
    await user.type(search, "BEN@EXAMPLE.TEST");
    expect(visiblePeople()).toEqual(["Ben"]);
  });

  it("preserves historical metrics separately from the retained ledger and distinguishes pending from checked absences", async () => {
    mockDetail();
    render(<CampaignsView {...props} />);
    const metrics = await screen.findByRole("region", { name: "Campaign metrics" });
    for (const value of ["115", "113", "24", "13"]) { expect(within(metrics).getByText(value, { exact: true })).toBeInTheDocument(); }
    const provenance = screen.getByRole("region", { name: "Metrics provenance" });
    expect(provenance).toHaveTextContent(/Original sent:\s*115/);
    expect(provenance).toHaveTextContent(/Retained recipients:\s*113/);
    const table = screen.getByRole("table", { name: "Recipients" });
    const pending = within(table).getByRole("link", { name: "Cora" }).closest("tr")!;
    expect(within(pending).getAllByText("Unknown · pending")).toHaveLength(3);
    expect(within(pending).queryByText("Not observed")).not.toBeInTheDocument();
    const checked = within(table).getByRole("link", { name: "Dev" }).closest("tr")!;
    expect(within(checked).getAllByText("Not observed")).toHaveLength(2);
    expect(within(table).getByRole("link", { name: "Ada" })).toHaveAttribute("href", buildEntryLink("people", "person:a"));
  });

  it("renders unknown ledger totals without losing available observations on pending recipients", async () => {
    mockDetail({ ...detail, campaign: { ...summary, metrics_basis: "ledger", metrics: { sent: 1, delivered: null, opened: 1, clicked: 1, bounced: null, opted_out: null } },
      recipients: [recipient({ person_name: "Observed while pending", tracking_pending: true, last_synced_at: null, opened_at: AT,
        listing_clicks: [{ listing_id: "internal-listing-1", label: "Nissan Leaf 40 kWh", first_clicked_at: AT }] })] });
    render(<CampaignsView {...props} />);
    const metrics = await screen.findByRole("region", { name: "Campaign metrics" });
    expect(within(metrics).getAllByText("1", { exact: true })).toHaveLength(3);
    expect(within(metrics).getByText("Unknown", { exact: true })).toBeInTheDocument();
    const row = screen.getByRole("link", { name: "Observed while pending" }).closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    expect(cells[2].querySelector("time")).toHaveAttribute("datetime", AT);
    expect(cells[3].querySelector("time")).toHaveAttribute("datetime", AT);
    expect(within(row).queryByText("Not observed")).not.toBeInTheDocument();
    expect(within(row).getByText("Nissan Leaf 40 kWh")).toBeInTheDocument();
  });

  it("paginates the ledger, searches across all pages, and retains search when switching tabs", async () => {
    mockDetail({ ...detail, recipients: Array.from({ length: 30 }, (_, index) => recipient({ send_id: `s-${index}`, person_id: `p-${index}`, person_name: `Contact ${index + 1}` })) });
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await screen.findByRole("table", { name: "Recipients" });
    expect(visiblePeople()).toEqual(Array.from({ length: 25 }, (_, index) => `Contact ${index + 1}`));
    await user.click(screen.getByRole("button", { name: "Next", exact: true }));
    expect(visiblePeople()).toEqual(["Contact 26", "Contact 27", "Contact 28", "Contact 29", "Contact 30"]);
    const search = screen.getByRole("searchbox", { name: "Search recipients" });
    await user.type(search, "Contact 2");
    expect(visiblePeople()).toEqual(["Contact 2", ...Array.from({ length: 10 }, (_, index) => `Contact ${index + 20}`)]);
    await user.click(screen.getByRole("tab", { name: "Listings" }));
    await user.click(screen.getByRole("tab", { name: "Recipients" }));
    expect(screen.getByRole("searchbox", { name: "Search recipients" })).toBe(search);
    expect(search).toHaveValue("Contact 2");
    expect(visiblePeople()).toEqual(["Contact 2", ...Array.from({ length: 10 }, (_, index) => `Contact ${index + 20}`)]);
  });

  it("includes unclicked listings without inventing missing destinations and keeps audit details collapsed", async () => {
    mockDetail();
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await screen.findByRole("table", { name: "Recipients" });
    await user.click(screen.getByRole("tab", { name: "Listings" }));
    const listings = screen.getByRole("table", { name: "Listings" });
    expect(within(listings).getByText("Renault Zoe 52 kWh").closest("a")).toBeNull();
    expect(within(listings).queryByText(/internal-listing/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Details" }));
    const audit = screen.getByText("Technical and audit details").closest("details")!;
    expect(audit.open).toBe(false);
    await user.click(within(audit).getByText("Technical and audit details"));
    expect(audit.open).toBe(true);
    expect(within(audit).getByText("offer-v2")).toBeVisible();
    expect(screen.getByText("Notes").closest("details")!.open).toBe(false);
  });

  it("aborts a previous campaign request and ignores its late response", async () => {
    const pending = new Map<string, { signal: AbortSignal; resolve: (response: Response) => void }>();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => new Promise<Response>((resolve) => {
      pending.set(url, { signal: init.signal as AbortSignal, resolve });
    })));
    const view = render(<CampaignsView {...props} campaignId="first" />);
    await waitFor(() => expect(pending.has("/api/campaigns/first")).toBe(true));
    view.rerender(<CampaignsView {...props} campaignId="second" />);
    await waitFor(() => expect(pending.has("/api/campaigns/second")).toBe(true));
    expect(pending.get("/api/campaigns/first")!.signal.aborted).toBe(true);
    await act(async () => { pending.get("/api/campaigns/second")!.resolve(new Response(JSON.stringify({ ...detail, campaign: { ...summary, id: "second", name: "Second campaign" } }))); });
    expect(await screen.findByRole("heading", { name: "Second campaign" })).toBeInTheDocument();
    await act(async () => { pending.get("/api/campaigns/first")!.resolve(new Response(JSON.stringify({ ...detail, campaign: { ...summary, id: "first", name: "First campaign" } }))); });
    expect(screen.queryByRole("heading", { name: "First campaign" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Second campaign" })).toBeInTheDocument();
  });

  it("allows retry after a failed read and exposes actual campaign destinations in the resulting list", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Read unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ campaigns: [summary] }))));
    const user = userEvent.setup();
    render(<CampaignsView {...props} campaignId={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Read unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    const link = await screen.findByRole("link", { name: "Battery offer" });
    expect(link).toHaveAttribute("href", buildEntryLink("campaign", "historical"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search campaigns" }), "no matching campaign");
    expect(screen.queryByRole("link", { name: "Battery offer" })).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search campaigns" }));
    expect(screen.getByRole("link", { name: "Battery offer" })).toBeInTheDocument();
  });
});
