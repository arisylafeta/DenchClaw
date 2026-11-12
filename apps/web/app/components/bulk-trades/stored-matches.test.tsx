// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StoredMatchesView } from "./stored-matches";
import { forgetShared } from "./trade-ui";
import type { StoredMatches, StoredMatchView } from "@/lib/crm-postgres/bulk-matches";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const match = (o: Partial<StoredMatchView> = {}): StoredMatchView => ({
  id: "bmt_1", candidate_kind: "stock", candidate_id: "sto_1", candidate_key: "stock:sto_1", name: "Supplier one",
  company_id: "co_1", person_id: "pe_1", contact: null, stock_kind: "stock", stock_id: "sto_1", candidate_qty: 30,
  rank: 1, scorer_rank: 2, checks: { reason: "Model matches: Kona", checks: ["Ask for SoH"] }, reason: "Exact model, 30 packs stated.",
  scored_by: { model: "hermes-agent" }, state: "proposed", note: null, asked_at: null, chases: 0, verdict: null, verdict_reason: null,
  verdict_at: null, verdict_by: null, confirmed_qty: null, quote: null, quote_valid_until: null, reserved_qty: null, reserved_until: null,
  offer_id: null, created_at: "2026-11-12", updated_at: "2026-11-12", reservation_live: false, stock_reserved: { holds: 0, qty: 0, whole: 0 },
  offer_stage: null, asked: null, open_draft_id: null, ...o,
});

const stored = (o: Partial<StoredMatches> = {}): StoredMatches => ({
  deal: { id: "btd_1", kind: "demand", stage: "Qualified", qualified: true }, run: null, matches: [], markers: [], past: [],
  sellerQuote: null, reconfirm: null, ...o,
});

describe("stored matches", () => {
  beforeEach(() => forgetShared());
  afterEach(() => vi.unstubAllGlobals());

  it("offers Find matches on a deal with no run, with a plain warning when it is not qualified", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      return json(stored({ deal: { id: "btd_1", kind: "demand", stage: "New", qualified: false } }));
    }));
    render(<StoredMatchesView dealId="btd_1" kind="demand" />);
    fireEvent.click(await screen.findByRole("button", { name: "Find matches" }));
    expect(screen.getByText(/not qualified yet/)).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.startsWith('POST /api/bulk-listings/btd_1/stored-matches {"action":"run"}'))).toBe(true));
  });

  it("shows the five in order with reason, state, reservation and the checks on expand", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(stored({
      run: { at: "2026-11-12T10:00:00Z", by: "alex@rebattery.io", count: 2 },
      matches: [
        match(),
        match({ id: "bmt_2", rank: 2, name: "Supplier two", reason: "Same pack, quantity close.", state: "offered", reserved_qty: 12, reserved_until: "2026-11-19", reservation_live: true,
          stock_reserved: { holds: 2, qty: 27, whole: 0 }, offer_id: "bof_1", offer_stage: "offered" }),
      ],
    }))));
    render(<StoredMatchesView dealId="btd_1" kind="demand" />);
    expect(await screen.findByText("Exact model, 30 packs stated.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find matches again" })).toBeTruthy();
    expect(screen.getByText("Reserved 12 until 19 Nov · 27 of 30 reserved across deals")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Release" })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Why" })[0]);
    expect(screen.getByText("Check: Ask for SoH")).toBeTruthy();
    expect(screen.getByText(/Scorer rank 2, shown 1/)).toBeTruthy();
  });

  it("asks for a reason before a no", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      return json(stored({ run: { at: "2026-11-12", by: null, count: 1 }, matches: [match()] }));
    }));
    render(<StoredMatchesView dealId="btd_1" kind="demand" />);
    fireEvent.click(await screen.findByRole("button", { name: "No" }));
    const save = screen.getByRole("button", { name: "Save no" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sold elsewhere" }));
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.includes('"action":"no","reason":"Sold elsewhere"'))).toBe(true));
  });

  it("blocks asking buyers on a supply deal until the seller's quote is in date", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(stored({
      deal: { id: "bts_1", kind: "supply", stage: "Available", qualified: true }, run: { at: "2026-11-12", by: null, count: 1 },
      matches: [match({ candidate_kind: "company", candidate_key: "company:co_1" })],
      sellerQuote: { value: "1,495 GBP per pack", status: "unverified", validUntil: null, inDate: false },
    }))));
    render(<StoredMatchesView dealId="bts_1" kind="supply" />);
    expect(await screen.findByText(/has not confirmed a quote/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Draft re-confirm to seller" })).toBeTruthy();
  });
});
