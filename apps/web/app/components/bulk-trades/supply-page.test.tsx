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
  it("keeps closed batches accessible for reopening even though the availability feed excludes them", async () => {
    const fetchMock = vi.fn(
      async (url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            url.endsWith("/demand")
              ? { demand: [] }
              : {
                  supply: [batch({ status: "closed", closed_reason: "gone" })],
                  feed: [],
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SupplyPage />);
    await userEvent.click(screen.getByRole("button", { name: /^closed$/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /Jacksons Car Dismantlers/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bulk-trades/supply/bts_1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ action: "reopen" }),
      }),
    );
  });
  it("only suggests eligible open buyers and makes matches beyond five accessible", async () => {
    const eligible = Array.from({ length: 6 }, (_, index) => ({
      id: `d${index}`,
      buyer: `Eligible ${index}`,
      status: "open",
      kind: "standing",
      needed_by: null,
      inventory_matches: [{ id: "trade1", reason: "Explicit match" }],
    }));
    const rows = [
      ...eligible,
      { ...eligible[0], id: "closed", buyer: "Closed buyer", status: "closed" },
      {
        ...eligible[0],
        id: "expired",
        buyer: "Expired buyer",
        kind: "request",
        needed_by: "2000-01-01",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("/demand")
                ? { demand: rows }
                : {
                    supply: [],
                    feed: [
                      {
                        id: "trade1",
                        kind: "trade",
                        title: "Test lot",
                        seller: null,
                        status: "open",
                        size: null,
                        location: null,
                        seen: null,
                        href: "/?path=bulk_trade&trade=trade1",
                        suppliers: [],
                        verified: null,
                        count: null,
                      },
                    ],
                  },
            ),
          ),
      ),
    );
    render(<SupplyPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Test lot/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Suitable buyers" }),
    );
    expect(
      await screen.findByRole("button", { name: "Eligible 0" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Closed buyer" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Expired buyer" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Eligible 5" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "+1 more" }));
    expect(
      screen.getByRole("button", { name: "Eligible 5" }),
    ).toBeInTheDocument();
  });
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
                  ],
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SupplyPage />);
    expect(await screen.findByText("Offer")).toBeInTheDocument();
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
