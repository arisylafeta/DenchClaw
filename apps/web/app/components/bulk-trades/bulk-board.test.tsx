// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkBoard } from "./bulk-board";
import type { SheetRow } from "@/lib/bulk-sheet";

afterEach(cleanup);
const row = (patch: Partial<SheetRow>): SheetRow => ({
  key: "a", id: "a", kind: "supply", side: "seller", title: "40x Toyota Proace 50kWh Packs", company: "Motorgreen", company_id: null,
  category: null, progress: "Offered", tone: "new", score: 71, latest: null, next_action: "Call seller", next_due: "2026-10-01", owner: null, touched: null, ...patch,
});

describe("Bulk Trades board", () => {
  it("puts each card in its stage column and opens it on click", () => {
    const onOpen = vi.fn();
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={onOpen}
      shown={[row({}), row({ key: "b", id: "b", title: "5MWh Cells", side: "buyer", progress: "Agreed" }), row({ key: "c", id: "c", title: "Odd", progress: "Negotiating" }), row({ key: "d", id: "d", title: "Early", progress: "Found" })]} />);
    expect(within(screen.getByRole("region", { name: "Offered" })).getByText("40x Toyota Proace 50kWh Packs")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Negotiating" })).getByText("Odd")).toBeTruthy();
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Offered", "Negotiating", "Agreed", "Paid", "Delivered"]);
    expect(screen.queryByText("Early")).toBeNull();
    const bid = within(screen.getByRole("region", { name: "Agreed" }));
    fireEvent.click(bid.getByText("5MWh Cells"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("marks cards that wait on us or on them", () => {
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={vi.fn()}
      shown={[row({ waiting_on: "us", waiting_since: "2026-10-20" }), row({ key: "b", id: "b", title: "Other", waiting_on: "them" }), row({ key: "c", id: "c", title: "Unjudged" })]} />);
    expect(document.querySelectorAll("[data-waiting-on=us]").length).toBe(1);
    expect(document.querySelectorAll("[data-waiting-on=them]").length).toBe(1);
    expect(screen.getByText("On us")).toBeTruthy();
  });

  it("shows each card's value and owner and the stage total beside the stage name", () => {
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={vi.fn()}
      shown={[row({ value_eur: 1_000_000, owner: "Sean", likelihood: 70 }), row({ key: "b", id: "b", value_eur: 500_000 }), row({ key: "c", id: "c", progress: "New" })]} />);
    const offered = within(screen.getByRole("region", { name: "Offered" }));
    expect(offered.getByText("(2)")).toBeTruthy();
    expect(offered.getByText("€1.5M").closest("[data-stage-total]")).toBeTruthy();
    expect(offered.getByText("70% · Owner Sean")).toBeTruthy();
    expect(offered.getByText("No owner")).toBeTruthy();
    expect(offered.getByText("€1M")).toBeTruthy();
  });
});

