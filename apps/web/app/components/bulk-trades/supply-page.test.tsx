// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Supply } from "@/lib/bulk-supply";
import { SupplyPage } from "./supply-page";

function batch(overrides: Partial<Supply>): Supply {
  return {
    id: "bts_1", seller: "Jacksons Car Dismantlers", company_id: null, person_id: null, contact: "Sophie", email: "sophie@jacksons.example",
    offers: "3 Toyota hybrid packs", trade_kind: "packs", quantity: "three", location: "UK", est_tonnes: 0.12, est_value_usd: null,
    size_note: "3 x 1.3 kWh", source_kind: "email", source_label: "Email (added automatically)", source_url: null,
    source_quote: "three hybrid batteries", observed_on: "2026-10-07", status: "open", closed_reason: null,
    updated_at: "2026-10-07T10:00:00Z",
    fits: [{ demand_id: "btd_1", buyer: "Spagnesi Lab", contact: "Massimo", email: null, wants: "Two packs for testing",
      kind: "request", basis: null, strength: "partial", reason: "Packs for testing, but hybrid not 60 kWh." }],
    ...overrides,
  };
}

const ROWS = [batch({}), batch({ id: "bts_2", seller: "Old Seller", offers: "18650 cells", est_tonnes: null, fits: [], status: "closed", closed_reason: "sold" })];

describe("SupplyPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists open batches with their estimated size and buyers, and hides a fit from the panel", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/bulk-trades/supply") return new Response(JSON.stringify({ supply: ROWS, matched: null }));
      return new Response(JSON.stringify({ supply: { ...ROWS[0], fits: [] } }));
    });
    vi.stubGlobal("fetch", fetch);
    render(<SupplyPage />);
    const table = await screen.findByRole("region", { name: "Supply" });
    expect(screen.getByRole("button", { name: "Open 1" })).toHaveAttribute("aria-pressed", "true");
    expect(within(table).getByText("~0.1 t")).toBeInTheDocument();
    expect(within(table).queryByText("Old Seller")).not.toBeInTheDocument();

    await userEvent.click(within(table).getByText("Jacksons Car Dismantlers"));
    const panel = screen.getByRole("complementary", { name: "Supply detail" });
    expect(within(panel).getByText("Packs for testing, but hybrid not 60 kWh.")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Not a fit" }));
    const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[0]).toBe("/api/bulk-trades/supply/bts_1");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ action: "hide_fit", demand_id: "btd_1" });

    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(within(table).getByText("Old Seller")).toBeInTheDocument();
    expect(within(table).getByText("Unknown")).toBeInTheDocument();
  });
});
