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
          }],
          totalCount: 1,
          allCount: 1,
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

    const deselectCheckbox = screen.getByRole("checkbox", { name: "Deselect Clean Recycler" });
    await user.click(deselectCheckbox);
    expect(deselectCheckbox).not.toBeChecked();

    const selectCheckbox = screen.getByRole("checkbox", { name: "Select Clean Recycler" });
    await user.click(selectCheckbox);
    expect(selectCheckbox).toBeChecked();
  });
});
