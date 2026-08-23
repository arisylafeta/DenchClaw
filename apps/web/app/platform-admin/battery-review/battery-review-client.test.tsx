// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  getBatteryEvidencePage,
  reviewBatteryEvidence,
  searchCanonicalApplications,
} from "./actions";
import { BatteryReviewClient } from "./battery-review-client";

vi.mock("./actions", () => ({
  getBatteryEvidencePage: vi.fn(),
  reviewBatteryEvidence: vi.fn(),
  searchCanonicalApplications: vi.fn(),
}));

const evidenceRow = {
  id: "11111111-1111-4111-8111-111111111111",
  canonical_application_id: "22222222-2222-4222-8222-222222222222",
  status: "pending" as const,
  submitted_values: { marketed_kwh: 60 },
  canonical_context: {
    label: "Tesla · Model 3 · 55 kWh · LFP",
    application: {
      id: "22222222-2222-4222-8222-222222222222",
      battery_id: "33333333-3333-4333-8333-333333333333",
      vehicle_model_id: "44444444-4444-4444-8444-444444444444",
      updated_at: "2026-08-15T00:00:00.000Z",
    },
    battery: {
      id: "33333333-3333-4333-8333-333333333333",
      updated_at: "2026-08-15T00:00:00.000Z",
      marketed_kwh: 55,
      chemistry_family: "LFP",
    },
    vehicle: {
      id: "44444444-4444-4444-8444-444444444444",
      updated_at: "2026-08-15T00:00:00.000Z",
      make: "Tesla",
      model: "Model 3",
    },
  },
  differences: [
    {
      field: "marketed_kwh",
      label: "Marketed kWh",
      owner: "battery" as const,
      canonical: 55,
      submitted: 60,
    },
  ],
  source_context: "Quote capture",
  source_flow: "supplier_listing",
  created_at: "2026-08-15T00:00:00.000Z",
};

describe("BatteryReviewClient", () => {
  it("shows a side-by-side review for pending evidence", async () => {
    const user = userEvent.setup();
    vi.mocked(getBatteryEvidencePage).mockResolvedValue({
      rows: [evidenceRow],
      totalCount: 1,
      page: 1,
      pageSize: 25,
      schemaReady: true,
    });

    render(
      <BatteryReviewClient
        initialPage={{
          rows: [evidenceRow],
          totalCount: 1,
          page: 1,
          pageSize: 25,
          schemaReady: true,
        }}
      />,
    );

    expect(screen.getByText("Tesla · Model 3 · 55 kWh · LFP")).toBeTruthy();
    expect(screen.getByText("55")).toBeTruthy();
    expect(screen.getByText("60")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("Review battery evidence")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Verify evidence only/ })).toBeTruthy();
    expect(reviewBatteryEvidence).not.toHaveBeenCalled();
    expect(searchCanonicalApplications).not.toHaveBeenCalled();
  });

  it("stays safe while the production schema upgrade is pending", () => {
    render(
      <BatteryReviewClient
        initialPage={{
          rows: [],
          totalCount: 0,
          page: 1,
          pageSize: 25,
          schemaReady: false,
        }}
      />,
    );

    expect(screen.getByText("Evidence schema upgrade pending")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Search/ }).hasAttribute("disabled")).toBe(true);
  });
});
