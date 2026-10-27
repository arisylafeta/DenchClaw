// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SupplyMatchesTab } from "./supply-matches-tab";
import { forgetShared } from "./trade-ui";

const row = { demandId: "btd_1", buyer: "ELG Battery", title: "100k cells", quantity: "100,000 cells", location: "PL", verdict: "check" as const,
  gap: "Quantity not stated", checks: [], marginPct: null, saved: null, userVerdict: null };

const noBuyers = { ranked: [], leads: [], supply: { chemistry: null, format: null, text: "", country: null } };
const buyer = (o: object) => ({ companyId: "c1", name: "Exigo", stage: "Bidding", tier: "A", basis: "stated", wants: "NMC cells", evidenceUrl: null, nextStep: null,
  lastTouch: "2026-10-08T09:00:00Z", fit: { matched: ["Chemistry NMC", "Format Cells"], gaps: [], score: 4 },
  contacts: [{ id: "p1", name: "Asha", email: "a@x.test", jobTitle: "Buyer", main: true, optedOut: false }], ...o });

describe("Matches tab on a supply listing", () => {
  beforeEach(() => forgetShared());
  afterEach(() => vi.unstubAllGlobals());

  it("lists the demand that fits with its deciding gap, and posts Shortlist and open", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (url.endsWith("/buyers")) return new Response(JSON.stringify(noBuyers), { status: 200 });
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
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/buyers") ? noBuyers : { matches: [], notAFit: 0, blocked: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<SupplyMatchesTab listingId="bts_1" active={false} onOpenListing={() => {}} />);
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<SupplyMatchesTab listingId="bts_1" active onOpenListing={() => {}} />);
    expect(await screen.findByText("No open demand fits this supply yet.")).toBeTruthy();
  });
});

describe("Buyers from the CRM (REB-564)", () => {
  beforeEach(() => forgetShared());
  afterEach(() => vi.unstubAllGlobals());

  it("shows ranked buyers, keeps researched leads in a closed accordion, and saves a candidate with the chosen contact", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (url.endsWith("/buyers")) return new Response(JSON.stringify({ ...noBuyers, ranked: [buyer({})], leads: [buyer({ companyId: "c2", name: "Lead Co", stage: "Identified", basis: "researched" })] }), { status: 200 });
      return new Response(JSON.stringify({ matches: [], notAFit: 0, blocked: null }), { status: 200 });
    }));
    render(<SupplyMatchesTab listingId="bts_1" active onOpenListing={() => {}} />);
    expect(await screen.findByText("Exigo")).toBeTruthy();
    expect(screen.getByText(/Matches: Chemistry NMC, Format Cells/)).toBeTruthy();
    expect(screen.getByText(/stated by the buyer/)).toBeTruthy();
    expect(screen.queryByText("Lead Co")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Researched leads \(1\)/ }));
    expect(await screen.findByText("Lead Co")).toBeTruthy();
    expect(screen.getByText(/researched, not yet contacted/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Save as candidate" })[0]);
    await waitFor(() => expect(calls.some((c) => c.startsWith("POST") && c.endsWith('{"companyId":"c1","personId":"p1"}'))).toBe(true));
  });
});
