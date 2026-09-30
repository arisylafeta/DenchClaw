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
  row({ id: "btd_6", basis: "estimated", buyer: "Gridturn", wants: "Second-life EV modules", confirmed_on: null, observed_on: "2026-09-20",
    trades: [{ lot_id: "bt_69", title: "Iveco FPT eBS69", status: "Won" }] }),
];

function mockFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/bulk-trades/demand" && !init?.method) {
      return new Response(JSON.stringify({ demand: ROWS, possible: [{
        id: "7", lot_id: null, kind: "possible_demand", target: null, proposed: { buyer: "Revoxa buyer" }, summary: "Revoxa buyer wants: LFP packs",
        quote: "We are looking for LFP batteries", source_kind: "gmail", source_url: null, source_label: "Gmail · dawid@revoxa.example",
        source_at: "2026-08-17", created_at: "2026-09-30T09:00:00Z",
      }] }));
    }
    if (url === "/api/bulk-trades/demand" && init?.method === "POST") {
      return new Response(JSON.stringify({ demand: row({ id: "btd_new", ...JSON.parse(String(init.body)) }) }), { status: 201 });
    }
    return new Response(JSON.stringify({ demand: ROWS[0] }));
  });
}

describe("DemandPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens on requests by date, splits standing buy-boxes by basis, marks rows to check, and shows possible demand", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    const table = await screen.findByRole("region", { name: "Demand" });
    // Requests first while there are any.
    expect(screen.getByRole("button", { name: "Requests 2" })).toHaveAttribute("aria-pressed", "true");
    expect(within(table).getByText("Exigo Recycling")).toBeInTheDocument();
    expect(within(table).getByText("10,000 cells")).toBeInTheDocument();
    expect(within(table).getByText("Chemistry: LFP · Format: Cells · max EUR 30/kWh")).toBeInTheDocument();
    expect(within(table).getByText("21 Oct")).toBeInTheDocument();
    expect(within(table).getByText("Past needed-by")).toBeInTheDocument(); // Late buyer, 1 Sep
    expect(within(table).getByText("Waiting 3d")).toBeInTheDocument();
    expect(within(table).queryByText("Green Voltage")).not.toBeInTheDocument();
    const possible = screen.getByRole("region", { name: "Possible demand" });
    expect(within(possible).getByText("Revoxa buyer wants: LFP packs")).toBeInTheDocument();
    expect(within(possible).getByRole("button", { name: "Add demand" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Standing 3" }));
    expect(within(table).getByText("Green Voltage")).toBeInTheDocument();
    expect(within(table).getByText("Iveco FPT eBS69")).toBeInTheDocument();
    expect(within(table).getByText("Estimated")).toBeInTheDocument();
    expect(within(table).getAllByText("Stated")).toHaveLength(2);
    expect(within(table).getByText("Still wanted?")).toBeInTheDocument(); // CycleWatt, confirmed 1 Jul
    expect(within(table).queryByText("Old buyer")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "To check 2" }));
    expect(within(table).queryByText("Green Voltage")).not.toBeInTheDocument();
    expect(within(table).getByText("Late buyer")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(within(table).getByText("Old buyer")).toBeInTheDocument();
  });

  it("moves a buy-box to agreed, turns a request into a standing buy-box, and shows the trades it was offered on", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onOpenTrade = vi.fn();
    render(<DemandPage today={TODAY} onOpenTrade={onOpenTrade} />);
    await userEvent.click(await screen.findByRole("button", { name: /Exigo Recycling/ }));
    let panel = screen.getByRole("complementary", { name: "Demand detail" });
    expect(within(panel).getByText("EUR 30/kWh")).toBeInTheDocument();
    expect(within(panel).getByRole("list", { name: "Spec" })).toHaveTextContent("Chemistry: LFPFormat: Cells");
    expect(within(panel).queryByRole("button", { name: "Agreed with buyer" })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Make standing" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_4", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "make_standing" }) }));

    await userEvent.click(screen.getByRole("button", { name: "Standing 3" }));
    await userEvent.click(screen.getByRole("button", { name: /Gridturn/ }));
    panel = screen.getByRole("complementary", { name: "Demand detail" });
    expect(within(panel).getByRole("button", { name: "Research still holds" })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Agreed with buyer" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_6", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "basis", basis: "agreed" }) }));
    await userEvent.click(within(panel).getByRole("button", { name: /Iveco FPT eBS69\s*Won/ }));
    expect(onOpenTrade).toHaveBeenCalledWith("bt_69");
  });

  it("opens a row's panel with the trades it fits, and adds the buyer to one", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onOpenTrade = vi.fn();
    render(<DemandPage today={TODAY} onOpenTrade={onOpenTrade} />);
    await userEvent.click(await screen.findByRole("button", { name: "Standing 3" }));
    await userEvent.click(screen.getByRole("button", { name: /Green Voltage/ }));
    const panel = screen.getByRole("complementary", { name: "Demand detail" });
    expect(within(panel).getByText("A matched 41-pack lot.")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Add as buyer on this trade" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_69/suggested/btd_1", expect.objectContaining({ method: "POST" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Iveco FPT eBS69" }));
    expect(onOpenTrade).toHaveBeenCalledWith("bt_69");
  });

  it("adds a request with its date, volume, price and spec from the form", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    await screen.findByRole("region", { name: "Possible demand" });
    const [, headerButton] = screen.getAllByRole("button", { name: "Add demand" }); // the first is the card's
    await userEvent.click(headerButton);
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
    await screen.findByRole("region", { name: "Possible demand" });
    await userEvent.click(screen.getAllByRole("button", { name: "Add demand" })[1]);
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
      { demand_id: "btd_1", tier: "A", kind: "request", basis: null, buyer: "H. Nolden Investment", contact: "Markus", wants: "Tested EV packs 50 kWh+",
        needed_by: "2026-10-15", confirmed_on: "2026-09-21", strength: "strong", reason: "A homogeneous lot." },
    ]} />);
    expect(screen.getByText("Strong fit")).toBeInTheDocument();
    expect(screen.getByText("Request")).toBeInTheDocument();
    expect(screen.getByText("Tier A")).toBeInTheDocument();
    expect(screen.getByText("· needed by 15 Oct", { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add to buyers" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_69/suggested/btd_1", expect.objectContaining({ method: "POST" }));
    await userEvent.click(screen.getByRole("button", { name: "Not a fit: H. Nolden Investment" }));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/bulk-trades/bt_69/suggested/btd_1", expect.objectContaining({ method: "DELETE" }));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
