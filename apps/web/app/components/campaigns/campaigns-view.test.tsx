// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import type { CampaignDetail, CampaignRecipient, CampaignSummary } from "@/lib/campaigns";
import type { CampaignActivity, CampaignActivityDestination, CampaignActivityPerson, CampaignActivityTotals } from "@/lib/campaign-activity";
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
    opened_at: null, clicked_at: null, last_synced_at: AT, tracking_pending: false, listing_clicks: [], other_clicks: [], ...overrides };
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
    { listing_id: "internal-listing-1", label: "Nissan Leaf 40 kWh", url: "https://rebattery.io/marketplace/auctions/nissan-leaf", recipients: 3, clicked_recipients: 1 },
    { listing_id: "internal-listing-2", label: "Renault Zoe 52 kWh", url: null, recipients: 2, clicked_recipients: 0 },
  ],
  other_destinations: [],
  details: { auction_slug: null, source_system: "reconciled", audience_raw: "battery_buyers", notes: "Approved historical outreach.",
    created_at: AT, updated_at: AT, objective: null, success_measure: null, message_version: "offer-v2", stock_snapshot_ref: null,
    sender_identity: null, reply_owner: null, reply_mailbox: null, approved_manifest_sha256: null, approved_by: null, approved_at: null, reviewed_at: null },
};
const props: CampaignsViewProps = { campaignId: "historical", onOpenCampaign: vi.fn(), onBack: vi.fn(), onNavigatePerson: vi.fn() };
const emptyTotals: CampaignActivityTotals = { redirect_events: 0, page_views: 0, sessions: 0, offer_events: 0, message_events: 0, buy_now_events: 0, redirect_recipients: 0, visited_recipients: 0, offer_recipients: 0, message_recipients: 0, buy_now_recipients: 0 };
const unavailable: CampaignActivity = { campaign_id: "historical", status: "unavailable", unavailable_reason: "provider_unavailable", observed_at: null, period_start: null, period_end: null, totals: null, destinations: [] };
function mockDetail(value: CampaignDetail = detail, activity: CampaignActivity = unavailable) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/activity") ? activity : value))));
}

function activityPerson(personId: string, overrides: Partial<CampaignActivityPerson>): CampaignActivityPerson {
  return { person_id: personId, redirect_events: 0, page_views: 0, sessions: 0, offer_events: 0, message_events: 0, buy_now_events: 0, email_clicked_at: null, first_browser_at: null, last_browser_at: null, last_offer_at: null, last_message_at: null, last_buy_now_at: null, ...overrides };
}
function destination(overrides: Partial<CampaignActivityDestination>): CampaignActivityDestination {
  return { ...emptyTotals, cta_key: "nissan", listing_id: "internal-listing-1", label: "Nissan Leaf 40 kWh", recipient_count: 4, email_clicked_recipients: 1, people: [], ...overrides };
}
function availableActivity(destinations: CampaignActivityDestination[]): CampaignActivity {
  return { ...unavailable, status: "available", unavailable_reason: null, observed_at: AT, period_start: "2026-09-24T15:00:00.000Z", period_end: "2026-10-02T00:00:00.000Z", totals: { ...emptyTotals, visited_recipients: 3, sessions: 4, page_views: 6, offer_events: 2, message_events: 2, buy_now_events: 1 }, destinations };
}

async function openListings(user: UserEvent) {
  await screen.findByRole("table", { name: "Recipients" });
  await user.click(screen.getByRole("tab", { name: "Listings" }));
}
function sheetPeople() {
  return within(screen.getByRole("dialog")).getAllByRole("link").map((link) => link.textContent);
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

describe("Campaign destination evidence sheets", () => {
  it("isolates accepted destination clicks from provider-wide and other-listing observations", async () => {
    const earlier = "2026-09-25T10:00:00.000Z";
    mockDetail({ ...detail, recipients: [
      { ...recipients[0], clicked_at: earlier },
      { ...recipients[1], clicked_at: AT, listing_clicks: [{ listing_id: "internal-listing-2", label: "Renault Zoe 52 kWh", first_clicked_at: AT }] },
      { ...recipients[2], clicked_at: AT },
      { ...recipients[3], state: "failed", accepted_at: null, listing_clicks: recipients[0].listing_clicks },
    ] });
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await openListings(user);
    const trigger = screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Email clicks, 1" });
    await user.click(trigger);
    expect(sheetPeople()).toEqual(["Ada"]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("North Batteries")).toBeInTheDocument();
    expect(within(dialog).getByText("ada@example.test")).toBeInTheDocument();
    expect(dialog.querySelector("time")).toHaveAttribute("datetime", AT);
    expect(within(dialog).getByRole("link", { name: "Ada" })).toHaveAttribute("href", buildEntryLink("people", "person:a"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Renault Zoe 52 kWh: Email clicks, 1" }));
    expect(sheetPeople()).toEqual(["Ben"]);
  });

  it("searches all sheet pages by identity and resets search and paging between destinations", async () => {
    const many = Array.from({ length: 30 }, (_, index) => recipient({ send_id: `s-${index}`, person_id: `p-${index}`, person_name: `Contact ${index + 1}`, company_name: index === 29 ? "Last Batteries" : "Parts", recipient_email: `contact${index + 1}@example.test`, listing_clicks: recipients[0].listing_clicks }));
    mockDetail({ ...detail, recipients: many });
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await openListings(user);
    const trigger = screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Email clicks, 30" });
    await user.click(trigger);
    expect(sheetPeople()).toEqual(Array.from({ length: 25 }, (_, index) => `Contact ${index + 1}`));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Next" }));
    expect(sheetPeople()).toEqual(["Contact 26", "Contact 27", "Contact 28", "Contact 29", "Contact 30"]);
    const search = within(screen.getByRole("dialog")).getByRole("searchbox");
    await user.type(search, "last batteries");
    expect(sheetPeople()).toEqual(["Contact 30"]);
    await user.clear(search);
    await user.type(search, "CONTACT2@EXAMPLE.TEST");
    expect(sheetPeople()).toEqual(["Contact 2"]);
    await user.click(screen.getByRole("button", { name: "Close people sheet" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Renault Zoe 52 kWh: Email clicks, 0" }));
    expect(within(screen.getByRole("dialog")).getByRole("searchbox")).toHaveValue("");
    expect(within(screen.getByRole("dialog")).queryByRole("link")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(trigger);
    expect(within(screen.getByRole("dialog")).getByRole("searchbox")).toHaveValue("");
    expect(sheetPeople()[0]).toBe("Contact 1");
  });

  it("closes before in-app People navigation and preserves modifier-click destinations without leaving a modal", async () => {
    mockDetail();
    const navigate = vi.fn(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const user = userEvent.setup();
    render(<CampaignsView {...props} onNavigatePerson={navigate} />);
    await openListings(user);
    const trigger = screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Email clicks, 1" });
    await user.click(trigger);
    await user.click(within(screen.getByRole("dialog")).getByRole("link", { name: "Ada" }));
    expect(navigate).toHaveBeenCalledWith("person:a");
    navigate.mockClear();
    await user.click(trigger);
    const link = within(screen.getByRole("dialog")).getByRole("link", { name: "Ada" });
    expect(link).toHaveAttribute("href", buildEntryLink("people", "person:a"));
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("filters browser and each submission source independently within the chosen destination", async () => {
    const activity = availableActivity([
      destination({ visited_recipients: 2, sessions: 3, page_views: 3, offer_events: 2, offer_recipients: 2, message_events: 2, message_recipients: 1, buy_now_events: 1, buy_now_recipients: 1, people: [
        activityPerson("person:a", { page_views: 1, sessions: 1, first_browser_at: AT, last_browser_at: AT }),
        activityPerson("person:b", { offer_events: 1, last_offer_at: AT }),
        activityPerson("person:c", { page_views: 2, sessions: 2, first_browser_at: AT, last_browser_at: AT, offer_events: 1, last_offer_at: AT }),
        activityPerson("person:d", { message_events: 2, buy_now_events: 1, last_message_at: "2026-09-25T11:00:00.000Z", last_buy_now_at: "2026-09-25T12:00:00.000Z" }),
      ] }),
      destination({ cta_key: "renault", listing_id: "internal-listing-2", label: "Renault Zoe 52 kWh", visited_recipients: 1, page_views: 3, sessions: 1, people: [activityPerson("person:b", { page_views: 3, sessions: 1, first_browser_at: AT, last_browser_at: AT })] }),
      destination({ cta_key: "grid", listing_id: null, label: "General stock grid" }),
    ]);
    mockDetail({ ...detail, other_destinations: [{ cta_key: "grid", label: "General stock grid" }] }, activity);
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await openListings(user);
    expect(screen.getByRole("table", { name: "Other destinations" })).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Listings" })).queryByText("General stock grid")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Browser activity, 2" }));
    expect(sheetPeople()).toEqual(["Ada", "Cora"]);
    const browserRow = within(screen.getByRole("dialog")).getByRole("link", { name: "Cora" }).closest("tr")!;
    expect(within(browserRow).getAllByRole("cell").slice(1, 3).map((cell) => cell.textContent)).toEqual(["2", "2"]);
    expect(browserRow.querySelectorAll("time")).toHaveLength(2);
    await user.type(within(screen.getByRole("dialog")).getByRole("searchbox"), "Ada");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Offers, 2" }));
    expect(sheetPeople()).toEqual(["Ben", "Cora"]);
    expect(within(screen.getByRole("dialog")).getByRole("searchbox")).toHaveValue("");
    const offerRow = within(screen.getByRole("dialog")).getByRole("link", { name: "Ben" }).closest("tr")!;
    expect(within(offerRow).getAllByRole("cell")[1]).toHaveTextContent("1");
    expect(offerRow.querySelector("time")).toHaveAttribute("datetime", AT);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Messages, 2" }));
    expect(sheetPeople()).toEqual(["Dev"]);
    expect(screen.getByRole("dialog").querySelector("time")).toHaveAttribute("datetime", "2026-09-25T11:00:00.000Z");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Buy now, 1" }));
    expect(sheetPeople()).toEqual(["Dev"]);
    expect(screen.getByRole("dialog").querySelector("time")).toHaveAttribute("datetime", "2026-09-25T12:00:00.000Z");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Renault Zoe 52 kWh: Browser activity, 1" }));
    expect(sheetPeople()).toEqual(["Ben"]);
  });

  it.each(["http", "unmapped", "unavailable"] as const)("retains the email ledger and renders unknown website counts for %s evidence", async (failure) => {
    const nativeDetail: CampaignDetail = { ...detail,
      other_destinations: [{ cta_key: "grid", label: "General stock grid" }],
      recipients: [{ ...recipients[0], other_clicks: [{ cta_key: "grid", label: "General stock grid", first_clicked_at: AT }] }, ...recipients.slice(1)],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/activity")
      ? failure === "http" ? new Response("Unavailable", { status: 503 }) : new Response(JSON.stringify({ ...unavailable, status: failure }))
      : new Response(JSON.stringify(nativeDetail))));
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await screen.findByRole("table", { name: "Recipients" });
    expect(visiblePeople()).toEqual(["Ada", "Ben", "Cora", "Dev"]);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "PostHog website evidence" })).getByRole("status")).not.toHaveTextContent(/Loading/));
    await openListings(user);
    const row = within(screen.getByRole("table", { name: "Listings" })).getByText("Nissan Leaf 40 kWh").closest("tr")!;
    expect(within(row).queryByRole("button", { name: /Browser activity/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Email clicks, 1" }));
    expect(sheetPeople()).toEqual(["Ada"]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "General stock grid: Email clicks, 1" }));
    expect(sheetPeople()).toEqual(["Ada"]);
    expect(screen.getByRole("dialog").querySelector("time")).toHaveAttribute("datetime", AT);
  });

  it("distinguishes a mapped available zero from an unmapped listing", async () => {
    mockDetail(detail, { ...availableActivity([destination({})]), totals: emptyTotals });
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await openListings(user);
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Browser activity, 0" }));
    expect(within(screen.getByRole("dialog")).queryByRole("link")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    const unmappedRow = within(screen.getByRole("table", { name: "Listings" })).getByText("Renault Zoe 52 kWh").closest("tr")!;
    expect(within(unmappedRow).queryByRole("button", { name: /Browser activity/ })).not.toBeInTheDocument();
  });

  it("aborts old campaign website evidence and never displays its late payload in the next campaign", async () => {
    const pending = new Map<string, { signal: AbortSignal; resolve: (response: Response) => void }>();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith("/activity")) {
        return new Promise<Response>((resolve) => pending.set(url, { signal: init.signal as AbortSignal, resolve }));
      }
      const id = url.split("/").at(-1)!;
      return Promise.resolve(new Response(JSON.stringify({ ...detail, campaign: { ...summary, id, name: `${id} campaign` } })));
    }));
    const user = userEvent.setup();
    const view = render(<CampaignsView {...props} campaignId="first" />);
    await waitFor(() => expect(pending.has("/api/campaigns/first/activity")).toBe(true));
    view.rerender(<CampaignsView {...props} campaignId="second" />);
    await waitFor(() => expect(pending.has("/api/campaigns/second/activity")).toBe(true));
    expect(pending.get("/api/campaigns/first/activity")!.signal.aborted).toBe(true);
    await act(async () => pending.get("/api/campaigns/first/activity")!.resolve(new Response(JSON.stringify({ ...availableActivity([destination({ visited_recipients: 99 })]), campaign_id: "first" }))));
    expect(screen.getByRole("heading", { name: "second campaign" })).toBeInTheDocument();
    await openListings(user);
    expect(screen.queryByRole("button", { name: /Browser activity, 99/ })).not.toBeInTheDocument();
    await act(async () => pending.get("/api/campaigns/second/activity")!.resolve(new Response(JSON.stringify({ ...availableActivity([destination({ visited_recipients: 2 })]), campaign_id: "second" }))));
    expect(await screen.findByRole("button", { name: "Nissan Leaf 40 kWh: Browser activity, 2" })).toBeInTheDocument();
  });
});
