// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { todayInLondon, type BulkTrade } from "@/lib/bulk-trades";
import { BulkTradesView } from "./bulk-trades-view";
import { forgetShared } from "./trade-ui";

// `useSearchParams` follows the History API the way Next's router does.
const urlListeners = new Set<() => void>();
vi.mock("next/navigation", async () => {
  const react = await import("react");
  return {
    useSearchParams: () => {
      const [, rerender] = react.useReducer((n: number) => n + 1, 0);
      react.useEffect(() => { urlListeners.add(rerender); return () => { urlListeners.delete(rerender); }; }, []);
      return new URLSearchParams(window.location.search);
    },
  };
});
const nativePush = window.history.pushState.bind(window.history);
const nativeReplace = window.history.replaceState.bind(window.history);
window.history.pushState = (...args) => { nativePush(...args); urlListeners.forEach((l) => l()); };
window.history.replaceState = (...args) => { nativeReplace(...args); urlListeners.forEach((l) => l()); };
window.addEventListener("popstate", () => urlListeners.forEach((l) => l()));

const today = todayInLondon();

function trade(overrides: Partial<BulkTrade>): BulkTrade {
  return {
    origin: "supply", seller_ref: null, seller_name: null, has_seller: false, has_buyer: false,
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
    if (url === "/api/bulk-trades/demand") return new Response(JSON.stringify({ demand: [], possible: [] }));
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
  beforeEach(() => { forgetShared(); window.localStorage.clear(); window.localStorage.setItem("bulk-trades:view", "board"); nativeReplace(null, "", "/?path=bulk_trade"); });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to Today and never shows empty work lists before trades have loaded", async () => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<BulkTradesView />);
    expect(await screen.findByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Loading today's work…")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs attention.")).not.toBeInTheDocument();
  });

  it("remembers Trades and keeps closed trades off the board", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response("{}")));
    render(<BulkTradesView />);
    expect(await screen.findByRole("button", { name: "Trades" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Synthetic eBS37")).toBeInTheDocument();
    expect(screen.queryByText("Old lot")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "List" })).not.toBeInTheDocument();
  });

  it("moves a card to the dropped stage and saves it", async () => {
    const fetchMock = mockFetch((body) =>
      new Response(JSON.stringify({ trade: { ...TRADES[0], ...body } })));
    vi.stubGlobal("fetch", fetchMock);
    render(<BulkTradesView />);
    await screen.findByText("Synthetic eBS37");

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
    await screen.findByText("Synthetic eBS37");

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

    await userEvent.click(screen.getByRole("button", { name: "Bulk Trades" }));
    expect(await screen.findByRole("region", { name: "With buyers" })).toBeInTheDocument();
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

    expect(await screen.findByRole("img", { name: /Check failed/ })).toHaveAttribute("title", expect.stringContaining("boom"));
    await userEvent.click(screen.getByRole("button", { name: /Inbox · 1/ }));
    expect(screen.getByText("400 Leaf packs offered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create trade" })).toBeInTheDocument();
  });

  it("refreshes mounted demand after accepting an inbox proposal", async () => {
    let accepted = false;
    const proposal = {
      id: "demand-proposal", kind: "possible_demand", lot_id: null, target: null,
      proposed: { buyer: "New buyer" }, summary: "New buyer wants packs", quote: "We need packs",
      source_kind: "gmail", source_label: "Gmail", source_url: null, source_at: null, created_at: "2026-10-16T09:00:00Z",
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/bulk-trades/proposals/demand-proposal" && init?.method === "POST") {
        accepted = true;
        return new Response(JSON.stringify({ lot_id: null }));
      }
      if (url === "/api/bulk-trades/demand") return new Response(JSON.stringify({
        demand: accepted ? [{ id: "new-demand", buyer: "New buyer", wants: "Tested packs", status: "open", spec: {},
          fee_eur: null, price_basis: null, reputation: null, observed_on: today, confirmed_on: null,
          activity_count: 0, last_activity_at: null, fits: [], inventory_matches: [], context_notes: [], missing: [], score: null }] : [],
        possible: accepted ? [] : [proposal],
      }));
      return new Response(JSON.stringify({ trades: TRADES, owners: [], possible: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BulkTradesView />);
    await userEvent.click(await screen.findByRole("button", { name: "Demand" }));
    expect(await screen.findByText("No demand here.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Inbox · 1/ }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add demand" }));
    await waitFor(() => expect(screen.getByText("Inbox clear.")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("button", { name: /New buyer/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/proposals/demand-proposal", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "accept" }) }));
  });

  it("keeps accepted no-trade demand source-linked and shows conflict-checked undo", async () => {
    const proposal = {id:"accepted-demand",kind:"possible_demand",summary:"Synthetic accepted demand",
      source_url:"/whatsapp/threads/synthetic#message-synthetic",source_kind:"whatsapp"};
    let undone = false, conflict = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/bulk-trades/proposals/accepted-demand" && init?.method === "POST") {
        if (conflict) return new Response(JSON.stringify({error:"That demand has changed since."}),{status:409});
        undone = true;
        return new Response(JSON.stringify({lot_id:null}));
      }
      if (url === "/api/bulk-trades/demand") return new Response(JSON.stringify({demand:[],possible:[],accepted:undone ? [] : [proposal]}));
      return new Response(JSON.stringify({trades:TRADES,owners:[],possible:[]}));
    });
    vi.stubGlobal("fetch",fetchMock);
    render(<BulkTradesView />);
    await screen.findByText("Synthetic eBS37");
    await userEvent.click(screen.getByRole("button",{name:/Inbox/}));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("link",{name:"Source"})).toHaveAttribute("href",proposal.source_url);
    await userEvent.click(within(dialog).getByRole("button",{name:"Undo"}));
    expect(await within(dialog).findByText("That demand has changed since.")).toBeInTheDocument();
    conflict = false;
    await userEvent.click(within(dialog).getByRole("button",{name:"Undo"}));
    await waitFor(() => expect(within(dialog).queryByText(proposal.summary)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/proposals/accepted-demand",expect.objectContaining({body:JSON.stringify({action:"undo"})}));
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

    const column = await screen.findByRole("region", { name: "On hold" });
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

  it("opens the trade named in the URL and keeps it in the URL", async () => {
    nativeReplace(null, "", "/?path=bulk_trade&trade=bt_1");
    vi.stubGlobal("fetch", mockFetch(() => new Response("{}")));
    render(<BulkTradesView />);
    expect(await screen.findByRole("heading", { level: 1, name: "Synthetic eBS37" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Bulk Trades" }));
    expect(await screen.findByRole("region", { name: "With buyers" })).toBeInTheDocument();
    expect(window.location.search).not.toContain("trade=");
  });

  it("keeps the tab in the URL, and back/forward move between tabs", async () => {
    vi.stubGlobal("fetch", mockFetch(() => new Response("{}")));
    render(<BulkTradesView />);
    await userEvent.click(await screen.findByRole("button", { name: "Demand" }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("demand");
    expect(screen.getByRole("button", { name: "Demand" })).toHaveAttribute("aria-pressed", "true");

    nativeReplace(null, "", "/?path=bulk_trade&tab=today");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("opens a demand link on the Demand tab even when Trades was the last tab", async () => {
    nativeReplace(null, "", "/?path=bulk_trade&demand=dm_1");
    vi.stubGlobal("fetch", mockFetch(() => new Response("{}")));
    render(<BulkTradesView />);
    expect(await screen.findByRole("button", { name: "Demand" })).toHaveAttribute("aria-pressed", "true");
  });
});
