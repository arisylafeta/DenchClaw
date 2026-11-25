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
  row({ key: "bt_1", kind: "supply", id: "bt_1", side: "seller", title: "Synthetic eBS37", company: "Lot Seller", category: "packs", progress: "Available",
    tone: "active", next_action: "Call the buyer", owner: "Alex", next_due: today }),
];

const TRADE = {
  origin: "supply", seller_ref: null, seller_name: null, has_seller: false, has_buyer: false, id: "bt_1", title: "Synthetic eBS37",
  trade_stage: "With buyers", trade_kind: null, fact_line: "161 packs", next_step: "Follow up", next_step_due: today, waiting_on: "us",
  waiting_since: null, next_step_contact_id: null, next_step_buyer_id: null, owner_user_id: null, owner_name: null, value: null,
  last_touched: null, clear_by: null, ship_by: null, transport_class: null, tfs_needed: "unknown", listing_id: null, auction_slug: null,
  auction_status: null, auction_closes_at: null, hold_until: null, hold_reason: null, hold_from_stage: null, updated_at: "2026-09-28T09:00:00Z",
};

type Api = { inbox?: unknown; sheet?: SheetRow[]; abandoned?: SheetRow[]; hangInbox?: boolean };
function mockApi({ inbox, sheet = ROWS, abandoned = [], hangInbox }: Api = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/bulk-trades/sheet") return new Response(JSON.stringify({ rows: sheet, abandoned }));
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
  const go = (search: string) => nativeReplace(NEXT_STATE, "", `/?path=%7Etrades-preview${search}`);
  const params = () => new URLSearchParams(window.location.search);
  const rowOf = (name: RegExp) => screen.getByRole("button", { name }).closest("li")!;
  /** The strip's "all" count: every row the list holds after search and filters. */
  const allCount = () => document.querySelector("[data-strip=all] b")?.textContent;
  const listRow = (company: string) => screen.getByRole("button", { name: `Open ${company}` }).closest("li")!;
  const openFilters = () => userEvent.click(screen.getByRole("button", { name: /^Filters/ }));

  it("opens on Today: four tabs, the driver filter, the quarter target and next actions by due date", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    const today = await screen.findByRole("region", { name: "Today" });
    expect(screen.getAllByRole("tab").map((tab) => tab.firstChild?.textContent)).toEqual(["Today", "Requests", "Supply", "Deals"]);
    // Each list tab shows how many it holds for the chosen driver; Today has no count.
    expect(screen.getAllByRole("tab").map((tab) => tab.querySelector("[data-tab-count]")?.textContent ?? null)).toEqual([null, "1", "2", "1"]);
    expect(screen.getByRole("tab", { name: "Today" })).toHaveAttribute("aria-selected", "true");
    const ownerPicker = screen.getByLabelText("Owner") as HTMLSelectElement;
    expect(Array.from(ownerPicker.options).map((o) => o.textContent)).toEqual(["All owners", "Alex", "Sean", "Ari"]);
    // Today keeps its own page: no search or Filters there, and no grey segmented toggles anywhere.
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Filters/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Driver" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pipeline against quarter target" })).toHaveTextContent("£54k (≈ €62k)");
    expect(within(today).getByRole("button", { name: "Call the buyer" })).toBeInTheDocument();
    expect(within(today).getAllByRole("button", { name: "Mark done" })).toHaveLength(1);
    const none = screen.getByRole("region", { name: "Needs a next action" });
    expect(within(none).getByRole("button", { name: /12 Ioniq packs/ })).toBeInTheDocument();
    expect(within(none).getByRole("button", { name: /3 hybrid packs/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Selling" })).not.toBeInTheDocument();
    expect(window.location.search).toBe("?path=%7Etrades-preview");
  });

  it("keeps Today at the far left with its To review group, and the To review chip on the Requests row", async () => {
    vi.stubGlobal("fetch", mockApi({ sheet: [row({ review: true, next_action: "Check the import", next_due: today }), ...ROWS.slice(1)] }));
    const first = render(<TradesPreviewView />);
    const review = await screen.findByRole("region", { name: "To review" });
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent("Today");
    expect(within(review).getByRole("button", { name: "Check the import" })).toBeInTheDocument();
    first.unmount();
    go("&tab=demand");
    render(<TradesPreviewView />);
    expect(within(await screen.findByRole("button", { name: "Open H. Nolden" }).then((b) => b.closest("li")!)).getByText("To review")).toBeInTheDocument();
  });

  it("Requests lists demand only, without the side toggle, and offers only demand stages", async () => {
    go("&tab=demand");
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    expect(await screen.findByRole("button", { name: "Open H. Nolden" })).toBeInTheDocument();
    expect(screen.getByText("12 Ioniq packs")).toBeInTheDocument();
    expect(screen.queryByText("3 hybrid packs")).not.toBeInTheDocument();
    expect(allCount()).toBe("1");
    // The stage chips, Company, Category, Waiting on and Sort live in the Filters popover.
    expect(screen.queryByRole("group", { name: "Stage" })).not.toBeInTheDocument();
    await openFilters();
    const filters = screen.getByRole("dialog", { name: "Filters" });
    for (const label of ["Company", "Category", "Waiting on", "Sort by"]) expect(within(filters).getByLabelText(label)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buying" })).not.toBeInTheDocument();
    const stages = () => within(screen.getByRole("group", { name: "Stage" })).getAllByRole("button");
    const progress = stages().map((b) => b.firstChild?.textContent);
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
    expect(progress).toEqual(["All", "New", "Qualified", "Sourcing", "Offered"]);
    const more = Array.from((screen.getByLabelText("More stages") as HTMLSelectElement).options).map((o) => o.value);
    expect(more).toEqual(["", "Can't source", "Negotiating", "Agreed", "Paid", "Delivered"]);
  });

  it("Supply lists supply with its stage, chance, owner and next action", async () => {
    go("&tab=supply");
    vi.stubGlobal("fetch", mockApi({ sheet: [...ROWS.slice(0, 2), { ...ROWS[2], likelihood: 60 }] }));
    render(<TradesPreviewView />);
    const trade = (await screen.findByRole("button", { name: "Open Lot Seller" })).closest("li")!;
    expect(allCount()).toBe("2");
    expect(within(trade).getByRole("img", { name: "Stage: Available, step 3 of 6" })).toBeInTheDocument();
    expect(within(trade).getByText("Call the buyer")).toBeInTheDocument();
    expect(trade.querySelector("[data-due]")).toHaveTextContent("Due today");
    // All owners: the driver shows as a small initial in the row.
    expect(within(trade).getByRole("img", { name: "Driver Alex" })).toBeInTheDocument();
    expect(trade.querySelector("[data-chance]")).toHaveTextContent("60% chance");
    await openFilters();
    const stages = () => within(screen.getByRole("group", { name: "Stage" })).getAllByRole("button");
    const progress = stages().map((b) => b.firstChild?.textContent);
    expect(progress).toEqual(["All", "New", "Available", "Offered"]);
    expect(Array.from((screen.getByLabelText("More stages") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "Negotiating", "Agreed", "Paid", "Delivered"]);
  });

  it("says plainly when a value is not recorded instead of guessing", async () => {
    go("&tab=demand");
    vi.stubGlobal("fetch", mockApi({ sheet: [row({ company: null })] }));
    render(<TradesPreviewView />);
    const demand = (await screen.findByRole("button", { name: "Open 12 Ioniq packs" })).closest("li")!;
    // Fee, ticket and chance are never guessed; the chance is a quiet prompt, and the driver says it is missing.
    expect(demand.querySelector("[data-money]")).toHaveTextContent("—no fee yetSet chance");
    expect(within(demand).getByRole("button", { name: "Set chance" })).toBeInTheDocument();
    expect(within(demand).getByRole("img", { name: "No driver" })).toBeInTheDocument();
    expect(within(demand).getByText("No next action yet.")).toBeInTheDocument();
    expect(demand.querySelector("[data-move-label]")).toHaveTextContent("Your move");
  });

  it("adds a next action and ticks one done on Today without opening the row", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (/^\/api\/bulk-listings\/(d1|bt_1)\/(next|owner)$/.test(url)) return new Response(JSON.stringify({}));
      return mockApi()(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TradesPreviewView />);
    await screen.findByRole("region", { name: "Needs a next action" });
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

    // A listing with no driver needs one before the action can be added.
    const ioniq = rowOf(/^Open .*12 Ioniq packs/);
    await userEvent.click(within(ioniq).getByRole("button", { name: "Add next action" }));
    await userEvent.type(within(ioniq).getByLabelText("Next action"), "Send price list");
    const add = within(ioniq).getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    await userEvent.selectOptions(within(ioniq).getByLabelText("Driver"), "Sean");
    await userEvent.click(add);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-listings/d1/next", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ next_action: "Send price list", next_due: tomorrow, owner: "Sean" }),
    })));
    expect(await screen.findByRole("button", { name: "Send price list" })).toBeInTheDocument();
    expect(params().get("listing")).toBeNull();

    // Ticking asks what is next and saves both in one step.
    await userEvent.click(within(rowOf(/^Call the buyer$/)).getByRole("button", { name: "Mark done" }));
    await userEvent.type(screen.getByLabelText("Next action"), "Chase the bid{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-listings/bt_1/next", expect.objectContaining({
      method: "POST", body: JSON.stringify({ done: "Call the buyer", next_action: "Chase the bid", next_due: tomorrow }),
    })));
    expect(await screen.findByRole("button", { name: "Chase the bid" })).toBeInTheDocument();
    expect(params().get("listing")).toBeNull();
  });

  it("filters Supply by search, keeps it in the URL, and clears back to the tab", async () => {
    go("&tab=supply");
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await screen.findByRole("button", { name: "Open Seller Ltd" });
    await userEvent.type(screen.getByRole("searchbox"), "hybrid");
    expect(allCount()).toBe("1");
    expect(params().get("q")).toBe("hybrid");
    await userEvent.clear(screen.getByRole("searchbox"));
    expect(allCount()).toBe("2");
    expect(window.location.search).toBe("?path=%7Etrades-preview&tab=supply");
  });

  it("keeps the spaces while a multiword search is typed", async () => {
    go("&tab=supply");
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await screen.findByRole("button", { name: "Open Seller Ltd" });
    await userEvent.type(screen.getByRole("searchbox"), "Seller Ltd");
    expect(screen.getByRole("searchbox")).toHaveValue("Seller Ltd");
    expect(allCount()).toBe("1");
  });

  it("filters every tab by driver, keeps it in the URL and across tabs, and resets the other filters on a tab change", async () => {
    go("&tab=supply&q=packs");
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await screen.findByRole("button", { name: "Open Seller Ltd" });
    await userEvent.selectOptions(screen.getByLabelText("Owner"), "Alex");
    expect(params().get("owner")).toBe("Alex");
    expect(allCount()).toBe("1");
    expect(screen.queryByRole("button", { name: "Open Seller Ltd" })).not.toBeInTheDocument();
    // One owner: no driver initials in the rows.
    expect(within(listRow("Lot Seller")).queryByRole("img", { name: /Driver/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Today" }));
    expect(window.location.search).toBe("?path=%7Etrades-preview&owner=Alex");
    const target = screen.getByRole("region", { name: "Pipeline against quarter target" });
    expect(target).toHaveTextContent("£27k (≈ €31k)");
    expect(target).toHaveTextContent("not fees banked this quarter");
    expect(target).not.toHaveTextContent("Includes deals with no owner");
    expect(screen.getByRole("button", { name: /Synthetic eBS37/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /12 Ioniq packs/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Owner"), "Ari");
    expect(screen.queryByRole("region", { name: "Pipeline against quarter target" })).not.toBeInTheDocument();
    expect(screen.getByText("Targets are set for Alex and Sean.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Owner"), "All owners");
    expect(params().has("owner")).toBe(false);
    expect(screen.getByRole("region", { name: "Pipeline against quarter target" })).toHaveTextContent("Includes deals with no owner.");
    expect(screen.getByRole("button", { name: /12 Ioniq packs/ })).toBeInTheDocument();
  });

  it("opens filtered views from links, and older links on the right tab", async () => {
    go("&tab=supply&progress=Offered");
    vi.stubGlobal("fetch", mockApi());
    const first = render(<TradesPreviewView />);
    await screen.findByRole("button", { name: "Open Seller Ltd" });
    expect(allCount()).toBe("1");
    expect(screen.getByRole("button", { name: "Filters, 1 on" })).toHaveTextContent("Filters1");
    await openFilters();
    expect(within(screen.getByRole("group", { name: "Stage" })).getByRole("button", { name: /^Offered/ })).toHaveAttribute("aria-pressed", "true");
    first.unmount();

    for (const [search, tab] of [["&q=ioniq", "Requests"], ["&progress=New", "Requests"], ["&side=buyer", "Requests"], ["&side=seller", "Supply"], ["&tab=board", "Deals"], ["&tab=trades", "Deals"], ["&owner=Sean", "Today"]] as const) {
      go(search);
      const view = render(<TradesPreviewView />);
      expect(await screen.findByRole("tab", { name: new RegExp(`^${tab}(,|$)`) })).toHaveAttribute("aria-selected", "true");
      view.unmount();
    }
  });

  it("maps an older Progress value to the tab's stage, and drops one the tab does not have", async () => {
    go("&tab=supply&progress=Matched");
    vi.stubGlobal("fetch", mockApi());
    const first = render(<TradesPreviewView />);
    await screen.findByRole("button", { name: "Open Lot Seller" });
    expect(allCount()).toBe("1");
    await openFilters();
    expect(within(screen.getByRole("group", { name: "Stage" })).getByRole("button", { name: /^Available/ })).toHaveAttribute("aria-pressed", "true");
    first.unmount();

    go("&tab=supply&progress=Sourcing");
    render(<TradesPreviewView />);
    await screen.findByRole("button", { name: "Open Lot Seller" });
    expect(allCount()).toBe("2");
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    await openFilters();
    expect(within(screen.getByRole("group", { name: "Stage" })).getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("an older side=buyer link opens Requests, keeps it through open and back, and Back refreshes the list", async () => {
    go("&side=buyer");
    const fetchMock = mockApi();
    vi.stubGlobal("fetch", fetchMock);
    render(<TradesPreviewView />);
    await userEvent.click(await screen.findByRole("button", { name: "Open H. Nolden" }));
    expect(params().get("listing")).toBe("d1");
    expect(params().get("tab")).toBe("demand");
    const loads = () => fetchMock.mock.calls.filter(([url]) => url === "/api/bulk-trades/sheet").length;
    const before = loads();

    go("&tab=demand"); // browser Back, not the breadcrumb
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("tab", { name: /^Requests(,|$)/ })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
  });

  it("opens a trade by click, and Back returns to the same tab", async () => {
    go("&tab=supply&owner=Alex");
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await userEvent.click(await screen.findByRole("button", { name: "Lot Seller" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Listing bt_1" })).toBeInTheDocument();
    expect(params().get("listing")).toBe("bt_1");

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: "Open Lot Seller" });
    expect(allCount()).toBe("1");
    expect(window.location.search).toBe("?path=%7Etrades-preview&tab=supply&owner=Alex");
  });

  it("clicking a row on Today opens that listing by id", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await userEvent.click(await screen.findByRole("button", { name: /12 Ioniq packs/ }));
    expect(params().get("listing")).toBe("d1");
  });

  it("puts open requests and deals on the Board, and the Today nudge for unsized deals opens it", async () => {
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView />);
    await userEvent.click(await screen.findByRole("button", { name: "1 deal needs a fee or chance" }));
    expect(params().get("tab")).toBe("board");
    const offered = await screen.findByRole("region", { name: "Offered" });
    expect(within(offered).getByText("3 hybrid packs")).toBeInTheDocument();
    expect(within(offered).getByText("1 unsized")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Requests" })).getByText(/12 Ioniq packs/)).toBeInTheDocument();
    expect(screen.queryByText("Synthetic eBS37")).not.toBeInTheDocument();
  });

  it("drags a deal to Abandoned with a reason, and back out to reopen it", async () => {
    go("&tab=board");
    const lost = { ...ROWS.find((row) => row.progress === "Offered")!, key: "gone1", id: "gone1", title: "Old lost lot", abandoned: { reason: "gone", at: "2026-11-01 09:00:00+00" } };
    const fetch = mockApi({ abandoned: [lost] });
    vi.stubGlobal("fetch", fetch);
    render(<TradesPreviewView />);
    const offered = await screen.findByRole("region", { name: "Offered" });
    const abandonedColumn = screen.getByRole("region", { name: "Abandoned" });
    expect(within(abandonedColumn).getByText("Old lost lot")).toBeInTheDocument();
    const card = within(offered).getByText("3 hybrid packs").closest("li")!;
    fireEvent.dragStart(card);
    fireEvent.drop(abandonedColumn);
    await userEvent.click(screen.getByRole("radio", { name: "Not a fit" }));
    await userEvent.click(screen.getByRole("button", { name: "Abandon" }));
    const id = ROWS.find((row) => row.key === card.getAttribute("data-card"))!.id;
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/bulk-listings/${id}/abandon`, expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "not_a_fit", note: null }) })));
    fireEvent.dragStart(within(abandonedColumn).getByText("Old lost lot").closest("li")!);
    fireEvent.drop(screen.getByRole("region", { name: "Offered" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/bulk-listings/gone1/abandon", expect.objectContaining({ method: "DELETE" })));
  });

  it("hands a clicked row to the workspace as its own tab and leaves the sheet where it is", async () => {
    const onOpenListing = vi.fn();
    go("&tab=demand");
    vi.stubGlobal("fetch", mockApi());
    render(<TradesPreviewView onOpenListing={onOpenListing} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open H. Nolden" }));
    expect(onOpenListing).toHaveBeenCalledWith("d1", expect.stringContaining("Ioniq"));
    expect(params().get("listing")).toBeNull();
    expect(allCount()).toBe("1");
  });

  it("in the workspace, brings the tab and filters back when the sheet tab is shown again", async () => {
    window.sessionStorage.clear();
    go("&tab=supply&owner=Alex");
    vi.stubGlobal("fetch", mockApi());
    const first = render(<TradesPreviewView onOpenListing={vi.fn()} />);
    await screen.findByRole("button", { name: "Open Lot Seller" });
    expect(allCount()).toBe("1");
    first.unmount();
    go("");
    render(<TradesPreviewView onOpenListing={vi.fn()} />);
    await screen.findByRole("button", { name: "Open Lot Seller" });
    expect(allCount()).toBe("1");
    expect(params().get("tab")).toBe("supply");
    expect(params().get("owner")).toBe("Alex");
    window.sessionStorage.clear();
  });

  it("shows the rows while the inbox is still loading", async () => {
    vi.stubGlobal("fetch", mockApi({ hangInbox: true }));
    render(<TradesPreviewView />);
    expect(await screen.findByRole("button", { name: /12 Ioniq packs/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inbox" })).toBeInTheDocument();
  });

  it("distinguishes loading and an empty sheet on Today and on a list", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const loading = render(<TradesPreviewView />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    loading.unmount();

    forgetShared();
    vi.stubGlobal("fetch", mockApi({ sheet: [] }));
    const empty = render(<TradesPreviewView />);
    expect(await screen.findByText("Nothing open right now.")).toBeInTheDocument();
    empty.unmount();

    go("&tab=demand");
    render(<TradesPreviewView />);
    expect(await screen.findByText("Nothing live right now.")).toBeInTheDocument();
  });

  it("shows the sheet's error and keeps the page usable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bulk-trades/sheet"
      ? new Response(JSON.stringify({ error: "Database unavailable" }), { status: 500 }) : new Response(JSON.stringify({ trades: [], owners: [] }))));
    const first = render(<TradesPreviewView />);
    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    expect(screen.getByText("The list could not load.")).toBeInTheDocument();
    first.unmount();
    nativeReplace(NEXT_STATE, "", "/?path=%7Etrades-preview&tab=supply");
    render(<TradesPreviewView />);
    expect(await screen.findByText("The sheet could not load.")).toBeInTheDocument();
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
