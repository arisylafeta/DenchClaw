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

const row = (overrides: Record<string, unknown>) => ({
  priority: false, missing: [], context_notes: [], inventory_matches: [], id: "d1", kind: "standing", basis: "stated",
  buyer: "Green Voltage", company_id: null, status: "open", wants: "12 packs", closed_reason: null, source_kind: "manual", ...overrides,
});

function stubApi(calls: string[], hold: { demand: boolean }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (hold.demand && url === "/api/bulk-trades/demand") await new Promise(() => {});
    const body = url === "/api/bulk-trades/demand" ? { demand: [row({})], possible: [], accepted: [] }
      : url === "/api/bulk-trades/supply" ? { supply: [], feed: [], matched: null }
        : url === "/api/bulk-trades/demand/matches" ? { matches: {} }
          : { trades: [], owners: [] };
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

  it("opening Demand loads the demand list once, not once per component", async () => {
    const calls: string[] = [];
    stubApi(calls, { demand: false });
    window.history.replaceState(null, "", "/?path=bulk_trade&tab=demand");
    const BulkTradesView = await freshView();
    render(<BulkTradesView />);
    await screen.findByRole("button", { name: /Green Voltage/ });
    // eslint-disable-next-line no-console
    console.log("COLD_OPEN_DEMAND_REQUESTS", calls.filter((url) => url === "/api/bulk-trades/demand").length);
    expect(calls.filter((url) => url === "/api/bulk-trades/demand")).toHaveLength(1);
  });

  it("a revisited tab keeps showing its rows while the refresh is still pending", async () => {
    const calls: string[] = [];
    const hold = { demand: false };
    stubApi(calls, hold);
    window.history.replaceState(null, "", "/?path=bulk_trade&tab=demand");
    const BulkTradesView = await freshView();
    render(<BulkTradesView />);
    await screen.findByRole("button", { name: /Green Voltage/ });
    await userEvent.click(screen.getByRole("button", { name: "Supply" }));
    hold.demand = true;
    await userEvent.click(screen.getByRole("button", { name: "Demand" }));
    expect(screen.getByRole("button", { name: /Green Voltage/ })).toBeInTheDocument();
  });

  it("a read that started before a save never delivers its older copy", async () => {
    let status = "old";
    const releases: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
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
