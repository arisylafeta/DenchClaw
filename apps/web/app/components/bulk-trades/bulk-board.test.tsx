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

  it("shows each card's value, fee, chance, owner and next action, and the stage total beside the stage name", () => {
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={vi.fn()}
      shown={[row({ value_eur: 1_000_000, fee_eur: 100_000, owner: "Sean", likelihood: 70 }), row({ key: "b", id: "b", value_eur: 500_000, fee_eur: 50_000, next_action: null }), row({ key: "c", id: "c", progress: "New" })]} />);
    const offered = within(screen.getByRole("region", { name: "Offered" }));
    expect(offered.getByText("(2)")).toBeTruthy();
    expect(offered.getByText("€1.5M ticket").closest("[data-stage-total]")).toBeTruthy();
    const [first, second] = offered.getAllByRole("button");
    expect(first.querySelector("[data-card-value]")).toHaveTextContent("€1M");
    expect(first.querySelector("[data-card-fee]")).toHaveTextContent("€100k");
    expect(first.querySelector("[data-card-chance]")).toHaveTextContent("70%");
    expect(within(first.querySelector("[data-card-owner]") as HTMLElement).getByRole("img", { name: "Driver Sean" })).toBeTruthy();
    expect(within(first).getByText("Call seller")).toBeTruthy();
    expect(within(first).getByText("Overdue · 1 Oct")).toBeTruthy();
    expect(second.querySelector("[data-card-chance]")).toHaveTextContent("Set %");
    expect(within(second).getByRole("img", { name: "No driver" })).toBeTruthy();
    expect(within(second).getByText("No next action")).toBeTruthy();
  });

  it("sums fee × chance per stage and counts the deals missing either", () => {
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={vi.fn()}
      shown={[row({ fee_eur: 4000, likelihood: 50 }), row({ key: "b", id: "b", fee_eur: 2200, likelihood: 100 }), row({ key: "c", id: "c", fee_eur: 9000 }), row({ key: "d", id: "d", likelihood: 40 }),
        row({ key: "e", id: "e", progress: "Paid", fee_eur: 1000, likelihood: 100 })]} />);
    const offered = screen.getByRole("region", { name: "Offered" });
    expect(offered.querySelector("[data-stage-weighted]")).toHaveTextContent("€4.2k weighted");
    expect(offered.querySelector("[data-stage-unsized]")).toHaveTextContent("2 unsized");
    const paid = screen.getByRole("region", { name: "Paid" });
    expect(paid.querySelector("[data-stage-weighted]")).toHaveTextContent("€1k weighted");
    expect(paid.querySelector("[data-stage-unsized]")).toBeNull();
  });
});
