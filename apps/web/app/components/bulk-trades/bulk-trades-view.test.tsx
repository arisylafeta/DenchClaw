// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { todayInLondon, type BulkTrade } from "@/lib/bulk-trades";
import { BulkTradesView } from "./bulk-trades-view";

const today = todayInLondon();

function trade(overrides: Partial<BulkTrade>): BulkTrade {
  return {
    id: "t", title: "Trade", trade_stage: "With buyers", trade_kind: null, fact_line: null,
    next_step: "Follow up", next_step_due: today, waiting_on: "us", waiting_since: null,
    owner_user_id: null, owner_name: null, value: null, last_touched: null, clear_by: null,
    ship_by: null, transport_class: null, tfs_needed: "unknown", listing_id: null, updated_at: "2026-09-28T09:00:00Z",
    ...overrides,
  };
}

const TRADES = [
  trade({ id: "bt_1", title: "Synthetic eBS37", fact_line: "161 packs", value: "€119–149k" }),
  trade({ id: "bt_2", title: "Synthetic cells", trade_stage: "Needs info", next_step: null, next_step_due: null }),
  trade({ id: "bt_3", title: "Old lot", trade_stage: "Done" }),
];

function mockFetch(patchResponse: (body: Record<string, unknown>) => Response) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return patchResponse(JSON.parse(String(init.body)));
    const one = TRADES.find((candidate) => url === `/api/bulk-trades/${candidate.id}`);
    if (one) return new Response(JSON.stringify({ trade: one, buyers: [], contacts: [], fields: [], files: [] }));
    return new Response(JSON.stringify({ trades: TRADES, owners: [] }));
  });
}

function dataTransfer() {
  const data: Record<string, string> = {};
  return { setData: (k: string, v: string) => { data[k] = v; }, getData: (k: string) => data[k] ?? "" };
}

describe("BulkTradesView", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("lists live trades by group and hides closed ones", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response("{}")));
    render(<BulkTradesView />);

    const dueToday = await screen.findByRole("region", { name: "Due today" });
    expect(within(dueToday).getByText("Synthetic eBS37")).toBeInTheDocument();
    expect(within(dueToday).getByText("161 packs")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "No next step" })).getByText("Synthetic cells")).toBeInTheDocument();
    expect(screen.queryByText("Old lot")).not.toBeInTheDocument();
    expect(screen.getByText(/2 live/)).toBeInTheDocument();
  });

  it("moves a card to the dropped stage and saves it", async () => {
    const fetchMock = mockFetch((body) =>
      new Response(JSON.stringify({ trade: { ...TRADES[0], ...body } })));
    vi.stubGlobal("fetch", fetchMock);
    render(<BulkTradesView />);
    await userEvent.click(await screen.findByRole("button", { name: "Board" }));

    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: /Synthetic eBS37/ }), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("region", { name: "Closing" }), { dataTransfer: transfer });

    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Closing" })).getByText("Synthetic eBS37")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ trade_stage: "Closing" }),
    }));
  });

  it("puts the card back and says so when the save fails", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response(JSON.stringify({ error: "Unknown stage." }), { status: 400 })));
    render(<BulkTradesView />);
    await userEvent.click(await screen.findByRole("button", { name: "Board" }));

    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: /Synthetic eBS37/ }), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("region", { name: "Closing" }), { dataTransfer: transfer });

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not move Synthetic eBS37: Unknown stage.");
    expect(within(screen.getByRole("region", { name: "With buyers" })).getByText("Synthetic eBS37")).toBeInTheDocument();
  });

  it("opens a trade page and goes back to the list", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response("{}")));
    render(<BulkTradesView />);

    await userEvent.click(await screen.findByRole("button", { name: /Synthetic eBS37/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Synthetic eBS37" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("button", { name: "Bulk Trades" }));
    expect(await screen.findByRole("region", { name: "Due today" })).toBeInTheDocument();
  });

  it("sends only the changed fields when a trade is edited", async () => {
    const fetchMock = mockFetch((body) => new Response(JSON.stringify({ trade: { ...TRADES[0], ...body } })));
    vi.stubGlobal("fetch", fetchMock);
    render(<BulkTradesView />);

    await userEvent.click(await screen.findByRole("button", { name: /Synthetic eBS37/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit trade" }));
    await userEvent.selectOptions(screen.getByLabelText("Waiting on"), "them");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_1", expect.objectContaining({
      body: JSON.stringify({ waiting_on: "them" }),
    })));
  });
});
