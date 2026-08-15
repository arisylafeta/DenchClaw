// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BatteryReviewClient } from "./battery-review-client";
import { getBatteryReviewDetails } from "./actions";

vi.mock("./actions", () => ({
  getBatteryReviewDetails: vi.fn(),
  getBatteryReviewPage: vi.fn(),
}));

describe("BatteryReviewClient", () => {
  it("uses the shared searchable table and opens a row", async () => {
    const user = userEvent.setup();
    vi.mocked(getBatteryReviewDetails).mockResolvedValue({
      row: { id: "battery-1", manufacturer: "Tesla", model: "Model 3" },
      linked: null,
    });

    render(
      <BatteryReviewClient
        initialCanonical={{
          rows: [{
            id: "battery-1",
            manufacturer: "Tesla",
            model: "Model 3",
            chemistry: "NMC",
            nominal_kwh: 75,
            part_number: "PN-1",
            updated_at: "2026-08-15T00:00:00.000Z",
            catalogue_image_url: null,
          }],
          totalCount: 1,
          page: 1,
          pageSize: 25,
        }}
        initialEvidence={{ rows: [], totalCount: 0, page: 1, pageSize: 25 }}
        filterOptions={{ manufacturers: ["Tesla"], chemistries: ["NMC"] }}
      />,
    );

    expect(screen.getByPlaceholderText("Search canonical batteries...")).toBeInTheDocument();
    await user.click(screen.getByText("Tesla"));
    expect(getBatteryReviewDetails).toHaveBeenCalledWith({ tab: "canonical", id: "battery-1" });
    expect(await screen.findByText("Canonical battery details")).toBeInTheDocument();
  });
});
