// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Supply } from "@/lib/bulk-supply";
import { SupplyPage } from "./supply-page";

function batch(overrides: Partial<Supply>): Supply {
  return {
    context_notes: [],
    id: "bts_1",
    seller: "Jacksons Car Dismantlers",
    company_id: null,
    person_id: null,
    contact: "Sophie",
    email: "sophie@jacksons.example",
    offers: "3 Toyota hybrid packs",
    trade_kind: "packs",
    quantity: "three",
    location: "UK",
    est_tonnes: 0.12,
    est_value_usd: null,
    size_note: "3 x 1.3 kWh",
    source_kind: "email",
    source_label: "Email (added automatically)",
    source_url: null,
    source_quote: "three hybrid batteries",
    observed_on: "2026-10-07",
    status: "open",
    closed_reason: null,
    updated_at: "2026-10-07T10:00:00Z",
    fits: [
      {
        demand_id: "btd_1",
        buyer: "Spagnesi Lab",
        contact: "Massimo",
        email: null,
        wants: "Two packs for testing",
        kind: "request",
        basis: null,
        strength: "partial",
        reason: "Packs for testing, but hybrid not 60 kWh.",
      },
    ],
    ...overrides,
  };
}

describe("Unified supply", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("renders kinds and opens suitable buyers with explicit match reasons", async () => {
    const fetchMock = vi.fn(
      async (url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            url === "/api/bulk-trades/demand"
              ? { demand: [] }
              : {
                  supply: [batch({})],
                  feed: [
                    {
                      id: "supply:bts_1",
                      kind: "supply",
                      title: "3 Toyota hybrid packs",
                      seller: "Jacksons Car Dismantlers",
                      size: "~0.1 t",
                      location: "UK",
                      seen: "2026-10-07",
                      status: "open",
                      href: "/?path=bulk_trade&supply=bts_1",
                      suppliers: [],
                      verified: null,
                      count: null,
                    },
                    {
                      id: "stock:1",
                      kind: "stock",
                      title: "Stock summary",
                      seller: null,
                      size: null,
                      location: null,
                      seen: null,
                      status: "open",
                      href: "/?path=stock",
                      suppliers: [],
                      verified: null,
                      count: null,
                    },
                  ],
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SupplyPage />);
    expect(await screen.findByText("Offer")).toBeInTheDocument();
    expect(screen.getByText("Stock")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Jacksons Car Dismantlers/ }),
    );
    const panel = screen.getByRole("dialog", { name: "Supply detail" });
    await userEvent.click(
      within(panel).getByRole("button", { name: "Suitable buyers" }),
    );
    expect(
      within(panel).getByText("Packs for testing, but hybrid not 60 kWh."),
    ).toBeInTheDocument();
    await userEvent.click(
      within(panel).getByRole("button", { name: "Not a fit" }),
    );
    const patch = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      action: "hide_fit",
      demand_id: "btd_1",
    });
  });
});
