// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DemandMatchesTab } from "./demand-matches-tab";
import { SupplyMatchesTab } from "./supply-matches-tab";
import { forgetShared } from "./trade-ui";
import type { MatchesResult } from "@/lib/matches-types";

const row = (o: Partial<MatchesResult["rows"][number]> = {}) => ({
  key: "company:c1", rank: 1, name: "Exigo", detail: "Last contact 2026-10-08",
  tags: [] as MatchesResult["rows"][number]["tags"], reason: "Same part number: 50 kWh Packs NMC",
  checks: ["No firm seller price"], price: "40/kWh against their 60/kWh (+50%)",
  offer: null, companyId: "c1", personId: "p1", contact: "buyer@exigo.test", stockId: null, ...o,
});

const result = (rows: MatchesResult["rows"], o: Partial<MatchesResult> = {}): MatchesResult => ({
  id: "bts_1", kind: "supply",
  lotKey: { line: "40 units · Toyota Proace · 50 kWh · Packs · NMC", full: ["40 units · Toyota Proace · 50 kWh · Packs · NMC", "Seller price EUR 40 per kWh"], open: false },
  rows, considered: 34, blocked: null, errors: [], ...o,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Matches tab", () => {
  beforeEach(() => forgetShared());
  afterEach(() => vi.unstubAllGlobals());

  it("leads with the key, one ranked list, the reason, the check and the firm price", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([
      row({ key: "demand:btd_1", name: "ELG Battery", tags: ["live ask"], reason: "Wants 100k cells", checks: [], price: "EUR 20/kWh" }),
      row({ tags: ["lead"], personId: "p1" }),
    ]))));
    render(<SupplyMatchesTab listingId="bts_1" active />);
    expect(await screen.findByText("Matched on")).toBeTruthy();
    expect(screen.getByText(/40 units · Toyota Proace/)).toBeTruthy();
    expect(screen.getByText("live ask")).toBeTruthy();
    expect(screen.getByText("lead")).toBeTruthy();
    expect(screen.getByText("Same part number: 50 kWh Packs NMC")).toBeTruthy();
    expect(screen.getByText(/Check: No firm seller price/)).toBeTruthy();
    expect(screen.getByText("40/kWh against their 60/kWh (+50%)")).toBeTruthy();
    expect(screen.getByText(/2 matches · 34 checked/)).toBeTruthy();
    // One primary action per row, and the quiet Not a fit beside it.
    expect(screen.getAllByRole("button", { name: "Add to offers" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Not a fit" })).toHaveLength(2);
  });

  it("expands the full key only when asked, or by itself for a disputed or mixed lot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([row()]))));
    const { unmount } = render(<SupplyMatchesTab listingId="bts_1" active />);
    expect(await screen.findByText("Matched on")).toBeTruthy();
    expect(screen.queryByText("Seller price EUR 40 per kWh")).toBeNull();
    fireEvent.click(screen.getByText("Matched on"));
    expect(screen.getByText("Seller price EUR 40 per kWh")).toBeTruthy();
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => json(result([row()], {
      lotKey: { line: "2 products", full: ["Product 1", "Product 2"], open: true },
    }))));
    render(<SupplyMatchesTab listingId="bts_2" active />);
    expect(await screen.findByText("Product 1")).toBeTruthy();
  });

  it("adds the offer with the match in data and shows the stage and date it became", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (url.endsWith("/offers")) {
        return json({ offer: { id: "bof_1", stage: "candidate", updated_at: "2026-11-08T09:00:00.000Z" } }, 201);
      }
      return json(result([row()]));
    }));
    render(<SupplyMatchesTab listingId="bts_1" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to offers" }));
    await waitFor(() => expect(calls.some((call) => call.startsWith("POST /api/bulk-listings/bts_1/offers"))).toBe(true));
    const body = JSON.parse(calls.find((call) => call.startsWith("POST"))!.split(" ").slice(2).join(" "));
    expect(body).toMatchObject({
      name: "Exigo", companyId: "c1", personId: "p1", contact: "buyer@exigo.test", stage: "candidate",
      data: { match: { reason: "Same part number: 50 kWh Packs NMC", rank: 1 } },
    });
    expect(typeof body.data.match.at).toBe("string");
    expect(body.data.stock_opportunity_id).toBeUndefined();
    expect(await screen.findByText(/In offers · Candidate 8 Nov/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to offers" })).toBeNull();
  });

  it("links an existing offer to the Offers tab instead of offering again", async () => {
    const open = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => json(result([
      row({ offer: { id: "bof_2", stage: "offered", date: "2026-11-05" } }),
    ]))));
    render(<SupplyMatchesTab listingId="bts_1" active onOpenOffers={open} />);
    fireEvent.click(await screen.findByText(/In offers · Offered 5 Nov/));
    expect(open).toHaveBeenCalled();
  });

  it("asks for a quick reason before Not a fit and hides the row once saved", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (init?.method === "POST") return json({ activity: { id: "a1" } }, 201);
      return json(result([row()]));
    }));
    render(<SupplyMatchesTab listingId="bts_1" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Not a fit" }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Wrong chemistry" }));
    fireEvent.change(screen.getByLabelText("Anything else"), { target: { value: "NMC only" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((call) => call.startsWith("POST /api/bulk-listings/bts_1/matches/v2")
      && call.includes('"reason":"Wrong chemistry — NMC only"'))).toBe(true));
    await waitFor(() => expect(screen.queryByText("Exigo")).toBeNull());
  });

  it("shows ten rows and then the rest", async () => {
    const many = Array.from({ length: 14 }, (_, i) => row({ key: `company:c${i}`, name: `Buyer ${i}`, rank: i + 1 }));
    vi.stubGlobal("fetch", vi.fn(async () => json(result(many))));
    render(<SupplyMatchesTab listingId="bts_1" active />);
    expect(await screen.findByText("Buyer 9")).toBeTruthy();
    expect(screen.queryByText("Buyer 10")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show 4 more of 4/ }));
    expect(await screen.findByText("Buyer 13")).toBeTruthy();
  });

  it("shows the empty state, and an error with a retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([], { blocked: "Nothing fits yet. Add a dossier or a listing field to widen the match." }))));
    const { unmount } = render(<SupplyMatchesTab listingId="bts_1" active />);
    expect(await screen.findByText(/Nothing fits yet/)).toBeTruthy();
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Could not load matches." }, 500)));
    render(<SupplyMatchesTab listingId="bts_2" active />);
    expect(await screen.findByText("Could not load matches.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("does not fetch while the tab is hidden", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SupplyMatchesTab listingId="bts_1" active={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers an unlisted stock row on the request side and records the stock line on the offer", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (url.includes("/offers")) return json({ offer: { id: "bof_9", stage: "candidate", updated_at: "2026-11-08T09:00:00.000Z" } }, 201);
      return json(result([row({ key: "stock:sto_1", name: "Synthetic Supplier", tags: ["unlisted stock"], companyId: "c9", personId: "p9", stockId: "sto_1", price: null })], { id: "btd_1", kind: "demand" }));
    }));
    render(<DemandMatchesTab demandId="btd_1" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to offers" }));
    await waitFor(() => expect(calls.some((call) => call.startsWith("POST /api/bulk-trades/demand/btd_1/offers"))).toBe(true));
    const body = JSON.parse(calls.find((call) => call.startsWith("POST"))!.split(" ").slice(2).join(" "));
    expect(body.data.stock_opportunity_id).toBe("sto_1");
  });
});
