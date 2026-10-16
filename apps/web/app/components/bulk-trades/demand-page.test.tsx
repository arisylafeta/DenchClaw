// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Demand } from "@/lib/bulk-demand";
import { DemandPage } from "./demand-page";
import { SuggestedBuyers } from "./suggested-buyers";

const TODAY = "2026-09-30";

function row(overrides: Partial<Demand>): Demand {
  return {
    id: "btd_1", kind: "standing", basis: "stated", buyer: "Green Voltage", company_id: null, person_id: null, contact: "Adam Baker",
    email: "adam@gv.example", wants: "Matched packs in repeat batches", quantity: "MWh a year", location: "UK", note: null,
    needed_by: null, volume: null, volume_unit: null, max_price: null, price_currency: null, price_unit: null, spec: {},
    source_kind: "email", source_label: "Gmail · adam@gv.example", source_url: null, source_quote: "Can you supply matched packs?",
    observed_on: "2026-09-18", status: "open", closed_reason: null, confirmed_on: "2026-09-18",
    product_family: "VW MEB", fee_eur: 10000, price_basis: "buyer", reputation: "active", qualify_question: null, qualify_asked_on: null,
    qualify_entered_on: null, activity_count: 0, last_activity_at: null,
    moved_to: null, asked_on: "2026-09-18", score: null, expected_fee: null, has_stock: false,
    updated_at: "2026-09-18T10:00:00Z", fits: [], trades: [], waiting: null, tier: null, ...overrides,
  };
}

const ROWS = [
  row({ fits: [{ lot_id: "bt_69", title: "Iveco FPT eBS69", strength: "strong", reason: "A matched 41-pack lot.", buyer_id: null }] }),
  row({ id: "btd_2", buyer: "CycleWatt", contact: "Junxing Huang", wants: "Renault ZOE 41 kWh packs", confirmed_on: "2026-07-01" }),
  row({ id: "btd_3", buyer: "Old buyer", wants: "Anything", status: "closed", closed_reason: "bought_elsewhere" }),
  row({ id: "btd_4", kind: "request", basis: null, buyer: "Exigo Recycling", wants: "CATL cells, urgent", needed_by: "2026-10-21",
    volume: 10000, volume_unit: "cells", spec: { chemistries: ["LFP"], formats: ["Cells"] }, max_price: 30, price_currency: "EUR", price_unit: "kWh" }),
  row({ id: "btd_5", kind: "request", basis: null, buyer: "Late buyer", wants: "Modules", needed_by: "2026-09-01",
    waiting: { since: new Date(Date.now() - 3 * 86_400_000).toISOString(), who: "Rahul", subject: "Cells?" } }),
  row({ id: "btd_6", basis: "estimated", buyer: "Gridturn", fee_eur: 50000, wants: "Second-life EV modules", confirmed_on: null, observed_on: "2026-09-20",
    trades: [{ lot_id: "bt_69", title: "Iveco FPT eBS69", status: "Won" }] }),
  row({ id: "btd_7", buyer: "Qualify buyer", status: "qualifying", fee_eur: null, qualify_question: "How many packs?" }),
];

function mockFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/bulk-trades/demand" && !init?.method) {
      // List proposals are reviewed in the shared Inbox, not inline here.
      return new Response(JSON.stringify({ demand: ROWS, possible: [{
        id: "7", lot_id: null, kind: "possible_demand", target: null, proposed: { buyer: "Revoxa buyer" }, summary: "Revoxa buyer wants: LFP packs",
        quote: "We are looking for LFP batteries", source_kind: "gmail", source_url: null, source_label: "Gmail · dawid@revoxa.example",
        source_at: "2026-08-17", created_at: "2026-09-30T09:00:00Z",
      }] }));
    }
    if (url === "/api/bulk-trades/demand" && init?.method === "POST") {
      return new Response(JSON.stringify({ demand: row({ id: "btd_new", ...JSON.parse(String(init.body)) }) }), { status: 201 });
    }
    if (url.endsWith("/activity")) return new Response(JSON.stringify({ activity: [] }));
    return new Response(JSON.stringify({ demand: ROWS[0] }));
  });
}

describe("DemandPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ranks demand and separates qualifying and closed", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    const table = await screen.findByRole("region", { name: "Demand" });
    expect(screen.getByRole("button", { name: "Demand 5" })).toHaveAttribute("aria-pressed", "true");
    expect(within(table).getByText("Exigo Recycling")).toBeInTheDocument();
    expect(within(table).getByText("Green Voltage")).toBeInTheDocument();
    expect(within(table).getAllByTitle(/buyer budget.*expected/)).toHaveLength(5);
    expect(within(table).getAllByRole("button")[0]).toHaveTextContent("Gridturn");
    await userEvent.click(screen.getByRole("button", { name: "Qualifying 1" }));
    expect(within(table).getByText("How many packs?")).toBeInTheDocument();
    expect(within(table).queryByText("Green Voltage")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Closed 1" }));
    expect(within(table).getByText("Old buyer")).toBeInTheDocument();
  });
  it("edits ranking fields and qualifying question, and reconfirms freshness", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /Green Voltage/ }));
    const panel = screen.getByRole("complementary", { name: "Demand detail" });
    await userEvent.click(within(panel).getByRole("button", { name: "Still wanted" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_1", expect.objectContaining({ body: JSON.stringify({ action: "confirm" }) }));
    await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit demand" });
    expect(within(within(dialog).getByLabelText("Status")).queryByRole("option", { name: "Closed" })).not.toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText("Expected fee (EUR)"));
    await userEvent.type(within(dialog).getByLabelText("Expected fee (EUR)"), "2500");
    await userEvent.selectOptions(within(dialog).getByLabelText("Price basis"), "estimate");
    await userEvent.selectOptions(within(dialog).getByLabelText("Reputation"), "paid");
    await userEvent.selectOptions(within(dialog).getByLabelText("Status"), "qualifying");
    await userEvent.type(within(dialog).getByLabelText("Qualification question"), "Still buying?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_1",
      expect.objectContaining({ method: "PATCH", body: expect.stringContaining('"fee_eur":2500') })));
    const call = fetchMock.mock.calls.find(([, init]) => typeof init?.body === "string" && init.body.includes('"fee_eur":2500'));
    expect(JSON.parse(call![1]!.body as string)).toMatchObject({
      product_family: "VW MEB", fee_eur: 2500, price_basis: "estimate", reputation: "paid",
      status: "qualifying", qualify_question: "Still buying?",
    });
  });

  it("edits closed demand without allowing status changes or resending its status", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Closed 1" }));
    await userEvent.click(screen.getByRole("button", { name: /Old buyer/ }));
    const panel = screen.getByRole("complementary", { name: "Demand detail" });
    expect(within(panel).getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit demand" });
    expect(within(dialog).queryByLabelText("Status")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_3", expect.objectContaining({ method: "PATCH" })));
    const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/bulk-trades/demand/btd_3" && init?.method === "PATCH");
    expect(JSON.parse(call![1]!.body as string)).not.toHaveProperty("status");
  });


  it("pins suggested supply to activity and opens its trade", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onOpenTrade = vi.fn();
    render(<DemandPage today={TODAY} onOpenTrade={onOpenTrade} />);
    await userEvent.click(await screen.findByRole("button", { name: /Green Voltage/ }));
    const panel = screen.getByRole("complementary", { name: "Demand detail" });
    await userEvent.click(within(panel).getByText("Suggested supply · 1"));
    await userEvent.click(within(panel).getByRole("button", { name: "Pin" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_1/activity", expect.objectContaining({
      method: "POST", body: JSON.stringify({ kind: "supply", title: "Iveco FPT eBS69", body: "A matched 41-pack lot.", refKind: "lot", refId: "bt_69" }),
    }));
    await userEvent.click(within(panel).getByRole("button", { name: "Iveco FPT eBS69" }));
    expect(onOpenTrade).toHaveBeenCalledWith("bt_69");
  });

  it("adds work to the activity log", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /Green Voltage/ }));
    const panel = screen.getByRole("complementary", { name: "Demand detail" });
    await userEvent.selectOptions(within(panel).getByLabelText("Activity kind"), "call");
    await userEvent.type(within(panel).getByLabelText("Activity title"), "Confirmed volume");
    await userEvent.click(within(panel).getByRole("button", { name: "Add" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_1/activity", expect.objectContaining({
      method: "POST", body: JSON.stringify({ kind: "call", title: "Confirmed volume" }),
    }));
  });

  it("adds a request with its date, volume, price and spec from the form", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Add demand" }));
    const dialog = screen.getByRole("dialog", { name: "Add demand" });
    await userEvent.type(within(dialog).getByLabelText("Buyer"), "Somerset EV");
    await userEvent.type(within(dialog).getByLabelText("Wants"), "MEB modules for tractor conversions");
    await userEvent.type(within(dialog).getByLabelText("Needed by"), "2026-10-31");
    await userEvent.type(within(dialog).getByLabelText("Volume in total"), "40");
    await userEvent.selectOptions(within(dialog).getByLabelText("Unit"), "modules");
    await userEvent.type(within(dialog).getByLabelText("Max price"), "25");
    await userEvent.click(within(within(dialog).getByRole("group", { name: "Chemistry" })).getByRole("button", { name: "NMC" }));
    await userEvent.click(within(within(dialog).getByRole("group", { name: "Format" })).getByRole("button", { name: "Modules" }));
    await userEvent.type(within(dialog).getByLabelText("Min SOH %"), "70");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add demand" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand", expect.objectContaining({ method: "POST" })));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body));
    expect(body).toMatchObject({
      kind: "request", needed_by: "2026-10-31", buyer: "Somerset EV", wants: "MEB modules for tractor conversions", quantity: null,
      volume: 40, volume_unit: "modules", max_price: 25, price_currency: "EUR", price_unit: "kWh",
      spec: { chemistries: ["NMC"], formats: ["Modules"], min_soh: 70 },
    });
    expect(body).not.toHaveProperty("basis");
  });

  it("adds a standing buy-box with a basis and no date", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Add demand" }));
    const dialog = screen.getByRole("dialog", { name: "Add demand" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Standing: ongoing buy-box" }));
    expect(within(dialog).queryByLabelText("Needed by")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Buyer"), "STN Power Systems");
    await userEvent.type(within(dialog).getByLabelText("Wants"), "Tested EV packs on a steady basis");
    await userEvent.selectOptions(within(dialog).getByLabelText("Basis"), "agreed");
    await userEvent.type(within(dialog).getByLabelText("Volume a month"), "8");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add demand" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand", expect.objectContaining({ method: "POST" })));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body));
    expect(body).toMatchObject({ kind: "standing", basis: "agreed", volume: 8, volume_unit: "packs", max_price: null, spec: {} });
    expect(body).not.toHaveProperty("needed_by");
  });
});

describe("SuggestedBuyers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds a suggested buyer or hides a poor fit", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<SuggestedBuyers tradeId="bt_69" onChanged={onChanged} suggested={[
      { demand_id: "btd_1", tier: "A", stage: "Engaged", group: "offer", kind: "request", basis: null, buyer: "H. Nolden Investment",
        contact: "Markus", wants: "Tested EV packs 50 kWh+", needed_by: "2026-10-15", confirmed_on: "2026-09-21", strength: "strong",
        reason: "A homogeneous lot.",
        more: [{ demand_id: "btd_2", wants: "Modules for BESS", strength: "partial", reason: "Modules, not packs." }] },
      { demand_id: "btd_3", tier: null, stage: "New", group: "introduce", kind: "standing", basis: "estimated", buyer: "Volt Repair Kft",
        contact: null, wants: "EV packs for repair", needed_by: null, confirmed_on: null, strength: "partial",
        reason: "Repairs packs like these; estimated.", more: [] },
    ]} />);
    expect(screen.getByRole("region", { name: "Offer now" })).toHaveTextContent("H. Nolden Investment");
    const introduce = screen.getByRole("region", { name: "Introduce" });
    expect(introduce).not.toHaveTextContent("Volt Repair Kft"); // research matches stay folded until asked for
    await userEvent.click(within(introduce).getByRole("button", { name: "Show" }));
    expect(introduce).toHaveTextContent("Volt Repair Kft");
    expect(screen.getByText("Strong fit")).toBeInTheDocument();
    expect(screen.getByText("· needed by 15 Oct", { exact: false })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("region", { name: "Offer now" })).getByRole("button", { name: "Add to buyers" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_69/suggested/btd_1", expect.objectContaining({ method: "POST" }));
    await userEvent.click(screen.getByRole("button", { name: "Not a fit: H. Nolden Investment" }));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/bulk-trades/bt_69/suggested/btd_1", expect.objectContaining({ method: "DELETE" }));
    expect(onChanged).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "+1 more want" }));
    expect(screen.getByText(/Modules for BESS/)).toBeInTheDocument();
  });
});
