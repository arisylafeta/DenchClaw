// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WantsTable } from "./company-wants-table";

const line = (over: Record<string, unknown> = {}) => ({
  id: "bi_1", company_id: "co_1", person_id: null, kind: "standing", ownership: "mastered",
  product_key: "broad:lfp-packs", product_key_level: "broad", make: null, model: null, format: "pack",
  chemistry: "LFP", kwh_min: null, kwh_max: null, first_seen: "2026-11-01", last_seen: "2026-11-01",
  quantity: 12, quantity_unit: "packs", quantity_basis: "stated", price: null, price_currency: null,
  price_unit: null, price_basis: null, source_refs: [], expires_on: "2027-01-30", demand_id: null, offer_id: null,
  offer_listing_id: null, saved_search_id: null, decline_reason: null, created_at: "2026-11-01", updated_at: "2026-11-01",
  kind_label: "Standing", label: "LFP, packs", expired: false, source: null, ...over,
});

describe("Wants table", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists mastered and synced lines, and links a synced line to its source", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true, json: async () => ({
        interests: [
          line(),
          line({
            id: "bi_2", kind: "ask", ownership: "synced", product_key_level: "model", make: "Hyundai", model: "Ioniq 5",
            kwh_min: 73, kwh_max: 73, label: "Hyundai Ioniq 5, packs, 73 kWh", kind_label: "Ask", quantity: 4,
            demand_id: "d_9", source: { label: "Demand", href: "/?path=bulk_trade&demand=d_9" },
          }),
        ],
      }),
    });
    render(<WantsTable companyId="co_1" />);
    const region = screen.getByRole("region", { name: "Wants" });
    await waitFor(() => expect(within(region).getByText("LFP, packs")).toBeInTheDocument());
    expect(region).toHaveTextContent("Hyundai Ioniq 5, packs, 73 kWh");
    expect(within(region).getByRole("link", { name: "Demand" })).toHaveAttribute("href", "/?path=bulk_trade&demand=d_9");
    // A synced line is read-only: no edit or expire control on it.
    expect(within(region).queryByLabelText("Edit Hyundai Ioniq 5, packs, 73 kWh")).toBeNull();
    expect(within(region).getByLabelText("Edit LFP, packs")).toBeInTheDocument();
  });

  it("adds a want with the facts it was given", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ interests: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ interest: line({ id: "bi_new" }) }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ interests: [line({ id: "bi_new" })] }) });
    render(<WantsTable companyId="co_1" />);
    await waitFor(() => expect(screen.getByText(/No wants yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Add want" }));
    fireEvent.change(screen.getByLabelText("Make"), { target: { value: "Hyundai" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Ioniq 5" } });
    fireEvent.change(screen.getByLabelText("Minimum kWh"), { target: { value: "73" } });
    fireEvent.change(screen.getByLabelText("Maximum kWh"), { target: { value: "73" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/crm/companies/co_1/interests");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      kind: "standing", make: "Hyundai", model: "Ioniq 5", kwh_min: 73, kwh_max: 73, part_numbers: [],
    });
    await waitFor(() => expect(screen.getByText("LFP, packs")).toBeInTheDocument());
  });

  it("expires a mastered line", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ interests: [line()] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ interest: line({ expired: true }) }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ interests: [line({ expired: true })] }) });
    render(<WantsTable companyId="co_1" />);
    await waitFor(() => expect(screen.getByLabelText("Expire LFP, packs")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Expire LFP, packs"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: "bi_1", action: "expire" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Wants" })).toHaveTextContent("expired"));
  });

  it("shows the API's message when a save is refused", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ interests: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "State the product: a part number, make and model with kWh, a cell, or a chemistry and format." }) });
    render(<WantsTable companyId="co_1" />);
    await waitFor(() => expect(screen.getByText(/No wants yet/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add want" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("State the product"));
  });
});
