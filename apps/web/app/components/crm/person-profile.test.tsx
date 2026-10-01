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

/**
 * Read the active-tab label from the rendered header. The active tab is
 * the one with a solid border-bottom; inactive tabs have a transparent
 * border-bottom. We rely on the inline style rather than a class because
 * the header sets the colors via inline `style` attributes.
 */
function getActiveTabLabel(): string | null {
  const tablist = screen.getByText("Overview").parentElement;
  if (!tablist) return null;
  for (const child of Array.from(tablist.children)) {
    if (!(child instanceof HTMLButtonElement)) continue;
    const border = child.style.borderBottom;
    if (border && border.includes("var(--color-text)")) {
      return child.textContent?.trim() ?? null;
    }
  }
  return null;
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
    expect(within(listings).getAllByRole("listitem")).toHaveLength(1);
    expect(within(listings).getByText("FPT")).toBeInTheDocument();
    expect(within(listings).getByText("Clicked in 2 updates")).toBeInTheDocument();
    expect(within(listings).getByText("Listing listing-fpt")).toBeInTheDocument();
    expect(within(listings).queryByText("grid")).not.toBeInTheDocument();
    expect(within(listings).queryByText("sourcing")).not.toBeInTheDocument();

    expect(screen.getAllByRole("article")).toHaveLength(4);
    const pilots = screen.getAllByRole("article", { name: "Auction pilot" });
    const firstCtas = within(pilots[0]).getByRole("list", { name: "CTA activity" });
    const firstLinks = within(firstCtas).getAllByRole("listitem");
    expect(within(firstLinks[0]).getByText("FPT")).toBeInTheDocument();
    expect(within(firstLinks[0]).getByText(/Listing listing-fpt/)).toBeInTheDocument();
    expect(within(firstLinks[0]).getByText(clickedAt, { selector: "time" })).toBeInTheDocument();
    expect(within(firstLinks[1]).getByText("grid")).toBeInTheDocument();
    expect(within(firstLinks[1]).getByText(/General CTA/)).toBeInTheDocument();
    expect(within(firstLinks[1]).getByText(clickedAt, { selector: "time" })).toBeInTheDocument();
    const secondCtas = within(pilots[1]).getByRole("list", { name: "CTA activity" });
    expect(within(secondCtas).getAllByText("No tracked click")).toHaveLength(2);

    const clickWithoutOpen = screen.getByRole("article", { name: "Final update" });
    expect(within(clickWithoutOpen).getByText("No tracked open")).toBeInTheDocument();
    const clickedCtas = within(clickWithoutOpen).getByRole("list", { name: "CTA activity" });
    expect(within(clickedCtas).getByText(clickedAt, { selector: "time" })).toBeInTheDocument();
  });

  it("keeps unsynced activity unknown while showing clicks already observed", async () => {
    const clickedAt = "2026-09-23T10:02:00Z";
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ...buildPersonResponse("alice", "Person alice"),
      campaign_summary: { sent: 1, delivered: 0, opened: 0, clicked: 1, tracking_pending: 1 },
      listing_engagement: [],
      campaigns: [{
        send_id: "send-pending", campaign_id: "campaign-1", campaign_name: "Pending update",
        listing_id: "", recipient_email: "alice@example.com", state: "accepted", pitch_count: 0,
        accepted_at: "2026-09-23T10:00:00Z", delivered_at: null, bounced_at: null,
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
    const clicks = within(update).getAllByText(clickedAt, { selector: "time" });
    expect(clicks.some((time) => !time.closest("ul"))).toBe(true);
    const links = within(within(update).getByRole("list", { name: "CTA activity" })).getAllByRole("listitem");
    expect(within(links[0]).getByText(clickedAt, { selector: "time" })).toBeInTheDocument();
    expect(within(links[1]).getByText(/Click activity unknown/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Listing engagement" })).not.toBeInTheDocument();
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
