// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonProfile } from "./person-profile";

function buildPersonResponse(id: string, name: string) {
  return {
    person: {
      id,
      name,
      email: `${id}@example.com`,
      company_name: null,
      phone: null,
      status: null,
      source: null,
      strength_score: null,
      strength_label: "—",
      strength_color: "#999999",
      last_interaction_at: null,
      job_title: null,
      linkedin_url: null,
      avatar_url: null,
      notes: null,
      created_at: null,
      updated_at: null,
    },
    company: null,
    derived_website: null,
    threads: [],
    events: [],
    interactions_summary: {
      email_count: 0,
      meeting_count: 0,
      total: 0,
      last_outbound_at: null,
      last_inbound_at: null,
    },
    campaigns: [],
    campaign_summary: { sent: 0, delivered: 0, opened: 0, clicked: 0, tracking_pending: 0 },
    listing_engagement: [],
  };
}

function buildCampaignSend(sendId: string, campaignId = "campaign-1", name = "Auction pilot") {
  return {
    send_id: sendId, campaign_id: campaignId, campaign_name: name,
    listing_id: "listing-fpt", listing_title: "FPT battery modules", listing_url: "https://rebattery.io/marketplace/auctions/fpt-modules",
    recipient_email: "alice@example.com", state: "accepted", pitch_count: 2,
    accepted_at: "2026-09-23T10:00:00Z" as string | null,
    delivered_at: "2026-09-23T10:00:10Z" as string | null,
    bounced_at: null as string | null,
    provider_opened_at: null as string | null,
    provider_link_clicked_at: null as string | null,
    last_synced_at: "2026-09-23T11:00:00Z" as string | null,
    links: [] as Array<{
      cta_key: string; listing_id: string | null; listing_title?: string | null;
      listing_url?: string | null; first_clicked_at: string | null;
    }>,
  };
}

function mockFetchForPerson() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const match = url.match(/\/api\/crm\/people\/([^/?]+)/);
      const id = match ? decodeURIComponent(match[1]) : "unknown";
      return Promise.resolve(
        new Response(JSON.stringify(buildPersonResponse(id, `Person ${id}`)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
}

function getActiveTabLabel(): string | null {
  const navigation = screen.getByRole("navigation", { name: "Profile sections" });
  return within(navigation).getByRole("button", { current: "page" }).textContent?.trim() ?? null;
}

describe("PersonProfile tab reset on entry change", () => {
  let fetchSpy: ReturnType<typeof mockFetchForPerson>;

  beforeEach(() => {
    fetchSpy = mockFetchForPerson();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("resets the active tab to Overview when switching from one person to another", async () => {
    // Regression: with the same React instance reused across `personId`
    // changes, `localTab` used to leak the previously-selected tab into
    // the new person whenever the URL didn't carry an explicit
    // `profileTab`. Reset on prop change is now mandatory.
    const user = userEvent.setup();
    const { rerender } = render(
      <PersonProfile personId="alice" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Person alice")).toBeInTheDocument();
    });
    expect(getActiveTabLabel()).toBe("Overview");

    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(getActiveTabLabel()).toBe("Notes");

    rerender(<PersonProfile personId="bob" />);

    await waitFor(() => {
      expect(screen.getByText("Person bob")).toBeInTheDocument();
    });
    // Without the reset guard, Notes would still be active here because
    // the React instance is reused and `localTab` survives the prop change.
    expect(getActiveTabLabel()).toBe("Overview");
  });

  it("respects an explicit activeTab prop on the new entry (URL-supplied profileTab still wins)", async () => {
    // Reset only applies to the local fallback. If the parent says the
    // new entry should open on a specific tab via the controlled prop,
    // honor that immediately on first paint.
    const { rerender } = render(<PersonProfile personId="alice" />);
    await waitFor(() => {
      expect(screen.getByText("Person alice")).toBeInTheDocument();
    });

    rerender(<PersonProfile personId="bob" activeTab="emails" />);
    await waitFor(() => {
      expect(screen.getByText("Person bob")).toBeInTheDocument();
    });
    expect(getActiveTabLabel()).toBe("Emails");
  });

  it("groups sends by campaign ID, preserves backend totals, and reveals only the activated campaign", async () => {
    const user = userEvent.setup();
    const clickedAt = "2026-09-23T10:02:00Z";
    const openedAt = "2026-09-23T10:01:00Z";
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ...buildPersonResponse("alice", "Person alice"),
      campaign_summary: { sent: 9, delivered: 8, opened: 5, clicked: 3, tracking_pending: 0 },
      listing_engagement: [{ listing_id: "listing-fpt", listing_title: "FPT battery modules", cta_key: "FPT", clicked_updates: 2 }],
      campaigns: [
        {
          ...buildCampaignSend("send-new"), accepted_at: "2026-09-24T10:00:00Z",
          provider_opened_at: openedAt, provider_link_clicked_at: "2026-09-23T10:04:00Z",
          links: [
            { cta_key: "FPT", listing_id: "listing-fpt", listing_title: "FPT battery modules", first_clicked_at: clickedAt },
            { cta_key: "grid", listing_id: null, first_clicked_at: clickedAt },
          ],
        },
        {
          ...buildCampaignSend("send-old"),
          links: [{ cta_key: "sourcing", listing_id: null, first_clicked_at: null }],
        },
        {
          ...buildCampaignSend("send-other", "campaign-2"),
          links: [{ cta_key: "other-technical-key", listing_id: null, first_clicked_at: null }],
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<PersonProfile personId="alice" activeTab="campaigns" />);

    const summary = await screen.findByRole("region", { name: "Campaign engagement" });
    const metric = (label: string) => within(summary).getByText(label, { selector: "dt" }).parentElement!;
    expect(within(metric("Sent")).getByText("9", { selector: "dd" })).toBeInTheDocument();
    expect(within(metric("Delivered")).getByText("8 of 9", { selector: "dd" })).toBeInTheDocument();
    expect(within(metric("Opened")).getByText("5 of 9", { selector: "dd" })).toBeInTheDocument();
    expect(within(metric("Clicked")).getByText("3 of 9", { selector: "dd" })).toBeInTheDocument();
    expect(getActiveTabLabel()).toBe("Campaigns2");
    const table = screen.getByRole("table", { name: "Campaign results" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText(/2 sends/)).toBeInTheDocument();
    expect(rows[1].querySelector("time")?.dateTime).toBe("2026-09-24T10:00:00Z");
    expect(rows[1]).toHaveTextContent("1 observed · 1 not observed");
    expect(screen.queryByRole("table", { name: /Destination activity/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Listing engagement" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /FPT battery modules/ })).not.toBeInTheDocument();

    const buttons = screen.getAllByRole("button", { name: "Show activity for Auction pilot" });
    buttons[0].focus();
    await user.keyboard("{Enter}");
    expect(buttons[0]).toHaveAttribute("aria-expanded", "true");
    expect(buttons[1]).toHaveAttribute("aria-expanded", "false");
    const activity = screen.getByRole("region", { name: "Activity for Auction pilot" });
    expect(activity.id).toBe(buttons[0].getAttribute("aria-controls"));
    const history = within(activity).getByRole<HTMLTableElement>("table", { name: "Send history for Auction pilot" });
    const sendRows = Array.from(history.tBodies[0].rows);
    expect(sendRows[0].cells[0].querySelector("time")?.dateTime).toBe("2026-09-24T10:00:00Z");
    expect(sendRows[2].cells[0].querySelector("time")?.dateTime).toBe("2026-09-23T10:00:00Z");
    const destinations = within(activity).getAllByRole("table", { name: /Destination activity/ });
    expect(within(destinations[0]).getByText("All auctions")).toBeInTheDocument();
    expect(within(destinations[1]).getByText("Sourcing form")).toBeInTheDocument();
    expect(within(destinations[1]).getByText("Not observed")).toBeInTheDocument();
    expect(screen.queryByText("other-technical-key")).not.toBeInTheDocument();
    expect(screen.queryByText("send-new")).not.toBeInTheDocument();
    expect(screen.queryByText("campaign-1")).not.toBeInTheDocument();
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
    const observedTimes = Array.from(sendRows[0].cells[3].querySelectorAll("time"));
    expect(observedTimes.map((time) => time.dateTime)).toEqual([clickedAt]);

    await user.keyboard(" ");
    expect(buttons[0]).toHaveFocus();
    expect(buttons[0]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Activity for Auction pilot" })).not.toBeInTheDocument();

    await user.click(screen.getByText("Listings across updates"));
    const listingRows = within(screen.getByRole("table", { name: "Listing engagement" })).getAllByRole("row");
    expect(within(listingRows[1]).getByRole("cell", { name: "2" })).toBeInTheDocument();
    expect(within(listingRows[1]).getByRole("cell", { name: "FPT battery modules" })).toBeInTheDocument();
  });

  it.each(["2026-09-23T10:00:00Z", null])("keeps accepted unsynced evidence unknown with acceptance timestamp %s, without treating click as open", async (acceptedAt) => {
    const user = userEvent.setup();
    const clickedAt = "2026-09-23T10:02:00Z";
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ...buildPersonResponse("alice", "Person alice"),
      campaign_summary: { sent: 1, delivered: 0, opened: 0, clicked: 1, tracking_pending: 1 },
      campaigns: [{
        ...buildCampaignSend("send-pending", "campaign-1", "Pending update"),
        listing_id: "", accepted_at: acceptedAt, delivered_at: null, last_synced_at: null,
        links: [
          { cta_key: "grid", listing_id: null, first_clicked_at: clickedAt },
          { cta_key: "FPT", listing_id: "listing-fpt", first_clicked_at: null },
        ],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<PersonProfile personId="alice" activeTab="campaigns" />);
    const button = await screen.findByRole("button", { name: "Show activity for Pending update" });
    expect(screen.getByRole("status")).toHaveTextContent(/1 sent update/);
    const row = button.closest("tr")!;
    if (acceptedAt) {
      expect(row.cells[1].querySelector("time")?.dateTime).toBe(acceptedAt);
    } else {
      expect(row.cells[1]).toHaveTextContent("Date unknown");
    }
    expect(row.cells[2]).toHaveTextContent("Unconfirmed");
    expect(row.cells[3]).toHaveTextContent("Unknown");
    expect(row.cells[4]).toHaveTextContent("Observed");
    expect(row.cells[4].querySelector("time")?.dateTime).toBe(clickedAt);
    await user.click(button);
    const links = within(screen.getByRole("table", { name: /Destination activity/ })).getAllByRole("row").slice(1);
    expect(links[0].querySelector("time")?.dateTime).toBe(clickedAt);
    expect(within(links[1]).getByText("Unknown")).toBeInTheDocument();
  });

  it("retains observed, unknown and unsent send states in a mixed campaign and preserves bounce and delivery evidence", async () => {
    const user = userEvent.setup();
    const clickedAt = "2026-09-23T10:02:00Z";
    const bouncedAt = "2026-09-23T10:00:20Z";
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ...buildPersonResponse("alice", "Person alice"),
      campaigns: [
        { ...buildCampaignSend("bounced"), bounced_at: bouncedAt, provider_link_clicked_at: clickedAt },
        { ...buildCampaignSend("pending"), delivered_at: null, last_synced_at: null },
        { ...buildCampaignSend("unsent"), state: "queued", accepted_at: null, delivered_at: null, last_synced_at: null },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<PersonProfile personId="alice" activeTab="campaigns" />);
    const button = await screen.findByRole("button", { name: "Show activity for Auction pilot" });
    const row = button.closest("tr")!;
    expect(row.cells[2]).toHaveTextContent("1 bounced · 1 unconfirmed · 1 not sent");
    expect(row.cells[3]).toHaveTextContent("1 not observed · 1 unknown · 1 not sent");
    expect(row.cells[4]).toHaveTextContent("1 observed · 1 unknown · 1 not sent");
    await user.click(button);
    const history = screen.getByRole<HTMLTableElement>("table", { name: "Send history for Auction pilot" });
    const rows = Array.from(history.tBodies[0].rows);
    expect(rows[0].cells[2]).toHaveTextContent("Not observed");
    expect(rows[0].cells[3].querySelector("time")?.dateTime).toBe(clickedAt);
    expect(Array.from(rows[0].cells[1].querySelectorAll("time")).map((time) => time.dateTime)).toEqual([bouncedAt, "2026-09-23T10:00:10Z"]);
    expect(rows[4].cells[0]).toHaveTextContent("Not sent");
    expect(rows[4].cells[3]).toHaveTextContent("Not sent");
    expect(screen.queryByRole("table", { name: /Destination activity/ })).not.toBeInTheDocument();
    expect(within(history).getAllByRole("link", { name: /FPT battery modules/ })).toHaveLength(3);
  });

  it("uses cached listing links and generic labels without exposing missing metadata or CTA keys", async () => {
    const user = userEvent.setup();
    const listingId = "d197f1ce-2e9e-4ec5-b341-7c915fdc85bc";
    const fallbackId = "37b898b8-a442-41cb-aa5f-ec4d516beb0c";
    const listingUrl = "https://rebattery.io/marketplace/auctions/fpt-modules";
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ...buildPersonResponse("alice", "Person alice"),
      campaigns: [{
        ...buildCampaignSend("send", "campaign", "Battery update"), listing_id: listingId,
        links: [
          { cta_key: listingId, listing_id: listingId, listing_title: "FPT battery modules", listing_url: listingUrl, first_clicked_at: null },
          { cta_key: fallbackId, listing_id: fallbackId, listing_title: fallbackId, listing_url: null, first_clicked_at: null },
          { cta_key: "internal_cta_key", listing_id: null, first_clicked_at: null },
        ],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<PersonProfile personId="alice" activeTab="campaigns" />);
    await user.click(await screen.findByRole("button", { name: "Show activity for Battery update" }));
    const table = screen.getByRole("table", { name: /Destination activity/ });
    const link = within(table).getByRole("link", { name: /FPT battery modules/ });
    expect(link).toHaveAttribute("href", listingUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const rows = within(table).getAllByRole<HTMLTableRowElement>("row");
    expect(rows[2].cells[0]).toHaveTextContent(/^Listing$/);
    expect(within(rows[2]).queryByRole("link")).not.toBeInTheDocument();
    expect(rows[3].cells[0]).toHaveTextContent(/^Other link$/);
    expect(screen.queryByText(listingId)).not.toBeInTheDocument();
    expect(screen.queryByText(fallbackId)).not.toBeInTheDocument();
    expect(screen.queryByText("internal_cta_key")).not.toBeInTheDocument();
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });

  it("resets campaign and lifetime listing disclosures when navigating to a different person", async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation((input) => {
      const id = input.toString().endsWith("/bob") ? "bob" : "alice";
      return Promise.resolve(new Response(JSON.stringify({
        ...buildPersonResponse(id, `Person ${id}`),
        campaigns: [buildCampaignSend("send")],
        listing_engagement: [{ listing_id: "listing-fpt", listing_title: "FPT battery modules", cta_key: "FPT", clicked_updates: 1 }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    const { rerender } = render(<PersonProfile personId="alice" activeTab="campaigns" />);
    await user.click(await screen.findByRole("button", { name: "Show activity for Auction pilot" }));
    await user.click(screen.getByText("Listings across updates"));
    expect(screen.getByRole("region", { name: "Activity for Auction pilot" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Listing engagement" })).toBeInTheDocument();
    rerender(<PersonProfile personId="bob" activeTab="campaigns" />);
    await screen.findByText("Person bob");
    expect(screen.getByRole("button", { name: "Show activity for Auction pilot" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Activity for Auction pilot" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Listing engagement" })).not.toBeInTheDocument();
  });

  it("shows zero sent updates and no activity tables when no campaigns exist", async () => {
    render(<PersonProfile personId="alice" activeTab="campaigns" />);
    const section = await screen.findByRole("region", { name: "Campaign engagement" });
    const sent = within(section).getByText("Sent", { selector: "dt" }).parentElement!;
    expect(within(sent).getByText("0", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("No campaign updates recorded.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
