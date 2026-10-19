// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { todayInLondon } from "@/lib/bulk-trades";
import type { SheetRow } from "@/lib/bulk-sheet";
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

function row(overrides: Partial<SheetRow>): SheetRow {
  return {
    key: "demand:d1", kind: "demand", id: "d1", side: "buyer", title: "12 Ioniq packs", company: "H. Nolden", company_id: null,
    category: "Ioniq", progress: "New", tone: "new", latest: null, next_action: null, next_due: null, owner: null, touched: "2026-10-01",
    ...overrides,
  };
}

const ROWS: SheetRow[] = [
  row({}),
  row({ key: "supply:s1", kind: "supply", id: "s1", side: "seller", title: "3 hybrid packs", company: "Seller Ltd", category: "packs", progress: "Offered",
    latest: { label: "Offer by email", at: "2026-10-07" } }),
  row({ key: "trade:bt_1", kind: "trade", id: "bt_1", side: "both", title: "Synthetic eBS37", company: "Seller Ltd", category: "packs", progress: "With buyers",
    tone: "active", next_action: "Call the buyer", owner: "Alex", next_due: today }),
];

const TRADE = {
  origin: "supply", seller_ref: null, seller_name: null, has_seller: false, has_buyer: false, id: "bt_1", title: "Synthetic eBS37",
  trade_stage: "With buyers", trade_kind: null, fact_line: "161 packs", next_step: "Follow up", next_step_due: today, waiting_on: "us",
  waiting_since: null, next_step_contact_id: null, next_step_buyer_id: null, owner_user_id: null, owner_name: null, value: null,
  last_touched: null, clear_by: null, ship_by: null, transport_class: null, tfs_needed: "unknown", listing_id: null, auction_slug: null,
  auction_status: null, auction_closes_at: null, hold_until: null, hold_reason: null, hold_from_stage: null, updated_at: "2026-09-28T09:00:00Z",
};

type Api = { inbox?: unknown; sheet?: SheetRow[]; hangInbox?: boolean };
function mockApi({ inbox, sheet = ROWS, hangInbox }: Api = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/bulk-trades/sheet") return new Response(JSON.stringify({ rows: sheet }));
    if ((url === "/api/bulk-trades" || url === "/api/bulk-trades/demand") && hangInbox) return new Promise<Response>(() => {});
    if (url === "/api/bulk-trades/demand") return new Response(JSON.stringify({ demand: [], possible: [], accepted: [] }));
    if (url === "/api/bulk-trades") return new Response(JSON.stringify(inbox ?? { trades: [], owners: [] }));
    if (url === "/api/bulk-trades/bt_1" && init?.method === "PATCH") return new Response(JSON.stringify({ trade: { ...TRADE, ...JSON.parse(String(init.body)) } }));
    if (url === "/api/bulk-trades/bt_1") return new Response(JSON.stringify({ trade: TRADE, buyers: [], contacts: [], fields: [], files: [] }));
    return new Response("{}");
  });
}

describe("Bulk Trades sheet", () => {
  beforeEach(() => { forgetShared(); window.localStorage.clear(); nativeReplace(null, "", "/?path=bulk_trade"); });
  afterEach(() => vi.unstubAllGlobals());

  it("shows one row per source record with its company, progress, latest development and next action, and no tabs", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<BulkTradesView />);
    expect(await screen.findByRole("button", { name: /12 Ioniq packs/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /3 hybrid packs/ })).toBeInTheDocument();
    const trade = screen.getByRole("button", { name: /Synthetic eBS37/ });
    expect(within(trade).getByText("With buyers")).toBeInTheDocument();
    expect(within(trade).getByText("Call the buyer")).toBeInTheDocument();
    expect(within(trade).getByText(/Alex/)).toBeInTheDocument();
    expect(screen.getByText("3 of 3 open")).toBeInTheDocument();
    for (const gone of ["Today", "Trades", "Demand", "Supply"]) expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
  });

  it("says plainly when a value is not recorded instead of guessing", async () => {
    vi.stubGlobal("fetch", mockApi({ sheet: [row({ company: null })] }));
    render(<BulkTradesView />);
    const demand = await screen.findByRole("button", { name: /12 Ioniq packs/ });
    expect(within(demand).getByText("No company recorded")).toBeInTheDocument();
    expect(within(demand).getByText("No next action set")).toBeInTheDocument();
    expect(within(demand).getByText("Nothing recorded")).toBeInTheDocument();
  });

  it("filters by search and starting point, and keeps the filters in the URL", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<BulkTradesView />);
    await screen.findByRole("button", { name: /12 Ioniq packs/ });
    await userEvent.click(screen.getByRole("button", { name: "Seller-led" }));
    expect(screen.queryByRole("button", { name: /12 Ioniq packs/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /3 hybrid packs/ })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("side")).toBe("seller");

    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await userEvent.type(screen.getByRole("searchbox"), "nolden");
    expect(screen.getByText("1 of 3 open")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("q")).toBe("nolden");

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("3 of 3 open")).toBeInTheDocument();
    expect(window.location.search).toBe("?path=bulk_trade");
  });

  it("opens a filtered view from a link, and an older tab=demand link as buyer-led", async () => {
    nativeReplace(null, "", "/?path=bulk_trade&progress=Offered");
    vi.stubGlobal("fetch", mockApi());
    const first = render(<BulkTradesView />);
    expect(await screen.findByText("1 of 3 open")).toBeInTheDocument();
    expect(screen.getByLabelText("Progress")).toHaveValue("Offered");
    first.unmount();

    nativeReplace(null, "", "/?path=bulk_trade&tab=demand");
    render(<BulkTradesView />);
    expect(await screen.findByText("1 of 3 open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buyer-led" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens a trade by link or by click, and Back returns to the same filtered sheet", async () => {
    nativeReplace(null, "", "/?path=bulk_trade&side=both");
    vi.stubGlobal("fetch", mockApi());
    render(<BulkTradesView />);
    await userEvent.click(await screen.findByRole("button", { name: /Synthetic eBS37/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Synthetic eBS37" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("trade")).toBe("bt_1");

    await userEvent.click(screen.getByRole("button", { name: "Bulk Trades" }));
    expect(await screen.findByText("1 of 3 open")).toBeInTheDocument();
    expect(window.location.search).toBe("?path=bulk_trade&side=both");
  });

  it("clicking a demand row opens that demand by id", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<BulkTradesView />);
    await userEvent.click(await screen.findByRole("button", { name: /12 Ioniq packs/ }));
    expect(new URLSearchParams(window.location.search).get("demand")).toBe("d1");
  });

  it("shows the rows while the inbox is still loading", async () => {
    vi.stubGlobal("fetch", mockApi({ hangInbox: true }));
    render(<BulkTradesView />);
    expect(await screen.findByRole("button", { name: /12 Ioniq packs/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inbox · 0/ })).toBeInTheDocument();
  });

  it("distinguishes loading, an empty sheet and a filter that matches nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const loading = render(<BulkTradesView />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    loading.unmount();

    forgetShared();
    vi.stubGlobal("fetch", mockApi({ sheet: [] }));
    render(<BulkTradesView />);
    expect(await screen.findByText("Nothing open right now.")).toBeInTheDocument();
  });

  it("shows the sheet's error and keeps the page usable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bulk-trades/sheet"
      ? new Response(JSON.stringify({ error: "Database unavailable" }), { status: 500 }) : new Response(JSON.stringify({ trades: [], owners: [] }))));
    render(<BulkTradesView />);
    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    expect(screen.getByText("The sheet could not load.")).toBeInTheDocument();
  });

  it("shows the inbox check status and possible new trades", async () => {
    const possible = {
      id: "7", lot_id: null, kind: "possible_trade", target: null, proposed: { title: "Leaf packs, Leeds" },
      summary: "400 Leaf packs offered", quote: "400 Nissan Leaf battery packs available", source_kind: "gmail",
      source_url: null, source_label: "Gmail · seller@unknown.test", source_at: null, created_at: "2026-09-29T12:00:00Z",
    };
    vi.stubGlobal("fetch", mockApi({ inbox: { trades: [], owners: [], check: { last_run_at: "2026-09-29T12:00:00Z", status: "failed", error: "boom" }, possible: [possible] } }));
    render(<BulkTradesView />);
    expect(await screen.findByRole("img", { name: /Check failed/ })).toHaveAttribute("title", expect.stringContaining("boom"));
    await userEvent.click(screen.getByRole("button", { name: /Inbox · 1/ }));
    expect(screen.getByText("400 Leaf packs offered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create trade" })).toBeInTheDocument();
  });

  it("keeps accepted no-trade demand source-linked and shows conflict-checked undo", async () => {
    const proposal = { id: "accepted-demand", kind: "possible_demand", summary: "Synthetic accepted demand",
      source_url: "/whatsapp/threads/synthetic#message-synthetic", source_kind: "whatsapp" };
    let undone = false, conflict = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/bulk-trades/proposals/accepted-demand" && init?.method === "POST") {
        if (conflict) return new Response(JSON.stringify({ error: "That demand has changed since." }), { status: 409 });
        undone = true;
        return new Response(JSON.stringify({ lot_id: null }));
      }
      if (url === "/api/bulk-trades/sheet") return new Response(JSON.stringify({ rows: ROWS }));
      if (url === "/api/bulk-trades/demand") return new Response(JSON.stringify({ demand: [], possible: [], accepted: undone ? [] : [proposal] }));
      return new Response(JSON.stringify({ trades: [], owners: [], possible: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BulkTradesView />);
    await screen.findByRole("button", { name: /Synthetic eBS37/ });
    await userEvent.click(await screen.findByRole("button", { name: /Inbox/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Source" })).toHaveAttribute("href", proposal.source_url);
    await userEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
    expect(await within(dialog).findByText("That demand has changed since.")).toBeInTheDocument();
    conflict = false;
    await userEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(within(dialog).queryByText(proposal.summary)).not.toBeInTheDocument());
  });

  it("sends only the changed fields when a trade is edited", async () => {
    nativeReplace(null, "", "/?path=bulk_trade&trade=bt_1");
    const fetchMock = mockApi();
    vi.stubGlobal("fetch", fetchMock);
    render(<BulkTradesView />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit trade" }));
    await userEvent.selectOptions(screen.getByLabelText("Waiting on"), "them");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_1", expect.objectContaining({ body: JSON.stringify({ waiting_on: "them" }) })));
  });

  it("the Add menu starts a new trade", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<BulkTradesView />);
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New trade" }));
    expect(await screen.findByRole("button", { name: "Create trade" })).toBeInTheDocument();
  });
});
