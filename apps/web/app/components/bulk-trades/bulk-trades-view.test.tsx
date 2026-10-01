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
    next_step_contact_id: null, next_step_buyer_id: null,
    owner_user_id: null, owner_name: null, value: null, last_touched: null, clear_by: null,
    ship_by: null, transport_class: null, tfs_needed: "unknown", listing_id: null, auction_slug: null, auction_status: null, auction_closes_at: null, updated_at: "2026-09-28T09:00:00Z",
    ...overrides,
  };
}

const TRADES = [
  trade({ id: "bt_1", title: "Synthetic eBS37", fact_line: "161 packs", value: "€119–149k", new_count: 2 }),
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

  it("shows new-item counts, the inbox check status and possible new trades", async () => {
    const possible = {
      id: "7", lot_id: null, kind: "possible_trade", target: null, proposed: { title: "Leaf packs, Leeds" },
      summary: "400 Leaf packs offered", quote: "400 Nissan Leaf battery packs available", source_kind: "gmail",
      source_url: null, source_label: "Gmail · seller@unknown.test", source_at: null, created_at: "2026-09-29T12:00:00Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/bulk-trades"
      ? { trades: TRADES, owners: [], check: { last_run_at: "2026-09-29T12:00:00Z", status: "failed", error: "boom" }, possible: [possible] }
      : { trade: TRADES[0], buyers: [], contacts: [], fields: [], files: [] }))));
    render(<BulkTradesView />);

    expect(await screen.findByText("2 new")).toBeInTheDocument();
    expect(screen.getByText(/Gmail and Granola check failed 13:00/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Possible new trade from your inbox/ }));
    expect(screen.getByText("Leaf packs, Leeds")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create trade" })).toBeInTheDocument();
  });
});

