// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", async () => {
  const react = await import("react");
  return {
    useSearchParams: () => {
      const [, rerender] = react.useReducer((n: number) => n + 1, 0);
      react.useEffect(() => { const h = () => rerender(); window.addEventListener("bt-url", h); return () => window.removeEventListener("bt-url", h); }, []);
      return new URLSearchParams(window.location.search);
    },
  };
});
const push = window.history.pushState.bind(window.history);
window.history.pushState = (...args) => { push(...args); window.dispatchEvent(new Event("bt-url")); };

const demandRow = {
  priority: false, missing: [], context_notes: [], inventory_matches: [], id: "d1", kind: "standing", basis: "stated", buyer: "Green Voltage",
  company_id: null, person_id: null, contact: null, email: null, wants: "12 Ioniq packs", quantity: null, location: null, note: null,
  needed_by: null, volume: null, volume_unit: null, max_price: null, price_currency: null, price_unit: null, spec: {}, context: {},
  status: "open", activity_count: 0, last_activity_at: null, fits: [], trades: [], waiting: null, tier: null, score: null,
};
const sheetRow = {
  key: "demand:d1", kind: "demand", id: "d1", side: "buyer", title: "12 Ioniq packs", company: "Green Voltage", company_id: null, category: null,
  progress: "New", tone: "new", latest: null, next_action: null, next_due: null, owner: null, touched: "2026-10-01",
};

function stubApi(calls: string[], hold: string[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (hold.includes(url)) return new Promise<Response>(() => {});
    const body = url === "/api/bulk-trades/sheet" ? { rows: [sheetRow] }
      : url === "/api/bulk-trades/demand" ? { demand: [demandRow], possible: [], accepted: [] }
        : url.startsWith("/api/bulk-trades?") ? { owners: [] }
          : url.endsWith("/activity") ? { activity: [] }
            : {};
    return new Response(JSON.stringify(body));
  }));
}

async function freshView() {
  vi.resetModules();
  const { BulkTradesView } = await import("./bulk-trades-view");
  return BulkTradesView;
}

describe("Bulk Trades loading", () => {
  afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

  it("opening the sheet loads each list once, and the rows do not wait for the inbox", async () => {
    const calls: string[] = [];
    stubApi(calls, ["/api/bulk-trades?inbox=1", "/api/bulk-trades/demand"]);
    window.history.replaceState(null, "", "/?path=bulk_trade");
    const BulkTradesView = await freshView();
    render(<BulkTradesView />);
    await screen.findByRole("button", { name: /12 Ioniq packs/ });
    expect(calls.filter((url) => url === "/api/bulk-trades/sheet")).toHaveLength(1);
    expect(calls.filter((url) => url === "/api/bulk-trades/demand")).toHaveLength(1);
  });

  it("a demand opened by link shows its requirement and story without waiting for match calculations", async () => {
    const calls: string[] = [];
    stubApi(calls, ["/api/bulk-trades/demand/d1/supply", "/api/bulk-trades/demand/d1/context"]);
    window.history.replaceState(null, "", "/?path=bulk_trade&demand=d1");
    const BulkTradesView = await freshView();
    render(<BulkTradesView />);
    expect(await screen.findByRole("heading", { name: "Green Voltage" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Story" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("region", { name: "Story" })).toBeInTheDocument();
    expect(calls.filter((url) => url === "/api/bulk-trades/demand")).toHaveLength(1);
  });

  it("a read that started before a save never delivers its older copy", async () => {
    let status = "old";
    const releases: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") { status = "saved"; return Promise.resolve(new Response("{}")); }
      const snapshot = status; // what the server holds when this read is served
      return new Promise<Response>((resolve) => releases.push(() => resolve(new Response(JSON.stringify({ status: snapshot })))));
    }));
    vi.resetModules();
    const { sharedGet, request } = await import("./trade-ui");
    const early = sharedGet<{ status: string }>("/api/x"); // read begins, still waiting on the server
    await request("/api/x/1", { method: "PATCH", body: "{}" });
    releases[0](); // the pre-save read now answers with the old snapshot
    await vi.waitFor(() => expect(releases).toHaveLength(2)); // it re-reads instead of delivering it
    releases[1]();
    expect(await early).toEqual({ status: "saved" });
  });
});
