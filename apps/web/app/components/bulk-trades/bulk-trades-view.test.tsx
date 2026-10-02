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
    ship_by: null, transport_class: null, tfs_needed: "unknown", listing_id: null, auction_slug: null, auction_status: null, auction_closes_at: null, hold_until: null, hold_reason: null, hold_from_stage: null, updated_at: "2026-09-28T09:00:00Z",
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

  it("folds on-hold trades at the bottom of the list, and asks for a date and reason when a card is dropped on hold", async () => {
    const held = trade({ id: "bt_h", title: "Synthetic BESS portfolio", trade_stage: "On hold", hold_until: "2099-03-01",
      hold_reason: "Batteries stay on site until removal", hold_from_stage: "With buyers" });
    const live = trade({ id: "bt_l", title: "Synthetic packs" });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH"
      ? new Response(JSON.stringify({ trade: { ...live, ...JSON.parse(String(init.body)) } }))
      : new Response(JSON.stringify({ trades: [held, live], owners: [] })));
    vi.stubGlobal("fetch", fetchMock);
    render(<BulkTradesView />);

    const group = await screen.findByRole("region", { name: "On hold" });
    expect(within(group).queryByText("Synthetic BESS portfolio")).not.toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: /On hold/ }));
    expect(within(group).getByText("Synthetic BESS portfolio")).toBeInTheDocument();
    expect(within(group).getByText("Until 1 Mar 2099")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Board" }));
    const column = screen.getByRole("region", { name: "On hold" });
    expect(within(column).getByText("Batteries stay on site until removal")).toBeInTheDocument();
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: /Synthetic packs/ }), { dataTransfer: transfer });
    fireEvent.drop(column, { dataTransfer: transfer });
    const dialog = await screen.findByRole("dialog", { name: /Put on hold/ });
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("bt_l"), expect.anything());
    await userEvent.click(within(dialog).getByRole("button", { name: "3 months" }));
    await userEvent.type(within(dialog).getByLabelText("Why it waits"), "Seller relocating stock");
    await userEvent.click(within(dialog).getByRole("button", { name: "Put on hold" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_l", expect.objectContaining({ method: "PATCH" })));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body));
    expect(body).toMatchObject({ trade_stage: "On hold", hold_reason: "Seller relocating stock" });
    expect(body.hold_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
