// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ListingsClient } from "./listings-client";
import type { ListingPage } from "./contract";

const { replace, getListingDetails } = vi.hoisted(() => ({ replace: vi.fn(), getListingDetails: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));
vi.mock("./actions", () => ({ getListingDetails }));

const initialPage: ListingPage = {
  rows: [{
    id: "listing-1",
    title: "Tesla module stock",
    reference: "REF-1",
    seoSlug: "tesla-module-stock",
    supplierAccountId: "supplier-1",
    supplierName: "Supplier One",
    status: "published" as const,
    channel: "sale" as const,
    visibility: "public" as const,
    quantity: 24,
    packKwh: 42,
    packWeightKg: 320,
    chemistry: "NMC",
    locationCity: "London",
    locationRegion: null,
    locationCountry: "GB",
    updatedAt: "2026-08-19T00:00:00.000Z",
    createdAt: "2026-08-18T00:00:00.000Z",
  }],
  totalCount: 1,
  page: 1,
  pageSize: 25,
  totalPages: 1,
  snapshotAt: "2026-08-19T00:00:00.000Z",
  filters: {
    search: "",
    minKwh: "",
    maxKwh: "",
    minWeightKg: "",
    maxWeightKg: "",
    status: "",
    channel: "",
    sort: "updated_desc" as const,
  },
};

describe("ListingsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the list slim while exposing capacity and weight controls", () => {
    render(<ListingsClient initialPage={initialPage} />);

    expect(screen.getByText("Tesla module stock")).toBeInTheDocument();
    expect(screen.getByText("42 kWh")).toBeInTheDocument();
    expect(screen.getByText("320 kg")).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum capacity in kWh")).toBeInTheDocument();
    expect(screen.getByLabelText("Maximum capacity in kWh")).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum weight in kilograms")).toBeInTheDocument();
    expect(screen.getByLabelText("Maximum weight in kilograms")).toBeInTheDocument();
    expect(screen.getByLabelText("Repeatable target view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy view link" })).toBeInTheDocument();
    expect(screen.queryByText("Description")).toBeNull();
  });

  it("copies the exact URL filter definition for a repeatable view", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<ListingsClient initialPage={initialPage} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy view link" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("http://localhost:3000/platform-admin/listings"));
    expect(screen.getByRole("button", { name: "View link copied" })).toBeInTheDocument();
  });

  it("loads secondary fields into a protected details dialog", async () => {
    getListingDetails.mockResolvedValue({
      ...initialPage.rows[0],
      description: "Detailed pack context",
      manufacturer: "Tesla",
      model: "Model 3",
      format: "module",
      cellChemistryDetail: "NMC 811",
      condition: { state: "used" },
      minimumOrderQuantity: 2,
      originalApplication: "EV",
      yearManufacture: 2020,
      voltageNominal: 400,
      soh: 88,
      evidence: { present: 9, total: 9, missing: [] },
      provenance: { createdByUserId: null, sourceLabel: "supplier_upload", sourceUrl: null, metadata: {} },
      outbound: {
        targetStatus: null,
        currentAvailability: "published",
        buyerSegments: [],
        enquiryCount: 0,
        dealCount: 0,
        offerCount: 0,
        opportunityCount: 0,
        conversationCount: 0,
        lastMarketplaceContactAt: null,
        recentOffers: [],
        opportunityLinks: [],
        conversations: [],
      },
    });

    render(<ListingsClient initialPage={initialPage} />);

    fireEvent.click(screen.getByRole("row", { name: /Open details for Tesla module stock/i }));

    await waitFor(() => expect(screen.getByText("Detailed pack context")).toBeInTheDocument());
    expect(screen.getByText("Tesla")).toBeInTheDocument();
    expect(screen.getByText("Model 3")).toBeInTheDocument();
    expect(screen.getByText("Protected, read-only listing context with provenance and outbound targeting signals.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open authoritative listing/i })).toHaveAttribute("href", "/marketplace/tesla-module-stock");
  });
});
