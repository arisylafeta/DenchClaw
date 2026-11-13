// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MatchRow, MatchesResult, SupplierMatch } from "@/lib/matches-types";
import { MatchesTab } from "./matches-list";
import { DemandLinesEditor } from "./demand-lines-editor";
import { forgetShared } from "./trade-ui";

const row = (key: string, name: string, over: Partial<MatchRow> = {}): MatchRow => ({
  key, rank: 1, name, detail: null, tags: ["unlisted stock"], reason: "Fits", checks: [], price: null, offer: null, companyId: `co-${name}`, personId: null,
  contact: `${name.toLowerCase().replace(/\W+/g, "")}@example.test`, stockId: key.replace(/^stock:/, ""), holds: `${name} pack`, country: "Sweden", fit: [], ...over,
});
const north: SupplierMatch = {
  key: "company:co-North Parts", name: "North Parts", countries: ["Sweden"], tags: ["unlisted stock"], sourceKinds: ["stock list"], offer: null,
  companyId: "co-North Parts", personId: null, contact: "northparts@example.test",
  stock: [
    { rowKey: "stock:a", pack: "VW MEB 82 kWh pack", count: 12, stated: true, line: { id: "meb", label: "VW MEB 82 kWh" }, lineState: "fits", why: null, vehicles: "VW ID.4 8, Audi Q4 4", meta: "EUR 4,000 per pack · 30 Oct", price: "EUR 4,000 per pack", priceVaries: false, stockIds: ["a1", "a2"], units: 12 },
    { rowKey: "stock:b", pack: "Cupra Born 62 kWh pack", count: 3, stated: true, line: null, lineState: null, why: null, vehicles: null, meta: "EUR 3,600 per pack", price: "EUR 3,600 per pack", priceVaries: false, stockIds: ["b1"], units: 3 },
  ],
  cover: [{ id: "meb", label: "VW MEB 82 kWh", count: 12, state: "fits" }, { id: "zoe", label: "Renault Zoe 41 kWh", count: 0, state: "none" }],
  onLines: 12, other: 3, linesCovered: 1, needCovered: 12, otherOnly: false, rowKeys: ["stock:a", "stock:b"],
};
const west: SupplierMatch = { ...north, key: "company:co-West", name: "West Spares", companyId: "co-West", stock: [{ ...north.stock[1], rowKey: "stock:c" }], cover: [{ id: "meb", label: "VW MEB 82 kWh", count: 0, state: "none" }, { id: "zoe", label: "Renault Zoe 41 kWh", count: 0, state: "none" }], onLines: 0, other: 3, linesCovered: 0, needCovered: 0, otherOnly: true, rowKeys: ["stock:c"] };
const result: MatchesResult = {
  id: "btd_1", kind: "demand", lotKey: { line: "Mixed packs", full: [], open: false }, rows: [row("stock:a", "North Parts"), row("stock:b", "North Parts"), row("stock:c", "West Spares")],
  considered: 3, blocked: null, errors: [], buyer: "Example Buyer S.A.",
  lines: [
    { id: "meb", label: "VW MEB 82 kWh", need: "10–20", qtyMin: 10, qtyMax: 20, found: 14, close: 2, suppliers: 1, state: "fits" },
    { id: "zoe", label: "Renault Zoe 41 kWh", need: "4", qtyMin: 4, qtyMax: null, found: 0, close: 0, suppliers: 0, state: "misses" },
  ],
  suppliers: [north, west],
};

function stub(payload: MatchesResult, calls: { url: string; method: string; body?: string }[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (init?.method === "POST" && url.endsWith("/offers")) return new Response(JSON.stringify({ offer: { id: "o1", stage: "candidate", updated_at: "2026-11-13T10:00:00Z" } }), { status: 200 });
    return new Response(JSON.stringify(payload), { status: 200 });
  }));
}

describe("Group matches", () => {
  afterEach(() => { vi.unstubAllGlobals(); forgetShared(); });

  it("opens on Group matches for a request with several pack types, with what the buyer needs", async () => {
    stub(result);
    render(<MatchesTab kind="demand" id="btd_1" active />);
    const needs = await screen.findByRole("region", { name: "What Example needs" });
    expect(needs).toHaveTextContent("2 pack types, 14–24 packs");
    expect(within(needs).getByText("VW MEB 82 kWh").closest("li")).toHaveTextContent("12 found");
    expect(within(needs).getByText("VW MEB 82 kWh").closest("li")).toHaveTextContent("+ 2 maybe");
    expect(within(needs).getByText("Renault Zoe 41 kWh").closest("li")).toHaveTextContent("Nothing found yet");
    expect(screen.getByRole("tab", { name: "Group matches · 1 suppliers" })).toHaveAttribute("aria-selected", "true");
    const group = screen.getByRole("region", { name: "Group matches" });
    expect(within(group).getByRole("button", { name: /North Parts/ })).toHaveAttribute("aria-expanded", "true");
    expect(group).toHaveTextContent("12 packs on 1 of 2 pack types · 3 other matching");
    expect(group).toHaveTextContent("Same pack in VW ID.4 8, Audi Q4 4");
    // A supplier with only other stock is folded away.
    expect(within(group).queryByRole("button", { name: /West Spares/ })).not.toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "Show them" }));
    expect(within(group).getByRole("button", { name: /West Spares/ })).toBeInTheDocument();
  });

  it("adds a supplier as one offer holding their stock on the buyer's types, and marks them in both views", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    stub(result, calls);
    render(<MatchesTab kind="demand" id="btd_1" active />);
    await userEvent.click(await screen.findByRole("button", { name: "Add 12 packs to offers" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    expect(body).toMatchObject({ name: "North Parts", companyId: "co-North Parts", stage: "candidate", source: "match", data: { stock_opportunity_id: "a1", stock_opportunity_ids: ["a1", "a2"] } });
    expect(await screen.findByText(/In offers · Candidate/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Per battery matches/ }));
    expect(screen.getAllByText(/In offers · Candidate/).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the Per battery list alone for a request with fewer than two pack types", async () => {
    stub({ ...result, lines: null });
    render(<MatchesTab kind="demand" id="btd_1" active />);
    expect(await screen.findByRole("region", { name: "Matches" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Matches view" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /needs/ })).not.toBeInTheDocument();
  });
});

describe("Pack types on Details", () => {
  afterEach(() => { vi.unstubAllGlobals(); forgetShared(); });

  it("saves the pack types the person typed", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined }); return new Response(JSON.stringify({ lines: [] }), { status: 200 }); }));
    const onSaved = vi.fn();
    render(<DemandLinesEditor demandId="btd_1" lines={[{ id: "meb", label: "VW MEB 82 kWh", products: ["meb"], kwh: [82], qty_min: 10, qty_max: 20 }]} onSaved={onSaved} />);
    expect(screen.getByText("× 10–20")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a pack type" }));
    await userEvent.type(screen.getByLabelText("Pack type 2: name"), "Renault Zoe 41 kWh");
    await userEvent.type(screen.getByLabelText("Pack type 2: words a seller writes"), "zoe");
    await userEvent.type(screen.getByLabelText("Pack type 2: kWh"), "41");
    await userEvent.type(screen.getByLabelText("Pack type 2: fewest"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save pack types" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/bulk-trades/demand/btd_1/lines");
    expect(JSON.parse(put.body!)).toEqual({ lines: [
      { id: "meb", label: "VW MEB 82 kWh", products: ["meb"], kwh: [82], qty_min: 10, qty_max: 20 },
      { label: "Renault Zoe 41 kWh", products: ["zoe"], kwh: [41], qty_min: 4, qty_max: null },
    ] });
  });
});
