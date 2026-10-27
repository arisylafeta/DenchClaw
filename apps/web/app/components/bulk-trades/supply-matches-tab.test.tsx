// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SupplyMatchesTab } from "./supply-matches-tab";
import { forgetShared } from "./trade-ui";

const row = { demandId: "btd_1", buyer: "ELG Battery", title: "100k cells", quantity: "100,000 cells", location: "PL", verdict: "check" as const,
  gap: "Quantity not stated", checks: [], marginPct: null, saved: null, userVerdict: null };

describe("Matches tab on a supply listing", () => {
  beforeEach(() => forgetShared());
  afterEach(() => vi.unstubAllGlobals());

  it("lists the demand that fits with its deciding gap, and posts Shortlist and open", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      return new Response(JSON.stringify({ matches: [row], notAFit: 2, blocked: null }), { status: 200 });
    }));
    const open = vi.fn();
    render(<SupplyMatchesTab listingId="bts_1" active onOpenListing={open} />);
    expect(await screen.findByText("ELG Battery")).toBeTruthy();
    expect(screen.getByText(/1 open demand fits this supply/)).toBeTruthy();
    expect(screen.getByText(/2 marked not a fit/)).toBeTruthy();
    expect(screen.getByText(/Check: Quantity not stated/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Shortlist"));
    await waitFor(() => expect(calls.some((c) => c.startsWith("POST") && c.includes('"verdict":"shortlist"') && c.includes("btd_1"))).toBe(true));
    fireEvent.click(screen.getByLabelText("Open demand"));
    expect(open).toHaveBeenCalledWith("btd_1");
  });

  it("shows an empty state, and does not fetch while the tab is hidden", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ matches: [], notAFit: 0, blocked: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<SupplyMatchesTab listingId="bts_1" active={false} onOpenListing={() => {}} />);
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<SupplyMatchesTab listingId="bts_1" active onOpenListing={() => {}} />);
    expect(await screen.findByText("No open demand fits this supply yet.")).toBeTruthy();
  });
});
