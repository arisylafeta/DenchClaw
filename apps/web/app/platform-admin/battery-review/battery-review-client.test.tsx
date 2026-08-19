// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BatteryReviewClient } from "./battery-review-client";
import { getBatteryReviewDetails, getBatteryReviewPage } from "./actions";

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
    expect(await screen.findByText("Tesla · Model 3")).toBeInTheDocument();
    expect(screen.getByText("Battery specification")).toBeInTheDocument();
  });

  it("keeps evidence values that are missing from changed_fields inspectable", async () => {
    const user = userEvent.setup();
    const evidenceRow = {
      id: "evidence-1",
      selected_battery_id: "battery-1",
      matched_battery_id: null,
      linked_battery: null,
      changed_fields: ["manufacturer"],
      previous_values: { manufacturer: "Tesla", model: "Old model" },
      submitted_values: { manufacturer: "CATL", model: "New model", voltage: 400 },
      source_context: "Import batch 7",
      source_flow: "catalogue_import",
      created_at: "2026-08-15T00:00:00.000Z",
      structured_modules: [{ name: "module-a" }],
    };
    vi.mocked(getBatteryReviewPage).mockResolvedValue({ rows: [evidenceRow], totalCount: 1, page: 1, pageSize: 25 });
    vi.mocked(getBatteryReviewDetails).mockResolvedValue({ row: evidenceRow, linked: null });

    render(
      <BatteryReviewClient
        initialCanonical={{ rows: [], totalCount: 0, page: 1, pageSize: 25 }}
        initialEvidence={{ rows: [evidenceRow], totalCount: 1, page: 1, pageSize: 25 }}
        filterOptions={{ manufacturers: [], chemistries: [] }}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Battery Evidence" }));
    await user.click(await screen.findByText("Import batch 7"));

    expect((await screen.findAllByText("Old model")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("New model").length).toBeGreaterThan(0);
    expect(screen.getAllByText("400").length).toBeGreaterThan(0);
    expect(screen.getByText('[{"name":"module-a"}]')).toBeInTheDocument();
  });
});
