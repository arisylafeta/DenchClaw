// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StockClient } from "./stock-client";
import type { StockPage } from "./contract";

const { replace, getStockDetails } = vi.hoisted(() => ({
  replace: vi.fn(),
  getStockDetails: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("./actions", () => ({ getStockDetails }));

const initialPage: StockPage = {
  rows: [{
    id: "stock-1234567890abcdef12345678",
    stockId: "synetiq:123",
    supplier: "Synetiq",
    make: "MG",
    model: "4",
    year: "2023",
    partNumber: "PN-1",
    quantity: 1,
    location: "Winsford",
    chemistry: "LFP",
    capacityKwh: 51,
    scope: "complete_pack_candidate",
    stockStatus: "unverified",
    commercialBucket: "LFP_confirmation_required",
    enrichStatus: "pending",
    createdAt: "2026-09-22T17:32:59.121Z",
    updatedAt: "2026-09-22T17:32:59.121Z",
  }],
  totalCount: 1,
  allCount: 1028,
  page: 1,
  pageSize: 50,
  totalPages: 1,
  snapshotAt: "2026-09-22T18:00:00.000Z",
  filters: {
    search: "",
    supplier: "",
    status: "",
    chemistry: "",
    scope: "",
    commercialBucket: "",
    sort: "updated_desc",
  },
  options: {
    suppliers: ["Synetiq"],
    chemistries: ["LFP"],
    scopes: ["complete_pack_candidate"],
    commercialBuckets: ["LFP_confirmation_required"],
  },
};

describe("StockClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the shared Dench table styling and stock controls", () => {
    render(<StockClient initialPage={initialPage} />);
    expect(screen.getByRole("heading", { name: "Stock" })).toBeInTheDocument();
    expect(screen.getByText("synetiq:123")).toBeInTheDocument();
    expect(screen.getByText("1,028 total")).toBeInTheDocument();
    expect(screen.getByLabelText("Search stock")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by stock status")).toBeInTheDocument();
  });

  it("opens the standard right-side detail sheet", async () => {
    getStockDetails.mockResolvedValue({
      ...initialPage.rows[0],
      modelDetail: null,
      powertrain: "BEV",
      description: "Complete battery pack",
      price: null,
      condition: null,
      comments: null,
      voltageV: 400,
      weightKg: 350,
      partNumberStatus: null,
      conditionDetail: null,
      sohPercent: null,
      tested: null,
      completeness: null,
      photoUrls: [],
      evidence: { reb330_import: { source_row: "r1" } },
      attributes: {},
      supplierConfirmed: false,
      supplierConfirmedAt: null,
      aged12m: true,
      inAugust: true,
      inSeptemberAged: true,
      listingId: null,
      enrichedAt: null,
    });
    render(<StockClient initialPage={initialPage} />);
    fireEvent.click(screen.getByRole("row", { name: /Open details for Synetiq synetiq:123/i }));
    await waitFor(() => expect(screen.getByText("Complete battery pack")).toBeInTheDocument());
    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveClass("platform-admin-sheet-content");
    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveAttribute("data-sheet-side", "right");
    expect(screen.getAllByText("22 Sept 2026, 17:32")).toHaveLength(2);
  });

  it("paginates with applied filters instead of unsaved filter edits", async () => {
    render(
      <StockClient
        initialPage={{ ...initialPage, totalCount: 100, allCount: 100, totalPages: 2 }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search stock"), {
      target: { value: "unsaved search" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/platform-admin/stock?page=2"),
    );
  });

  it("ignores a stale detail response after another row is selected", async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    const firstRequest = new Promise((resolve) => { resolveFirst = resolve; });
    const secondRow = {
      ...initialPage.rows[0],
      id: "stock-abcdef1234567890abcdef12",
      stockId: "synetiq:456",
    };
    const detail = (row: typeof initialPage.rows[number], description: string) => ({
      ...row,
      modelDetail: null,
      powertrain: null,
      description,
      price: null,
      condition: null,
      comments: null,
      voltageV: null,
      weightKg: null,
      partNumberStatus: null,
      conditionDetail: null,
      sohPercent: null,
      tested: null,
      completeness: null,
      photoUrls: [],
      evidence: {},
      attributes: {},
      supplierConfirmed: false,
      supplierConfirmedAt: null,
      aged12m: false,
      inAugust: true,
      inSeptemberAged: false,
      listingId: null,
      enrichedAt: null,
    });
    getStockDetails.mockImplementation((id: string) =>
      id === initialPage.rows[0].id
        ? firstRequest
        : Promise.resolve(detail(secondRow, "Second row detail")),
    );

    render(<StockClient initialPage={{ ...initialPage, rows: [initialPage.rows[0], secondRow] }} />);
    fireEvent.click(screen.getByRole("row", { name: /synetiq:123/i }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("row", { name: /synetiq:456/i }));
    await waitFor(() => expect(screen.getByText("Second row detail")).toBeInTheDocument());
    await act(async () => resolveFirst(detail(initialPage.rows[0], "Stale first detail")));
    expect(screen.queryByText("Stale first detail")).toBeNull();
    expect(screen.getByText("Second row detail")).toBeInTheDocument();
  });
});
