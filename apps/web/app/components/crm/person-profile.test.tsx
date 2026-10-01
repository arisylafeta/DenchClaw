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

  it("shows lifetime update totals and listing clicks separately from general CTA activity, including a click without an open", async () => {
    const clickedAt = "2026-09-23T10:02:00Z";
    const openedAt = "2026-09-23T10:01:00Z";
    const baseSend = {
      campaign_id: "campaign-1", campaign_name: "Auction pilot", listing_id: "listing-fpt",
      recipient_email: "alice@example.com", state: "accepted", pitch_count: 2,
      accepted_at: "2026-09-23T10:00:00Z", delivered_at: "2026-09-23T10:00:10Z",
      bounced_at: null, last_synced_at: "2026-09-23T11:00:00Z",
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ...buildPersonResponse("alice", "Person alice"),
      campaign_summary: { sent: 4, delivered: 4, opened: 3, clicked: 2, tracking_pending: 0 },
      listing_engagement: [{ listing_id: "listing-fpt", cta_key: "FPT", clicked_updates: 2 }],
      campaigns: [
        {
          ...baseSend, send_id: "send-1", provider_opened_at: openedAt, provider_link_clicked_at: clickedAt,
          links: [
            { cta_key: "FPT", listing_id: "listing-fpt", first_clicked_at: clickedAt },
            { cta_key: "grid", listing_id: null, first_clicked_at: clickedAt },
          ],
        },
        {
          ...baseSend, send_id: "send-2", provider_opened_at: openedAt, provider_link_clicked_at: null,
          links: [
            { cta_key: "FPT", listing_id: "listing-fpt", first_clicked_at: null },
            { cta_key: "sourcing", listing_id: null, first_clicked_at: null },
          ],
        },
        {
          ...baseSend, send_id: "send-3", campaign_id: "campaign-2", campaign_name: "Follow-up",
          provider_opened_at: openedAt, provider_link_clicked_at: null, links: [],
        },
        {
          ...baseSend, send_id: "send-4", campaign_id: "campaign-3", campaign_name: "Final update",
          provider_opened_at: null, provider_link_clicked_at: clickedAt,
          links: [{ cta_key: "FPT", listing_id: "listing-fpt", first_clicked_at: clickedAt }],
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<PersonProfile personId="alice" activeTab="campaigns" />);

    // Read each metric's value, rather than relying on explanatory copy.
    const summary = await screen.findByRole("region", { name: "Campaign engagement" });
    const metric = (label: string) => within(summary).getByText(label, { selector: "dt" }).parentElement!;
    expect(within(metric("Sent")).getByText("4", { selector: "dd" })).toBeInTheDocument();
    expect(within(metric("Opened")).getByText("3 of 4", { selector: "dd" })).toBeInTheDocument();
    expect(within(metric("Clicked")).getByText("2 of 4", { selector: "dd" })).toBeInTheDocument();
    expect(within(metric("Delivered")).getByText("4 of 4", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    const listings = screen.getByRole("region", { name: "Listing engagement" });
    const listingRows = within(listings).getAllByRole("row");
    expect(listingRows).toHaveLength(2);
    expect(within(listingRows[1]).getByRole("cell", { name: "FPT" })).toBeInTheDocument();
    expect(within(listingRows[1]).getByRole("cell", { name: "2" })).toBeInTheDocument();
    expect(within(listings).queryByText("grid")).not.toBeInTheDocument();
    expect(within(listings).queryByText("sourcing")).not.toBeInTheDocument();

    expect(screen.getAllByRole("article")).toHaveLength(4);
    const pilots = screen.getAllByRole("article", { name: "Auction pilot" });
    const firstCtas = within(pilots[0]).getByRole("table", { name: "CTA activity" });
    const firstLinks = within(firstCtas).getAllByRole("row").slice(1);
    expect(within(firstLinks[0]).getByRole("cell", { name: "FPT" })).toBeInTheDocument();
    expect(within(firstLinks[0]).getByRole("cell", { name: "Listing" })).toBeInTheDocument();
    expect(firstLinks[0].querySelector("time")?.dateTime).toBe(clickedAt);
    expect(within(firstLinks[1]).getByRole("cell", { name: "grid" })).toBeInTheDocument();
    expect(within(firstLinks[1]).getByRole("cell", { name: "General CTA" })).toBeInTheDocument();
    expect(firstLinks[1].querySelector("time")?.dateTime).toBe(clickedAt);
    const secondCtas = within(pilots[1]).getByRole("table", { name: "CTA activity" });
    expect(within(secondCtas).getAllByText("No tracked click")).toHaveLength(2);

    const clickWithoutOpen = screen.getByRole("article", { name: "Final update" });
    expect(within(clickWithoutOpen).getByText("No tracked open")).toBeInTheDocument();
    const clickedCtas = within(clickWithoutOpen).getByRole("table", { name: "CTA activity" });
    expect(clickedCtas.querySelector("time")?.dateTime).toBe(clickedAt);
  });

  it.each(["2026-09-23T10:00:00Z", null])("keeps accepted unsynced activity unknown with acceptance timestamp %s while showing observed clicks", async (acceptedAt) => {
    const clickedAt = "2026-09-23T10:02:00Z";
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ...buildPersonResponse("alice", "Person alice"),
      campaign_summary: { sent: 1, delivered: 0, opened: 0, clicked: 1, tracking_pending: 1 },
      listing_engagement: [],
      campaigns: [{
        send_id: "send-pending", campaign_id: "campaign-1", campaign_name: "Pending update",
        listing_id: "", recipient_email: "alice@example.com", state: "accepted", pitch_count: 0,
        accepted_at: acceptedAt, delivered_at: null, bounced_at: null,
        provider_opened_at: null, provider_link_clicked_at: null, last_synced_at: null,
        links: [
          { cta_key: "grid", listing_id: null, first_clicked_at: clickedAt },
          { cta_key: "FPT", listing_id: "listing-fpt", first_clicked_at: null },
        ],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<PersonProfile personId="alice" activeTab="campaigns" />);
    const update = await screen.findByRole("article", { name: "Pending update" });
    expect(screen.getByRole("status")).toHaveTextContent(/1 sent update/);
    expect(within(update).queryByText("No tracked open")).not.toBeInTheDocument();
    expect(within(update).queryByText("No tracked click")).not.toBeInTheDocument();
    expect(within(update).getByText(/Open activity unknown/)).toBeInTheDocument();
    const clicks = update.querySelectorAll("time");
    expect(Array.from(clicks).filter((time) => time.dateTime === clickedAt && !time.closest("table"))).toHaveLength(1);
    const links = within(within(update).getByRole("table", { name: "CTA activity" })).getAllByRole("row").slice(1);
    expect(links[0].querySelector("time")?.dateTime).toBe(clickedAt);
    expect(within(links[1]).getByText(/Click activity unknown/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Listing engagement" })).not.toBeInTheDocument();
  });

  it("uses cached listing titles and keeps an uncached UUID destination inside collapsed details", async () => {
    const listingId = "d197f1ce-2e9e-4ec5-b341-7c915fdc85bc";
    const fallbackId = "37b898b8-a442-41cb-aa5f-ec4d516beb0c";
    const listingUrl = "https://rebattery.io/marketplace/auctions/fpt-modules";
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ...buildPersonResponse("alice", "Person alice"),
      campaigns: [{
        send_id: "send", campaign_id: "campaign", campaign_name: "Battery update",
        listing_id: listingId, listing_title: "FPT battery modules", listing_url: listingUrl,
        recipient_email: "alice@example.com", state: "accepted", pitch_count: 1,
        accepted_at: "2026-09-23T10:00:00Z", delivered_at: null, bounced_at: null,
        provider_opened_at: null, provider_link_clicked_at: null, last_synced_at: "2026-09-23T11:00:00Z",
        links: [
          { cta_key: listingId, listing_id: listingId, listing_title: "FPT battery modules", listing_url: listingUrl, first_clicked_at: null },
          { cta_key: fallbackId, listing_id: fallbackId, listing_title: null, listing_url: null, first_clicked_at: null },
        ],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<PersonProfile personId="alice" activeTab="campaigns" />);
    const update = await screen.findByRole("article", { name: "Battery update" });
    const table = within(update).getByRole("table", { name: "CTA activity" });
    expect(within(table).getByRole("link", { name: /FPT battery modules/ })).toHaveAttribute("href", listingUrl);
    expect(within(table).queryByText(fallbackId)).not.toBeInTheDocument();
    expect(within(table).queryByRole("link", { name: "Listing" })).not.toBeInTheDocument();
    const details = update.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(fallbackId);
  });

  it("shows zero sent updates without listing or per-update activity when no campaigns exist", async () => {
    render(<PersonProfile personId="alice" activeTab="campaigns" />);
    const section = await screen.findByRole("region", { name: "Campaign engagement" });
    const sent = within(section).getByText("Sent", { selector: "dt" }).parentElement!;
    expect(within(sent).getByText("0", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Listing engagement" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
