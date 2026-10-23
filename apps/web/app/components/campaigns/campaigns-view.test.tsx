// @vitest-environment jsdom
import styles from "./campaign-surface.module.css";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import type { CampaignDetail, CampaignRecipient, CampaignSummary } from "@/lib/campaigns";
import type { CampaignActivity, CampaignActivityDestination, CampaignActivityPerson, CampaignActivityTotals } from "@/lib/campaign-activity";
import type { MailCounts } from "@/lib/mail-types";
import { buildEntryLink } from "@/lib/workspace-links";
import { CampaignsView, type CampaignsViewProps } from "./campaigns-view";
import { CampaignPeopleSheet, type PeopleSource } from "./campaign-people-sheet";

const AT = "2026-09-29T10:30:00.000Z";
const summary: CampaignSummary = {
  id: "historical", name: "Battery offer", status: "sent", type: "bulk_trade", channel: "email", audience: "battery_buyers",
  launched_at: AT, last_invite_at: AT, audience_size: 115,
  metrics: { sent: 115, delivered: 113, opened: 24, clicked: 13, bounced: 3, opted_out: 0, replied: null },
  metrics_basis: "snapshot", metrics_observed_at: AT, recipient_count: 113, tracking_pending: 1,
};
const counts: MailCounts = { sent: 115, delivered: 113, bounced: 3, opened: 24, clicked: 13, unsubscribed: 2, replied: 1 };

function recipient(overrides: Partial<CampaignRecipient>): CampaignRecipient {
  return { send_id: "send", person_id: "person", person_name: "Contact", company_id: null, company_name: null,
    recipient_email: "contact@example.test", state: "accepted", accepted_at: AT, delivered_at: null, bounced_at: null,
    opened_at: null, clicked_at: null, last_synced_at: AT, tracking_pending: false, tracked: true, replied_at: null, subject: null,
    dismantler_id: null, dismantler_stage: null, listing_clicks: [], other_clicks: [], ...overrides };
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
  dismantler_funnel: null,
  details: { auction_slug: null, source_system: "reconciled", audience_raw: "battery_buyers", notes: "Approved historical outreach.",
    created_at: AT, updated_at: AT, objective: null, success_measure: null, message_version: "offer-v2", stock_snapshot_ref: null,
    sender_identity: null, reply_owner: null, reply_mailbox: null, approved_manifest_sha256: null, approved_by: null, approved_at: null, reviewed_at: null },
};
const props: CampaignsViewProps = { campaignId: "historical", onOpenCampaign: vi.fn(), onBack: vi.fn(), onNavigatePerson: vi.fn() };
const emptyTotals: CampaignActivityTotals = { redirect_events: 0, page_views: 0, sessions: 0, offer_events: 0, message_events: 0, buy_now_events: 0, redirect_recipients: 0, visited_recipients: 0, offer_recipients: 0, message_recipients: 0, buy_now_recipients: 0 };
const unavailable: CampaignActivity = { campaign_id: "historical", status: "unavailable", unavailable_reason: "provider_unavailable", observed_at: null, period_start: null, period_end: null, totals: null, destinations: [] };
function mockDetail(value: CampaignDetail & Partial<Record<keyof MailCounts, number | null>> = detail, activity: CampaignActivity = unavailable) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/activity") ? activity : { ...counts, ...value }))));
}

function activityPerson(personId: string, overrides: Partial<CampaignActivityPerson>): CampaignActivityPerson {
  return { person_id: personId, redirect_events: 0, page_views: 0, sessions: 0, offer_events: 0, message_events: 0, buy_now_events: 0, email_clicked_at: null, last_clicked_at: null, first_browser_at: null, last_browser_at: null, last_offer_at: null, last_message_at: null, last_buy_now_at: null, ...overrides };
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
  it("uses a quiet labelled loading state instead of placeholder rows", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const view = render(<CampaignsView {...props} campaignId={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading campaigns…");
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    view.rerender(<CampaignsView {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading campaign…");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("loads engagement into the redesigned campaign and shows returning readers independently of website availability", async () => {
    mockDetail(detail, { ...unavailable, engagement: [{
      recipient_key: "person:a", person_id: "person:a", person_name: "Ada", company_name: "North Batteries", recipient_email: "ada@example.test",
      total_opens: 3, flagged_opens: 0, return_sessions: 2, first_opened: AT, last_opened: AT,
      days_to_first_open: 1.5, late_opener: true, human_links_clicked: 2, flagged_clicks: 0, replied: false, likely_bot: false,
    }] });
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await screen.findByRole("table", { name: "Recipients" });
    await waitFor(() => expect(screen.getByLabelText("Returning readers")).toHaveTextContent("Returning readers1"));
    await user.click(screen.getByRole("tab", { name: "Engagement" }));
    const ranking = screen.getByRole("region", { name: "Engagement ranking" });
    expect(within(ranking).getByRole("link", { name: "Ada" })).toHaveAttribute("href", buildEntryLink("people", "person:a"));
    expect(within(ranking).getByText("Late opener")).toBeInTheDocument();
    expect(within(ranking).getByText(/Opens and clicks are observations/)).toBeInTheDocument();
  });
  it("reloads engagement and returning readers for the selected identity without retaining the old cohort", async () => {
    const pending = new Map<string, { signal: AbortSignal; resolve: (response: Response) => void }>();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      if (url.includes("/activity?")) {
        return new Promise<Response>((resolve) => pending.set(url, { signal: init.signal as AbortSignal, resolve }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ...detail, ...counts })));
    }));
    const supply = "/api/mail/campaigns/historical/activity?identity=supply&event=opened";
    const sales = "/api/mail/campaigns/historical/activity?identity=sales&event=opened";
    const view = render(<CampaignsView {...props} query="identity=supply&event=opened" />);
    await waitFor(() => expect(pending.has(supply)).toBe(true));
    view.rerender(<CampaignsView {...props} query="identity=sales&event=opened" />);
    await waitFor(() => expect(pending.has(sales)).toBe(true));
    expect(pending.get(supply)!.signal.aborted).toBe(true);
    await act(async () => pending.get(supply)!.resolve(new Response(JSON.stringify({ ...unavailable, engagement: [{ recipient_key: "stale", return_sessions: 9 }] }))));
    expect(screen.getByLabelText("Returning readers")).toHaveTextContent("Loading…");
    await act(async () => pending.get(sales)!.resolve(new Response(JSON.stringify({ ...unavailable, engagement: [{
      recipient_key: "person:b", person_id: "person:b", person_name: "Ben", company_name: "South Parts", recipient_email: "ben@example.test",
      total_opens: 1, flagged_opens: 0, return_sessions: 0, first_opened: AT, last_opened: AT,
      days_to_first_open: 0, late_opener: false, human_links_clicked: 0, flagged_clicks: 0, replied: true, likely_bot: false,
    }] }))));
    expect(screen.getByLabelText("Returning readers")).toHaveTextContent("Returning readers0");
    await userEvent.setup().click(screen.getByRole("tab", { name: "Engagement" }));
    const ranking = screen.getByRole("region", { name: "Engagement ranking" });
    expect(within(ranking).getByRole("link", { name: "Ben" })).toBeInTheDocument();
    expect(within(ranking).queryByRole("link", { name: "Ada" })).not.toBeInTheDocument();
    fireEvent.click(within(ranking).getByLabelText("Not replied"));
    expect(within(ranking).getByText("No recipients match this ranking.")).toBeInTheDocument();
  });

  it("uses the Mail header when embedded and forwards filters unchanged to list and detail", async () => {
    const query = "view=campaigns&identity=ari&event=clicked&crmOnly=true";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/historical") ? { ...detail, ...counts } : { items: [{ ...summary, ...counts }] }))));
    const view = render(<CampaignsView {...props} embedded campaignId={null} query={query} />);
    await screen.findByRole("list", { name: "Campaigns" });
    expect(screen.queryByRole("heading", { name: "Campaigns" })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(`/api/mail/campaigns?${query}`, expect.anything());
    view.rerender(<CampaignsView {...props} embedded query={query} />);
    await screen.findByRole("table", { name: "Recipients" });
    expect(fetch).toHaveBeenCalledWith(`/api/mail/campaigns/historical?${query}`, expect.anything());
  });
  it("keeps the list to one line with rates in tooltips, filtered by status, with no search box of its own when the host owns search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{ ...summary, ...counts }, { ...summary, id: "other", name: "Other offer", ...counts, mail_state: "retired" }] }))));
    render(<CampaignsView {...props} campaignId={null} search="" status="retired" />);
    const list = await screen.findByRole("list", { name: "Campaigns" });
    expect(screen.queryByRole("searchbox", { name: "Search campaigns" })).not.toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    const row = within(list).getAllByRole("listitem")[0];
    expect(row).toHaveTextContent("Other offer");
    expect(row.querySelector("[title^='Opened ']")).toHaveAttribute("title", "Opened 21.2%");
  });
  it("opens a campaign within the merged view without also opening a workspace tab", async () => {
    const outerNavigation = vi.fn();
    const openCampaign = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{ ...summary, ...counts }] }))));
    const user = userEvent.setup();
    render(<div onClick={outerNavigation}><CampaignsView {...props} campaignId={null} onOpenCampaign={openCampaign} /></div>);
    await user.click(await screen.findByRole("link", { name: "Battery offer" }));
    expect(openCampaign).toHaveBeenCalledWith("historical");
    expect(outerNavigation).not.toHaveBeenCalled();
  });
  it("renders each mail-log count separately in the list and detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/activity") ? unavailable : url === "/api/mail/campaigns" ? { items: [{ ...summary, ...counts }] } : { ...detail, ...counts, scanner_evidence: true, proxy_evidence: true, links: [{ id: "link", cta_key: "offer", destination_url: "https://example.test/offer", first_clicked_at: AT }] }))));
    const view = render(<CampaignsView {...props} campaignId={null} />);
    const list = await screen.findByRole("list", { name: "Campaigns" });
    const row = within(list).getAllByRole("listitem")[0];
    // One clean line: only the three headline metrics, plus status and date.
    for (const key of ["sent", "opened", "replied"] as const) {expect(within(row).getAllByText(key[0].toUpperCase() + key.slice(1), { exact: true }).find((node) => node.tagName === "DT")!.parentElement).toHaveTextContent(String(counts[key]));}
    for (const hidden of ["Delivered", "Bounced", "Clicked", "Unsubscribed"]) {expect(within(row).queryByText(hidden, { exact: true })).not.toBeInTheDocument();}
    view.rerender(<CampaignsView {...props} />);
    const metrics = await screen.findByRole("region", { name: "Campaign metrics" });
    for (const [key, value] of Object.entries(counts)) {expect(within(metrics).getByText(key[0].toUpperCase() + key.slice(1), { exact: true }).parentElement).toHaveTextContent(String(value));}
    await userEvent.setup().click(screen.getByText("About the numbers"));
    await userEvent.setup().click(screen.getByText("Tracked links"));
    expect(screen.getByRole("note")).toHaveTextContent("Scanner evidence: recorded · Proxy evidence: recorded");
    expect(within(screen.getByRole("region", { name: "Tracked links" })).getByRole("link", { name: "offer" })).toHaveAttribute("href", "https://example.test/offer");
  });
  it("filters real observations including listing-only clicks and intersects search without replacing its control", async () => {
    mockDetail();
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await screen.findByRole("table", { name: "Recipients" });
    expect(visiblePeople()).toEqual(["Ada", "Ben", "Cora", "Dev"]);
    const activity = screen.getByRole("group", { name: "Recipient activity" });
    await user.click(within(activity).getByRole("button", { name: "Clicked" }));
    expect(visiblePeople()).toEqual(["Ada"]);
    await user.click(within(activity).getByRole("button", { name: "Opened" }));
    expect(visiblePeople()).toEqual(["Ada"]);
    await user.click(within(activity).getByRole("button", { name: "Bounced" }));
    expect(visiblePeople()).toEqual(["Ben"]);
    await user.click(within(activity).getByRole("button", { name: "Tracking pending" }));
    expect(visiblePeople()).toEqual(["Cora"]);
    await user.click(within(activity).getByRole("button", { name: "All" }));
    const search = screen.getByRole("searchbox", { name: "Search recipients" });
    await user.type(search, "NORTH");
    expect(visiblePeople()).toEqual(["Ada"]);
    await user.click(within(activity).getByRole("button", { name: "Bounced" }));
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
    await userEvent.setup().click(screen.getByText("About the numbers"));
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

  it("shows replies, dismantler stages and the progress of a dismantler outreach campaign", async () => {
    mockDetail({ ...detail,
      campaign: { ...summary, type: "dismantler_outreach", metrics_basis: "ledger", metrics: { sent: 2, delivered: 2, opened: 1, clicked: 0, bounced: 0, opted_out: 0, replied: 1 } },
      dismantler_funnel: { emailed: 2, replied: 1, stages: { Talking: 2 } },
      recipients: [
        recipient({ send_id: "x", person_id: "p-x", person_name: "Reply Yard", replied_at: AT, subject: "Your Kona packs", dismantler_id: "dm_x", dismantler_stage: "Talking" }),
        recipient({ send_id: "y", person_id: "p-y", person_name: "Quiet Yard", subject: "Your Leaf packs", dismantler_id: "dm_y", dismantler_stage: "Talking" }),
      ] });
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    const progress = await screen.findByRole("region", { name: "Dismantler progress" });
    expect(progress).toHaveTextContent("Emailed 2");
    expect(progress).toHaveTextContent("Replied 1");
    expect(progress).toHaveTextContent("Talking 2");
    expect(within(screen.getByRole("region", { name: "Campaign metrics" })).getByText("Replied")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Dismantler" })).toBeInTheDocument();
    expect(screen.getByText("Your Kona packs")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Replied" }));
    expect(screen.getByRole("link", { name: "Reply Yard" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Quiet Yard" })).not.toBeInTheDocument();
  });

  it("shows Gmail-sent outreach as sent and its delivery, opens and clicks as not tracked", async () => {
    mockDetail({ ...detail,
      campaign: { ...summary, type: "dismantler_outreach", channel: "email-gmail", metrics_basis: "ledger", tracking_pending: 0,
        metrics: { sent: 1, delivered: null, opened: null, clicked: null, bounced: null, opted_out: 0, replied: 0 } },
      dismantler_funnel: { emailed: 1, replied: 0, stages: { Talking: 1 } },
      recipients: [recipient({ send_id: "g", person_id: "p-g", person_name: "Gmail Yard", tracked: false, last_synced_at: null,
        dismantler_id: "dm_g", dismantler_stage: "Talking" })] });
    render(<CampaignsView {...props} />);
    const metrics = await screen.findByRole("region", { name: "Campaign metrics" });
    expect(within(metrics).getAllByText("Not tracked")).toHaveLength(3);
    // Untracked values read as a dash on screen, with the words kept for screen readers.
    expect(within(metrics).getAllByText("Not tracked")[0].parentElement).toHaveTextContent("—");
    expect(within(metrics).queryByText("Unknown")).not.toBeInTheDocument();
    const row = screen.getByText("Sent from Gmail").closest("tr")!;
    expect(within(row).getAllByText("Not tracked")).toHaveLength(2);
    expect(within(row).queryByText("Tracking pending")).not.toBeInTheDocument();
    expect(within(metrics).queryByText("Tracking pending")).not.toBeInTheDocument();
  });

  it("renders unknown ledger totals without losing available observations on pending recipients", async () => {
    mockDetail({ ...detail, sent: 1, delivered: null, opened: 1, clicked: 1, bounced: null, unsubscribed: null, replied: null, campaign: { ...summary, metrics_basis: "ledger", metrics: { sent: 1, delivered: null, opened: 1, clicked: 1, bounced: null, opted_out: null, replied: 0 } },
      recipients: [recipient({ person_name: "Observed while pending", tracking_pending: true, last_synced_at: null, opened_at: AT,
        listing_clicks: [{ listing_id: "internal-listing-1", label: "Nissan Leaf 40 kWh", first_clicked_at: AT }] })] });
    render(<CampaignsView {...props} />);
    const metrics = await screen.findByRole("region", { name: "Campaign metrics" });
    expect(within(metrics).getAllByText("1", { exact: true })).toHaveLength(3);
    expect(within(metrics).getAllByText("Unknown", { exact: true })).toHaveLength(4);
    const row = screen.getByRole("link", { name: "Observed while pending" }).closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    expect(cells[2]).toHaveTextContent("No reply yet");
    expect(cells[3].querySelector("time")).toHaveAttribute("datetime", AT);
    expect(cells[4].querySelector("time")).toHaveAttribute("datetime", AT);
    expect(within(row).queryByText("Not observed")).not.toBeInTheDocument();
    expect(within(row).getByText("Nissan Leaf 40 kWh")).toBeInTheDocument();
  });

  it("paginates the ledger, searches across all pages, and retains search when switching tabs", async () => {
    mockDetail({ ...detail, recipients: Array.from({ length: 30 }, (_, index) => recipient({ send_id: `s-${index}`, person_id: `p-${index}`, person_name: `Contact ${index + 1}` })) });
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await screen.findByRole("table", { name: "Recipients" });
    expect(visiblePeople()).toEqual(Array.from({ length: 25 }, (_, index) => `Contact ${index + 1}`));
    await user.click(screen.getByRole("button", { name: "Next" }));
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
    const audit = screen.getByText("Audit").closest("details")!;
    expect(audit.open).toBe(false);
    await user.click(within(audit).getByText("Audit"));
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
    await waitFor(() => expect(pending.has("/api/mail/campaigns/first")).toBe(true));
    view.rerender(<CampaignsView {...props} campaignId="second" />);
    await waitFor(() => expect(pending.has("/api/mail/campaigns/second")).toBe(true));
    expect(pending.get("/api/mail/campaigns/first")!.signal.aborted).toBe(true);
    await act(async () => { pending.get("/api/mail/campaigns/second")!.resolve(new Response(JSON.stringify({ ...counts, ...detail, campaign: { ...summary, id: "second", name: "Second campaign" } }))); });
    expect(await screen.findByRole("heading", { name: "Second campaign" })).toBeInTheDocument();
    await act(async () => { pending.get("/api/mail/campaigns/first")!.resolve(new Response(JSON.stringify({ ...counts, ...detail, campaign: { ...summary, id: "first", name: "First campaign" } }))); });
    expect(screen.queryByRole("heading", { name: "First campaign" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Second campaign" })).toBeInTheDocument();
  });

  it("allows retry after a failed read and exposes actual campaign destinations in the resulting list", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Read unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...summary, ...counts }] }))));
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
  it.each<PeopleSource>(["email", "click", "browser", "offer", "message", "buy_now"])("offers a collapsed source-specific evidence note for %s", async (source) => {
    const user = userEvent.setup();
    render(<CampaignPeopleSheet destination="Battery listing" source={source} count={0} rows={[]} onNavigatePerson={vi.fn()} />);
    await user.click(screen.getByRole("button"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass(styles.surface);
    expect(document.querySelector(".bt-preview")).toBeNull();
    const summary = within(dialog).getByText("About these numbers");
    const disclosure = summary.closest("details")!;
    expect(disclosure.open).toBe(false);
    await user.click(summary);
    expect(disclosure.open).toBe(true);
    const note = within(disclosure).getByText(/Unknown means website evidence/);
    expect(note).toBeVisible();
    expect(note).not.toHaveClass("sr-only");
    expect(note).toHaveTextContent(source === "email" ? "Counts and latest times are separate PostHog observations, not Postmark totals." : "PostHog observations for assigned destination links.");
    expect(note).toHaveTextContent("Unknown means website evidence is unavailable or unmapped.");
    expect(note).toHaveTextContent("forwarded links do not verify the recipient");
    expect(note).toHaveTextContent("missing consented views do not prove inactivity");
  });

  it("frames every campaign table without removing its scroll container", async () => {
    mockDetail({ ...detail, other_destinations: [{ cta_key: "grid", label: "General stock grid" }] });
    const user = userEvent.setup();
    const view = render(<CampaignsView {...props} />);
    const recipients = await screen.findByRole("table", { name: "Recipients" });
    expect(view.container.firstElementChild).toHaveClass(styles.surface);
    expect(screen.getByRole("heading", { name: "Battery offer" }).closest(`.${styles.surface}`)).toHaveClass(styles.surface);
    expect(document.querySelector(".bt-preview")).toBeNull();
    expect(recipients.parentElement?.parentElement).toHaveClass(styles.tableFrame);
    expect(recipients.parentElement).toHaveClass("overflow-x-auto");
    await openListings(user);
    for (const name of ["Listings", "Other destinations"]) {
      const table = screen.getByRole("table", { name });
      expect(table.parentElement?.parentElement).toHaveClass(styles.tableFrame);
      expect(table.parentElement).toHaveClass("overflow-x-auto");
    }
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Email clicks, 1" }));
    const people = within(screen.getByRole("dialog")).getByRole("table", { name: "Destination people" });
    expect(people.parentElement?.parentElement).toHaveClass(styles.tableFrame);
    expect(people.parentElement).toHaveClass("overflow-auto");
  });
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

  it("shows repeated redirect counts and latest click/view without replacing the historical email cohort", async () => {
    const lastClick = "2026-09-30T16:00:00.000Z";
    const lastView = "2026-09-30T17:00:00.000Z";
    mockDetail(detail, availableActivity([destination({ redirect_events: 5, redirect_recipients: 2, people: [
      activityPerson("person:a", { redirect_events: 3, last_clicked_at: lastClick, page_views: 2, last_browser_at: lastView }),
      activityPerson("person:d", { redirect_events: 2, last_clicked_at: AT }),
    ] })]));
    const user = userEvent.setup();
    render(<CampaignsView {...props} />);
    await openListings(user);
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Email clicks, 1" }));
    expect(sheetPeople()).toEqual(["Ada"]);
    const row = within(screen.getByRole("dialog")).getByRole("link", { name: "Ada" }).closest("tr")!;
    expect(within(row).getAllByRole("cell")[1]).toHaveTextContent("3");
    expect([...row.querySelectorAll("time")].map((time) => time.dateTime)).toEqual([lastClick, lastView]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Tracked clicks, 5" }));
    expect(sheetPeople()).toEqual(["Ada", "Dev"]);
    const redirectOnly = within(screen.getByRole("dialog")).getByRole("link", { name: "Dev" }).closest("tr")!;
    expect(within(redirectOnly).getAllByRole("cell")[1]).toHaveTextContent("2");
    expect(redirectOnly.querySelector("time")).toHaveAttribute("datetime", AT);
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
    await user.click(screen.getByText("About the numbers"));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "PostHog website evidence" })).getByRole("status")).not.toHaveTextContent(/Loading/));
    await openListings(user);
    const row = within(screen.getByRole("table", { name: "Listings" })).getByText("Nissan Leaf 40 kWh").closest("tr")!;
    expect(within(row).queryByRole("button", { name: /Browser activity/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Nissan Leaf 40 kWh: Email clicks, 1" }));
    expect(sheetPeople()).toEqual(["Ada"]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "General stock grid: Email clicks, 1" }));
    expect(sheetPeople()).toEqual(["Ada"]);
    expect(within(screen.getByRole("dialog")).getAllByRole("cell").slice(1).map((cell) => cell.textContent)).toEqual(["Unknown", "Unknown", "Unknown"]);
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
    await waitFor(() => expect(pending.has("/api/mail/campaigns/first/activity")).toBe(true));
    view.rerender(<CampaignsView {...props} campaignId="second" />);
    await waitFor(() => expect(pending.has("/api/mail/campaigns/second/activity")).toBe(true));
    expect(pending.get("/api/mail/campaigns/first/activity")!.signal.aborted).toBe(true);
    await act(async () => pending.get("/api/mail/campaigns/first/activity")!.resolve(new Response(JSON.stringify({ ...availableActivity([destination({ visited_recipients: 99 })]), campaign_id: "first" }))));
    expect(screen.getByRole("heading", { name: "second campaign" })).toBeInTheDocument();
    await openListings(user);
    expect(screen.queryByRole("button", { name: /Browser activity, 99/ })).not.toBeInTheDocument();
    await act(async () => pending.get("/api/mail/campaigns/second/activity")!.resolve(new Response(JSON.stringify({ ...availableActivity([destination({ visited_recipients: 2 })]), campaign_id: "second" }))));
    expect(await screen.findByRole("button", { name: "Nissan Leaf 40 kWh: Browser activity, 2" })).toBeInTheDocument();
  });
});
