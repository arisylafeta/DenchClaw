// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
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

  it("shows the per-listing pitch count without treating email clicks as site visits", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      ...buildPersonResponse("alice", "Person alice"),
      campaigns: [{
        campaign_id: "campaign-1", campaign_name: "Auction pilot", listing_id: "listing-1",
        recipient_email: "alice@example.com", state: "accepted", pitch_count: 2,
        accepted_at: "2026-09-23T10:00:00Z", delivered_at: "2026-09-23T10:00:10Z",
        bounced_at: null, provider_opened_at: null,
        provider_link_clicked_at: "2026-09-23T10:02:00Z",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const user = userEvent.setup();
    render(<PersonProfile personId="alice" />);
    await screen.findByText("Person alice");
    await user.click(screen.getByRole("button", { name: /Campaigns/ }));
    expect(screen.getByText("Listing listing-1 · 2 recorded pitches")).toBeInTheDocument();
    expect(screen.getByText("Email link clicked (site visit unverified)")).toBeInTheDocument();
  });
});
