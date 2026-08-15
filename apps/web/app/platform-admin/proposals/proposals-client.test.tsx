// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProposalsClient } from "./proposals-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("./actions", () => ({
  createInvitations: vi.fn(),
  updateProposalState: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const emptyPage = {
  rows: [],
  page: 1,
  pageSize: 25,
  totalCount: 0,
  totalPages: 1,
  allCount: 0,
};

describe("recycler selection", () => {
  it("lets a user deselect a recycler by clicking its checkbox", async () => {
    const user = userEvent.setup();

    render(
      <ProposalsClient
        proposals={emptyPage}
        listings={emptyPage}
        recyclers={{
          ...emptyPage,
          rows: [{
            id: "recycler-1",
            name: "Clean Recycler",
            status: "active",
            display_name: null,
            city: "London",
            region: null,
            country: "United Kingdom",
            public_fields: {},
          }, {
            id: "recycler-2",
            name: "Second Recycler",
            status: "active",
            display_name: null,
            city: "Manchester",
            region: null,
            country: "United Kingdom",
            public_fields: {},
          }],
          totalCount: 2,
          allCount: 2,
        }}
        proposalListingOptions={[]}
        recyclerFilterOptions={{ chemistries: [], countries: [] }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /choose recyclers/i }));
    const checkbox = screen.getByRole("checkbox", { name: "Select Clean Recycler" });
    const row = checkbox.closest("tr");
    expect(row).not.toBeNull();

    await user.click(row!);
    expect(checkbox).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select visible recyclers" })).toBePartiallyChecked();

    const deselectCheckbox = screen.getByRole("checkbox", { name: "Deselect Clean Recycler" });
    await user.click(deselectCheckbox);
    expect(deselectCheckbox).not.toBeChecked();

    const selectCheckbox = screen.getByRole("checkbox", { name: "Select Clean Recycler" });
    await user.click(selectCheckbox);
    expect(selectCheckbox).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Select visible recyclers" }));
    expect(screen.getByRole("checkbox", { name: "Deselect visible recyclers" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Deselect Second Recycler" })).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Deselect visible recyclers" }));
    expect(screen.getByRole("checkbox", { name: "Select Clean Recycler" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Second Recycler" })).not.toBeChecked();
  });

  it("lets a user deselect the selected listing", async () => {
    const user = userEvent.setup();

    render(
      <ProposalsClient
        proposals={emptyPage}
        listings={{
          ...emptyPage,
          rows: [{
            id: "listing-1",
            title: "Battery lot",
            reference: "BAT-001",
            supplier_name: "Supplier Ltd",
            channel_mode: "recycling",
            visibility: "public",
            listing_status: "published",
            created_at: "2026-08-15T00:00:00.000Z",
            invite_count: 0,
            enquiry_count: 0,
            deal_count: 0,
          }],
          totalCount: 1,
          allCount: 1,
        }}
        recyclers={emptyPage}
        proposalListingOptions={[]}
        recyclerFilterOptions={{ chemistries: [], countries: [] }}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Select Battery lot" });
    const row = checkbox.closest("tr");
    expect(row).not.toBeNull();
    await user.click(row!);
    expect(screen.getByRole("checkbox", { name: "Deselect Battery lot" })).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Deselect Battery lot" }));
    expect(screen.getByRole("checkbox", { name: "Select Battery lot" })).not.toBeChecked();
  });

  it("selects visible proposals, preserves selection across pages, and isolates action clicks", async () => {
    const user = userEvent.setup();

    const proposalOne = {
      id: "proposal-1",
      listing_id: "listing-1",
      recycler_account_id: "recycler-1",
      link_type: "invited",
      state: "active",
      rebattery_notes: null,
      created_at: "2026-08-15T00:00:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z",
      expires_at: "2026-08-22T00:00:00.000Z",
      listing_title: "Battery lot",
      listing_reference: "BAT-001",
      listing_supplier_name: "Supplier Ltd",
      recycler_name: "Clean Recycler",
      recycler_display_name: null,
      recycler_city: "London",
      recycler_region: null,
      recycler_country: "United Kingdom",
      recycler_public_fields: {},
    };
    const proposalTwo = {
      ...proposalOne,
      id: "proposal-2",
      recycler_account_id: "recycler-2",
      recycler_name: "Second Recycler",
    };
    const proposalThree = {
      ...proposalOne,
      id: "proposal-3",
      recycler_account_id: "recycler-3",
      recycler_name: "Third Recycler",
    };

    const { rerender } = render(
      <ProposalsClient
        proposals={{
          ...emptyPage,
          rows: [proposalOne, proposalTwo],
          totalCount: 3,
          totalPages: 2,
          allCount: 3,
        }}
        listings={emptyPage}
        recyclers={emptyPage}
        proposalListingOptions={[]}
        recyclerFilterOptions={{ chemistries: [], countries: [] }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /existing proposals/i }));
    const checkbox = screen.getByRole("checkbox", { name: "Select Battery lot proposal for Clean Recycler" });
    const row = checkbox.closest("tr");
    expect(row).not.toBeNull();
    await user.click(row!);
    expect(screen.getByRole("checkbox", { name: "Deselect Battery lot proposal for Clean Recycler" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select visible proposals" })).toBePartiallyChecked();

    await user.click(screen.getAllByRole("button", { name: "Open actions" })[0]);
    expect(row).toHaveAttribute("data-state", "selected");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("checkbox", { name: "Select visible proposals" }));
    expect(screen.getByRole("checkbox", { name: "Deselect visible proposals" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Deselect Battery lot proposal for Second Recycler" })).toBeChecked();

    rerender(
      <ProposalsClient
        proposals={{
          ...emptyPage,
          rows: [proposalThree],
          page: 2,
          totalCount: 3,
          totalPages: 2,
          allCount: 3,
        }}
        listings={emptyPage}
        recyclers={emptyPage}
        proposalListingOptions={[]}
        recyclerFilterOptions={{ chemistries: [], countries: [] }}
      />,
    );

    expect(screen.getByText("2 proposals selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Battery lot proposal for Third Recycler" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Select visible proposals" }));
    expect(screen.getByText("3 proposals selected")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Deselect visible proposals" }));
    expect(screen.getByText("2 proposals selected")).toBeInTheDocument();
  });
});
