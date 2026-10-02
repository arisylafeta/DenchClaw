// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyProfile } from "./company-profile";

function buildCompanyResponse(
  id: string,
  name: string,
  overrides: {
    sectors?: string[]; platform_role?: string; roles?: string[]; purpose?: string[]; segment?: string;
    specialisms?: string[]; stage?: string; region?: string;
  } = {},
) {
  return {
    company: {
      id,
      name,
      domain: null,
      website: null,
      platform_role: null,
      industry: null,
      type: null,
      source: null,
      sectors: null,
      roles: null,
      strength_score: null,
      strength_label: "—",
      strength_color: "#999999",
      last_interaction_at: null,
      notes: null,
      created_at: null,
      updated_at: null,
      ...overrides,
    },
    people: [],
    threads: [],
    events: [],
    summary: {
      people_count: 0,
      thread_count: 0,
      event_count: 0,
      strongest_contact: null,
    },
    buyer: {
      profile: {
        stage: "Contacted", stage_changed_on: "2026-09-01", tier: "A", owner: "Alex", capabilities: ["Test and grade"],
        can_receive_waste: null, accepts_standard_terms: "Not asked", collection: null, past_issues: "Dispute at loading over test data.",
        outreach_notes: null, main_contact_id: null, next_step: null, next_step_on: null,
        projects: "10 MW second-life BESS in Brandenburg", category: "Repurposer",
        workstream_status: "Approved", evidence: "Builds BESS from EV packs.", last_reviewed_at: "2026-09-21",
      },
      engagement: {
        last_in_at: "2026-09-28T10:00:00Z", last_out_at: "2026-09-20T10:00:00Z", waiting_since: "2026-09-28T10:00:00Z",
        last_heard_at: "2026-09-28T10:00:00Z", emails_in_90d: 4, emails_out_90d: 3, meetings: 1, last_meeting_at: null,
        campaign_clicks: 2, auction_views: 5, auction_offers: 1, trades_offered: 2, trades_won: 0, bids: 1,
        last_bid_at: "2026-09-29T10:00:00Z", open_requests: 0, open_buy_boxes: 1, agreed_buy_boxes: 0, surveys: 1,
        suggested_stage: "Bidding",
      },
      demand: [{
        id: "btd_1", kind: "standing", basis: "stated", buyer: name, company_id: id, person_id: null, contact: null, email: null,
        wants: "Packs, NMC / LFP, 30+ kWh", quantity: null, location: "Spain", note: null, needed_by: null, volume: 200,
        volume_unit: "packs", max_price: 45, price_currency: "GBP", price_unit: "kWh", spec: { chemistries: ["NMC", "LFP"] },
        source_kind: "survey", source_label: "Typeform demand survey", source_url: null, source_quote: null,
        observed_on: "2026-08-20", status: "open", closed_reason: null, confirmed_on: "2026-08-20",
        updated_at: "2026-08-20T00:00:00Z", fits: [], trades: [], waiting: null,
      }],
      changes: [{ field: "buyer_stage", old_value: "Identified", new_value: "Contacted", changed_at: "2026-09-01T09:00:00Z" }],
    },
    commercial: {
      roles: ["supplier"],
      profiles: [
        {
          id: "cp_1",
          company_id: id,
          contact_person_id: null,
          contact_person_name: "Alex Rivera",
          profile_type: "seller_supply",
          status: "active",
          battery_types: ["EV battery"],
          previous_applications: ["Passenger vehicle"],
          chemistries: ["NMC"],
          conditions: ["Used"],
          formats: ["Pack"],
          specific_types: ["Nissan Leaf"],
          geographies: ["US"],
          soh_floor: 70,
          volume_min: 5,
          volume_max: 20,
          preferred_outcome: "Resale",
          notes: "Typical salvage EV battery supply.",
          source: "crm",
          last_verified_at: null,
        },
      ],
      opportunities: [
        {
          id: "opp_1",
          company_id: id,
          contact_person_id: null,
          contact_person_name: null,
          opportunity_type: "supply",
          status: "open",
          source_system: "crm",
          source_id: null,
          title: "Nissan Leaf battery pack",
          battery_type: null,
          previous_application: null,
          chemistry: "NMC",
          condition: "Used",
          format: "Pack",
          manufacturer: "Nissan",
          model: "Leaf",
          specific_type: null,
          location_country: "US",
          location_region: "CA",
          quantity: 10,
          soh: null,
          pack_kwh: null,
          price_amount: null,
          currency: null,
          urgency: "high",
          priority_score: null,
          available_from: null,
          deadline_at: null,
          last_synced_at: null,
          notes: null,
        },
        {
          id: "opp_2",
          company_id: id,
          contact_person_id: null,
          contact_person_name: "Jordan Lee",
          opportunity_type: "supply",
          status: "open",
          source_system: "csv",
          source_id: "silverlake:tesla",
          title: "Tesla Model 3 long range pack",
          battery_type: "EV battery",
          previous_application: "Battery electric sedan",
          chemistry: "NCA",
          condition: "Used",
          format: "Pack",
          manufacturer: "Tesla",
          model: "Model 3",
          specific_type: null,
          location_country: "United Kingdom",
          location_region: "Hampshire",
          quantity: 1,
          soh: null,
          pack_kwh: 82,
          price_amount: null,
          currency: "GBP",
          urgency: "medium",
          priority_score: null,
          available_from: null,
          deadline_at: null,
          last_synced_at: null,
          notes: "Clean imported supply row.",
        },
      ],
      summary: {
        active_profile_count: 1,
        buyer_profile_count: 0,
        supplier_profile_count: 1,
        recycler_profile_count: 0,
        open_supply_count: 1,
        open_demand_count: 0,
        urgent_supply_count: 1,
        urgent_demand_count: 0,
        latest_profile_verified_at: null,
        latest_supply_at: null,
        latest_demand_at: null,
        next_deadline_at: null,
        commercial_status: "active_supply",
        commercial_priority_score: 0,
      },
    },
  };
}

function mockFetchForCompany() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Promise.resolve(new Response("{}", { status: 200 }));
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const match = url.match(/\/api\/crm\/companies\/([^/?]+)/);
      const id = match ? decodeURIComponent(match[1]) : "unknown";
      return Promise.resolve(
        new Response(JSON.stringify(buildCompanyResponse(id, `Company ${id}`)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
}

function getActiveTabLabel(): string | null {
  const tablist = screen.getByText("Overview").parentElement;
  if (!tablist) { return null; }
  for (const child of Array.from(tablist.children)) {
    if (!(child instanceof HTMLButtonElement)) { continue; }
    const border = child.style.borderBottom;
    if (border && border.includes("var(--color-text)")) {
      return child.textContent?.trim() ?? null;
    }
  }
  return null;
}

describe("CompanyProfile tab reset on entry change", () => {
  let fetchSpy: ReturnType<typeof mockFetchForCompany>;

  beforeEach(() => {
    fetchSpy = mockFetchForCompany();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("resets the active tab to Overview when switching from one company to another", async () => {
    // Regression: with the same React instance reused across `companyId`
    // changes, `localTab` used to leak the previously-selected tab into
    // the new company whenever the URL didn't carry an explicit
    // `profileTab`. Reset on prop change is now mandatory.
    const user = userEvent.setup();
    const { rerender } = render(<CompanyProfile companyId="acme" />);

    await waitFor(() => {
      expect(screen.getByText("Company acme")).toBeInTheDocument();
    });
    expect(getActiveTabLabel()).toBe("Overview");

    await user.click(screen.getByRole("button", { name: "Team" }));
    expect(getActiveTabLabel()).toBe("Team");

    rerender(<CompanyProfile companyId="globex" />);

    await waitFor(() => {
      expect(screen.getByText("Company globex")).toBeInTheDocument();
    });
    // Without the reset guard, Team would still be active here because
    // the React instance is reused and `localTab` survives the prop change.
    expect(getActiveTabLabel()).toBe("Overview");
  });

  it("respects an explicit activeTab prop on the new entry (URL-supplied profileTab still wins)", async () => {
    const { rerender } = render(<CompanyProfile companyId="acme" />);
    await waitFor(() => {
      expect(screen.getByText("Company acme")).toBeInTheDocument();
    });

    rerender(<CompanyProfile companyId="globex" activeTab="emails" />);
    await waitFor(() => {
      expect(screen.getByText("Company globex")).toBeInTheDocument();
    });
    expect(getActiveTabLabel()).toBe("Emails");
  });

  it("shows the Buyer tab: stage with the data's suggestion, waiting, engagement, buy-boxes, profile and history", async () => {
    const user = userEvent.setup();
    render(<CompanyProfile companyId="acme" />);
    await waitFor(() => {
      expect(screen.getByText("Company acme")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Buyer/ }));

    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveValue("Contacted");
    expect(screen.getByText("Bidding", { selector: "strong" })).toBeInTheDocument(); // the data says
    expect(screen.getByText(/Waiting on our reply since/)).toBeInTheDocument();
    expect(screen.getByText("4 in · 3 out")).toBeInTheDocument();
    expect(screen.getByText("Packs, NMC / LFP, 30+ kWh")).toBeInTheDocument();
    expect(screen.getByText(/200 packs a month · max GBP 45\/kWh · Spain/)).toBeInTheDocument();
    expect(screen.getByText("Dispute at loading over test data.")).toBeInTheDocument();
    expect(screen.getByText("Builds BESS from EV packs.")).toBeInTheDocument();
    expect(screen.getByText("10 MW second-life BESS in Brandenburg")).toBeInTheDocument();
    expect(screen.getByText("Stage: Identified → Contacted")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Set to Bidding" }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/workspace/objects/company/entries/acme", expect.objectContaining({
        method: "PATCH", body: JSON.stringify({ fields: { "Buyer Stage": "Bidding" } }),
      }));
    });
  });

  it("saves only the changed buyer profile fields", async () => {
    const user = userEvent.setup();
    render(<CompanyProfile companyId="acme" />);
    await waitFor(() => {
      expect(screen.getByText("Company acme")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Buyer/ }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Accepts standard terms" }), "Yes");
    await user.selectOptions(screen.getByRole("combobox", { name: "Can receive waste batteries" }), "no");
    await user.click(screen.getByRole("button", { name: "Recycle" }));
    await user.type(screen.getByRole("textbox", { name: "Outreach notes" }), "Wants continuity of supply, one type.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/workspace/objects/company/entries/acme", expect.objectContaining({ method: "PATCH" }));
    });
    const patch = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ fields: {
      "Buyer Capabilities": ["Test and grade", "Recycle"],
      "Buyer Can Receive Waste": false,
      "Buyer Accepts Standard Terms": "Yes",
      "Buyer Outreach Notes": "Wants continuity of supply, one type.",
    } });
  });

  it("still shows opportunity details", async () => {
    const user = userEvent.setup();
    render(<CompanyProfile companyId="acme" />);
    await waitFor(() => {
      expect(screen.getByText("Company acme")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Opportunities/ }));
    expect(screen.getByText("Nissan Leaf battery pack")).toBeInTheDocument();
    expect(screen.getByText("NMC · Pack · Nissan Leaf")).toBeInTheDocument();
  });

  it("shows Purpose, Segment, Specialisms, Stage and Region instead of Sectors and Platform Role", async () => {
    fetchSpy.mockRestore();
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const match = url.match(/\/api\/crm\/companies\/([^/?]+)/);
      const id = match ? decodeURIComponent(match[1]) : "unknown";
      const response = buildCompanyResponse(id, `Company ${id}`, {
        sectors: ["automotive", "energy_storage"],
        platform_role: "BUYER",
        roles: ["buyer", "supplier"],
        purpose: ["Buyer", "Supplier"],
        segment: "Battery repair",
        specialisms: ["Battery repair", "Battery trading"],
        stage: "Engaged",
        region: "CEE",
      });
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    render(<CompanyProfile companyId="acme" />);

    await waitFor(() => {
      expect(screen.getByText("Company acme")).toBeInTheDocument();
    });

    expect(screen.getByText("Buyer, Supplier")).toBeInTheDocument();
    expect(screen.getAllByText("Battery repair").length).toBeGreaterThanOrEqual(2); // Segment and a Specialism
    expect(screen.getByText("Battery trading")).toBeInTheDocument();
    expect(screen.getByText("Engaged")).toBeInTheDocument();
    expect(screen.getByText("CEE")).toBeInTheDocument();
    expect(screen.queryByText("Platform Role")).toBeNull();
    expect(screen.queryByText("automotive, energy_storage")).toBeNull();
  });

  it("filters opportunities with inline multi-select dropdowns and clear controls", async () => {
    const user = userEvent.setup();
    render(<CompanyProfile companyId="acme" />);

    await waitFor(() => {
      expect(screen.getByText("Company acme")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Opportunities/ }));
    expect(screen.getByText("2 of 2 opportunities")).toBeInTheDocument();
    expect(screen.getByText("Nissan Leaf battery pack")).toBeInTheDocument();
    expect(screen.getByText("Tesla Model 3 long range pack")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search opportunities" }), "tesla");
    expect(screen.getByText("1 of 2 opportunities")).toBeInTheDocument();
    expect(screen.queryByText("Nissan Leaf battery pack")).not.toBeInTheDocument();
    expect(screen.getByText("Tesla Model 3 long range pack")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Urgency: All" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "High" }));
    expect(screen.getByText("No opportunities match these filters")).toBeInTheDocument();
    expect(screen.getByText("0 of 2 opportunities")).toBeInTheDocument();

    await user.click(screen.getByRole("menuitemcheckbox", { name: "Medium" }));
    expect(screen.getByText("1 of 2 opportunities")).toBeInTheDocument();
    expect(screen.getByText("Tesla Model 3 long range pack")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("2 of 2 opportunities")).toBeInTheDocument();
    expect(screen.getByText("Nissan Leaf battery pack")).toBeInTheDocument();
    expect(screen.getByText("Tesla Model 3 long range pack")).toBeInTheDocument();
  });
});
