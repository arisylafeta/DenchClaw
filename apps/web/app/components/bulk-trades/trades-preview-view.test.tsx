// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { todayInLondon } from "@/lib/bulk-trades";
import type { SheetRow } from "@/lib/bulk-sheet";
import { TradesPreviewView } from "./trades-preview-view";
import { forgetShared } from "./trade-ui";

vi.mock("./listing-detail", () => ({
  ListingDetail: ({ id, onClose, onOpenListing }: { id: string; onClose: () => void; onOpenListing: (id: string) => void }) =>
    <section><h1>Listing {id}</h1><button onClick={onClose}>Back</button><button onClick={() => onOpenListing("s1")}>Related listing</button></section>,
}));

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
// Next's patched History API only syncs `useSearchParams` for calls that do NOT carry its own `__NA` state;
// a call that does is treated as Next's internal one and skipped. This mock keeps that rule, and the tests
// seed `__NA` into the starting state the way Next does, so a push that passes `history.state` along fails here.
const NEXT_STATE = { __NA: true };
const isInternal = (data: unknown) => !!(data as { __NA?: boolean } | null)?.__NA;
window.history.pushState = (data, unused, url) => { nativePush(data, unused, url); if (!isInternal(data)) urlListeners.forEach((l) => l()); };
window.history.replaceState = (data, unused, url) => { nativeReplace(data, unused, url); if (!isInternal(data)) urlListeners.forEach((l) => l()); };
window.addEventListener("popstate", () => urlListeners.forEach((l) => l()));

const today = todayInLondon();

function row(overrides: Partial<SheetRow>): SheetRow {
  return {
    key: "demand:d1", kind: "demand", id: "d1", side: "buyer", title: "12 Ioniq packs", company: "H. Nolden", company_id: null,
    category: "Ioniq", progress: "New", tone: "new", score: null, latest: null, next_action: null, next_due: null, owner: null, touched: "2026-10-01",
    ...overrides,
  };
}

const ROWS: SheetRow[] = [
  row({}),
  row({ key: "supply:s1", kind: "supply", id: "s1", side: "seller", title: "3 hybrid packs", company: "Seller Ltd", category: "packs", progress: "Offered",
    latest: { label: "Offer by email", at: "2026-10-07" } }),
  row({ key: "bt_1", kind: "supply", id: "bt_1", side: "seller", title: "Synthetic eBS37", company: "Seller Ltd", category: "packs", progress: "Available",
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
    if ((url.startsWith("/api/bulk-trades?") || url === "/api/bulk-trades" || url === "/api/bulk-trades/demand") && hangInbox) return new Promise<Response>(() => {});
    if (url === "/api/bulk-trades/demand") return new Response(JSON.stringify({ demand: [], possible: [], accepted: [] }));
    if (url === "/api/bulk-trades?inbox=1") return new Response(JSON.stringify(inbox ?? { trades: [], owners: [] }));
    if (url === "/api/bulk-trades/bt_1" && init?.method === "PATCH") return new Response(JSON.stringify({ trade: { ...TRADE, ...JSON.parse(String(init.body)) } }));
    if (url === "/api/bulk-trades/bt_1") return new Response(JSON.stringify({ trade: TRADE, buyers: [], contacts: [], fields: [], files: [] }));
    return new Response("{}");
  });
}

describe("Trades Preview sheet", () => {
  beforeEach(() => { forgetShared(); window.localStorage.clear(); nativeReplace(NEXT_STATE, "", "/?path=%7Etrades-preview"); });
  afterEach(() => vi.unstubAllGlobals());

  it("shows one row per source record with its company, progress, latest development and next action, and no tabs", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    expect(await screen.findByRole("button", { name: /12 Ioniq packs/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /3 hybrid packs/ })).toBeInTheDocument();
    const trade = screen.getByRole("button", { name: /Synthetic eBS37/ }).closest("li")!;
    expect(within(trade).getByText("Available")).toBeInTheDocument();
    expect(within(trade).getByRole("button", { name: /Edit next action: Call the buyer/ })).toBeInTheDocument();
    expect(within(trade).getByText(/Alex/)).toBeInTheDocument();
    expect(screen.getByText("3 of 3 live")).toBeInTheDocument();
    for (const gone of ["Today", "Trades", "Demand", "Supply"]) expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
  });

  it("says plainly when a value is not recorded instead of guessing", async () => {
    vi.stubGlobal("fetch", mockApi({ sheet: [row({ company: null })] }));
    render(<TradesPreviewView />);
    const demand = (await screen.findByRole("button", { name: /12 Ioniq packs/ })).closest("li")!;
    // Company, latest development, value and fee are unrecorded: each shows a dash.
    expect(within(demand).getAllByText("—")).toHaveLength(4);
    expect(within(demand).getByRole("button", { name: "Add next action" })).toBeInTheDocument();
  });

  it("edits the next action in place for a listing and for a trade without opening the row", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/bulk-listings/d1/next" || url === "/api/bulk-trades/bt_1") return new Response(JSON.stringify({}));
      return mockApi()(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TradesPreviewView />);
    const demand = (await screen.findByRole("button", { name: /12 Ioniq packs/ })).closest("li")!;
    await userEvent.click(within(demand).getByRole("button", { name: "Add next action" }));
    await userEvent.type(screen.getByLabelText("Next action"), "Send price list{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-listings/d1/next", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ next_action: "Send price list", next_due: null }),
    })));
    expect(await within(demand).findByRole("button", { name: "Edit next action: Send price list" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("demand")).toBeNull();

    const trade = screen.getByRole("button", { name: /Synthetic eBS37/ }).closest("li")!;
    await userEvent.click(within(trade).getByRole("button", { name: /Edit next action: Call the buyer/ }));
    const input = screen.getByLabelText("Next action");
    await userEvent.clear(input);
    await userEvent.type(input, "Chase the bid{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-listings/bt_1/next", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ next_action: "Chase the bid", next_due: today }),
    })));
  });

  it("filters by search and starting point, and keeps the filters in the URL", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await screen.findByRole("button", { name: /12 Ioniq packs/ });
    await userEvent.click(screen.getByRole("button", { name: "Selling" }));
    expect(screen.queryByRole("button", { name: /12 Ioniq packs/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /3 hybrid packs/ })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("side")).toBe("seller");

    await userEvent.click(screen.getByRole("button", { name: "Selling" })); // pressing it again clears the filter
    expect(screen.getByText("3 of 3 live")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has("side")).toBe(false);
    expect(screen.queryByRole("button", { name: "All" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Both/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "nolden");
    expect(screen.getByText("1 of 3 live")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("q")).toBe("nolden");

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("3 of 3 live")).toBeInTheDocument();
    expect(window.location.search).toBe("?path=%7Etrades-preview");
  });

  it("opens a filtered view from a link, and an older tab=demand link as buyer-led", async () => {
    nativeReplace(NEXT_STATE, "", "/?path=%7Etrades-preview&progress=Offered");
    vi.stubGlobal("fetch", mockApi());
    const first = render(<TradesPreviewView />);
    expect(await screen.findByText("1 of 3 live")).toBeInTheDocument();
    expect(screen.getByLabelText("Progress")).toHaveValue("Offered");
    first.unmount();

    nativeReplace(NEXT_STATE, "", "/?path=%7Etrades-preview&tab=demand");
    render(<TradesPreviewView />);
    expect(await screen.findByText("1 of 3 live")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buying" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the spaces while a multiword search is typed", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await screen.findByRole("button", { name: /12 Ioniq packs/ });
    await userEvent.type(screen.getByRole("searchbox"), "Seller Ltd");
    expect(screen.getByRole("searchbox")).toHaveValue("Seller Ltd");
    expect(screen.getByText("2 of 3 live")).toBeInTheDocument();
  });

  it("an older tab=demand link keeps its filter through open and back, and Back refreshes the list", async () => {
    nativeReplace(NEXT_STATE, "", "/?path=%7Etrades-preview&tab=demand");
    const fetchMock = mockApi();
    vi.stubGlobal("fetch", fetchMock);
    render(<TradesPreviewView />);
    await userEvent.click(await screen.findByRole("button", { name: /12 Ioniq packs/ }));
    expect(new URLSearchParams(window.location.search).get("side")).toBe("buyer");
    const loads = () => fetchMock.mock.calls.filter(([url]) => url === "/api/bulk-trades/sheet").length;
    const before = loads();

    nativeReplace(NEXT_STATE, "", "/?path=%7Etrades-preview&side=buyer"); // browser Back, not the breadcrumb
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("button", { name: "Buying" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
  });

  it("opens a trade by link or by click, and Back returns to the same filtered sheet", async () => {
    nativeReplace(NEXT_STATE, "", "/?path=%7Etrades-preview&side=seller");
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await userEvent.click(await screen.findByRole("button", { name: /Synthetic eBS37/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Listing bt_1" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("listing")).toBe("bt_1");

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("2 of 3 live")).toBeInTheDocument();
    expect(window.location.search).toBe("?path=%7Etrades-preview&side=seller");
  });

  it("clicking a demand row opens that demand by id", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await userEvent.click(await screen.findByRole("button", { name: /12 Ioniq packs/ }));
    expect(new URLSearchParams(window.location.search).get("listing")).toBe("d1");
  });

  it("hands a clicked row to the workspace as its own tab and leaves the sheet where it is", async () => {
    const onOpenListing = vi.fn();
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView onOpenListing={onOpenListing} />);
    await userEvent.click(await screen.findByRole("button", { name: /12 Ioniq packs/ }));
    expect(onOpenListing).toHaveBeenCalledWith("d1", expect.stringContaining("Ioniq"));
    expect(new URLSearchParams(window.location.search).get("listing")).toBeNull();
    expect(screen.getByText(/\d of \d live/)).toBeInTheDocument();
  });

  it("in the workspace, brings the filters back when the sheet tab is shown again", async () => {
    window.sessionStorage.clear();
    nativeReplace(NEXT_STATE, "", "/?path=%7Etrades-preview&side=seller");
    vi.stubGlobal("fetch", mockApi());
    const first = render(<TradesPreviewView onOpenListing={vi.fn()} />);
    expect(await screen.findByText("2 of 3 live")).toBeInTheDocument();
    first.unmount();
    nativeReplace(NEXT_STATE, "", "/?path=%7Etrades-preview");
    render(<TradesPreviewView onOpenListing={vi.fn()} />);
    expect(await screen.findByText("2 of 3 live")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("side")).toBe("seller");
    window.sessionStorage.clear();
  });

  it("shows the rows while the inbox is still loading", async () => {
    vi.stubGlobal("fetch", mockApi({ hangInbox: true }));
    render(<TradesPreviewView />);
    expect(await screen.findByRole("button", { name: /12 Ioniq packs/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inbox ·/ })).toBeInTheDocument();
  });

  it("distinguishes loading, an empty sheet and a filter that matches nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const loading = render(<TradesPreviewView />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    loading.unmount();

    forgetShared();
    vi.stubGlobal("fetch", mockApi({ sheet: [] }));
    render(<TradesPreviewView />);
    expect(await screen.findByText("Nothing live right now.")).toBeInTheDocument();
  });

  it("shows the sheet's error and keeps the page usable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bulk-trades/sheet"
      ? new Response(JSON.stringify({ error: "Database unavailable" }), { status: 500 }) : new Response(JSON.stringify({ trades: [], owners: [] }))));
    render(<TradesPreviewView />);
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
    render(<TradesPreviewView />);
    expect(await screen.findByRole("img", { name: /Check failed/ })).toHaveAttribute("title", expect.stringContaining("boom"));
    await userEvent.click(screen.getByRole("button", { name: /Inbox · 1/ }));
    expect(screen.getByText("400 Leaf packs offered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create trade" })).toBeInTheDocument();
  });

  it("keeps accepted no-trade demand source-linked and shows conflict-checked undo", async () => {
    const proposal = { id: "accepted-demand", kind: "possible_demand", summary: "Synthetic accepted demand",
      source_url: "/?crm=inbox&view=whatsapp&thread=synthetic#message-synthetic", source_kind: "whatsapp" };
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
    render(<TradesPreviewView />);
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

  it.each(["listing", "trade", "demand", "supply"])("opens %s links in the same listing detail", async (param) => {
    nativeReplace(NEXT_STATE, "", `/?path=%7Etrades-preview&${param}=bt_1`);
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    expect(await screen.findByRole("heading", { name: "Listing bt_1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Related listing" }));
    expect(new URLSearchParams(window.location.search).get("listing")).toBe("s1");
  });

  it("the Add menu keeps demand creation but does not create separate trades", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menuitem", { name: "New trade" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add demand" })).toBeInTheDocument();
  });
});
