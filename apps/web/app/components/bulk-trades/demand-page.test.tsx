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
    id: "btd_1", buyer: "Green Voltage", company_id: null, person_id: null, contact: "Adam Baker", email: "adam@gv.example",
    wants: "Matched packs in repeat batches", quantity: "MWh a year", location: "UK", note: null, source_label: "Gmail · adam@gv.example",
    source_url: null, source_quote: "Can you supply matched packs?", status: "open", closed_reason: null, confirmed_on: "2026-09-18",
    updated_at: "2026-09-18T10:00:00Z", fits: [], ...overrides,
  };
}

const ROWS = [
  row({ fits: [{ lot_id: "bt_69", title: "Iveco FPT eBS69", strength: "strong", reason: "A matched 41-pack lot.", buyer_id: null }] }),
  row({ id: "btd_2", buyer: "CycleWatt", contact: "Junxing Huang", wants: "Renault ZOE 41 kWh packs", confirmed_on: "2026-07-01" }),
  row({ id: "btd_3", buyer: "Old buyer", wants: "Anything", status: "closed", closed_reason: "bought_elsewhere" }),
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

  it("lists open demand with stale rows marked, filters, and shows possible demand", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    const table = await screen.findByRole("region", { name: "Demand" });
    expect(within(table).getByText("Green Voltage")).toBeInTheDocument();
    expect(within(table).getByText("Iveco FPT eBS69")).toBeInTheDocument();
    expect(within(table).getByText("Still wanted?")).toBeInTheDocument(); // CycleWatt, confirmed 1 Jul
    expect(within(table).queryByText("Old buyer")).not.toBeInTheDocument();
    const possible = screen.getByRole("region", { name: "Possible demand" });
    expect(within(possible).getByText("Revoxa buyer wants: LFP packs")).toBeInTheDocument();
    expect(within(possible).getByRole("button", { name: "Add demand" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "To check 1" }));
    expect(within(table).queryByText("Green Voltage")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(within(table).getByText("Old buyer")).toBeInTheDocument();
  });

  it("opens a row's panel with the trades it fits, and adds the buyer to one", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onOpenTrade = vi.fn();
    render(<DemandPage today={TODAY} onOpenTrade={onOpenTrade} />);
    await userEvent.click(await screen.findByRole("button", { name: /Green Voltage/ }));
    const panel = screen.getByRole("complementary", { name: "Demand detail" });
    expect(within(panel).getByText("A matched 41-pack lot.")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Add as buyer on this trade" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_69/suggested/btd_1", expect.objectContaining({ method: "POST" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Iveco FPT eBS69" }));
    expect(onOpenTrade).toHaveBeenCalledWith("bt_69");
  });

  it("adds demand from the form", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DemandPage today={TODAY} onOpenTrade={() => {}} />);
    await screen.findByRole("region", { name: "Possible demand" });
    const [, headerButton] = screen.getAllByRole("button", { name: "Add demand" }); // the first is the card's
    await userEvent.click(headerButton);
    const dialog = screen.getByRole("dialog", { name: "Add demand" });
    await userEvent.type(within(dialog).getByLabelText("Buyer"), "Somerset EV");
    await userEvent.type(within(dialog).getByLabelText("Wants"), "MEB modules for tractor conversions");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add demand" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand", expect.objectContaining({ method: "POST" })));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body));
    expect(body).toMatchObject({ buyer: "Somerset EV", wants: "MEB modules for tractor conversions", quantity: null });
  });
});

describe("SuggestedBuyers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds a suggested buyer or hides a poor fit", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<SuggestedBuyers tradeId="bt_69" onChanged={onChanged} suggested={[
      { demand_id: "btd_1", buyer: "H. Nolden Investment", contact: "Markus", wants: "Tested EV packs 50 kWh+", confirmed_on: "2026-09-21", strength: "strong", reason: "A homogeneous lot." },
    ]} />);
    expect(screen.getByText("Strong fit")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add to buyers" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_69/suggested/btd_1", expect.objectContaining({ method: "POST" }));
    await userEvent.click(screen.getByRole("button", { name: "Not a fit: H. Nolden Investment" }));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/bulk-trades/bt_69/suggested/btd_1", expect.objectContaining({ method: "DELETE" }));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
