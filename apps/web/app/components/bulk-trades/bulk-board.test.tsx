// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      shown={[row({}), row({ key: "b", id: "b", title: "5MWh Cells", side: "buyer", progress: "Agreed" }), row({ key: "c", id: "c", title: "Odd", progress: "Negotiating" }), row({ key: "d", id: "d", title: "Early", progress: "Sourcing" })]} />);
    expect(within(screen.getByRole("region", { name: "Offered" })).getByText("40x Toyota Proace 50kWh Packs")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Negotiating" })).getByText("Odd")).toBeTruthy();
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Requests", "Offered", "Negotiating", "Agreed", "Paid", "Delivered", "Abandoned"]);
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

  it("lists open requests not yet offered in Requests, before the deal stages", () => {
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={vi.fn()}
      shown={[row({ key: "r", id: "r", kind: "demand", side: "buyer", title: "200 Leaf packs", progress: "Sourcing" }),
        row({ key: "n", id: "n", kind: "demand", side: "buyer", title: "Fresh ask", progress: "New" }),
        row({ key: "o", id: "o", kind: "demand", side: "buyer", title: "Offered ask", progress: "Offered" }),
        row({ key: "s", id: "s", title: "Spare lot", progress: "Available" })]} />);
    const requests = within(screen.getByRole("region", { name: "Requests" }));
    expect(requests.getByText("200 Leaf packs")).toBeTruthy();
    expect(requests.getByText("Fresh ask")).toBeTruthy();
    expect(requests.queryByText("Offered ask")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Offered" })).getByText("Offered ask")).toBeTruthy();
    expect(screen.queryByText("Spare lot")).toBeNull();
  });

  it("shows abandoned cards with why and when they stopped, and nothing drags without handlers", () => {
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={vi.fn()} shown={[row({})]}
      abandoned={[row({ key: "x", id: "x", kind: "demand", side: "buyer", title: "Lost ask", abandoned: { reason: "bought_elsewhere", at: "2026-11-20 10:00:00+00" } })]} />);
    const lost = within(screen.getByRole("region", { name: "Abandoned" }));
    expect(lost.getByText("Lost ask")).toBeTruthy();
    expect(lost.getByText("Bought elsewhere")).toBeTruthy();
    expect(lost.getByText("20 Nov")).toBeTruthy();
    expect(lost.queryByText("€0 weighted")).toBeNull();
    expect(document.querySelector("li[draggable=true]")).toBeNull();
  });

  it("asks why when a card is dropped on Abandoned, then abandons it with the reason and note", async () => {
    const onAbandon = vi.fn().mockResolvedValue(undefined);
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={vi.fn()} onAbandon={onAbandon} onReopen={vi.fn()}
      shown={[row({ key: "d", id: "d", kind: "demand", side: "buyer", title: "Proace ask", progress: "Negotiating" })]} />);
    const card = document.querySelector("[data-card=d]") as HTMLElement;
    const abandonedColumn = screen.getByRole("region", { name: "Abandoned" });
    fireEvent.dragStart(card);
    expect(abandonedColumn.getAttribute("data-drop-target")).toBe("true");
    expect(screen.getByRole("region", { name: "Offered" }).getAttribute("data-drop-target")).toBeNull();
    fireEvent.dragOver(abandonedColumn);
    fireEvent.drop(abandonedColumn);
    const prompt = within(screen.getByRole("form", { name: "Abandon deal" }));
    expect((prompt.getByRole("button", { name: "Abandon" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(prompt.getByRole("radio", { name: "Bought elsewhere" }));
    fireEvent.change(prompt.getByRole("textbox", { name: "Note" }), { target: { value: "Went with a cheaper broker" } });
    fireEvent.click(prompt.getByRole("button", { name: "Abandon" }));
    await waitFor(() => expect(onAbandon).toHaveBeenCalledWith(expect.objectContaining({ id: "d" }), "bought_elsewhere", "Went with a cheaper broker"));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Abandon deal" })).toBeNull());
  });

  it("keeps the prompt open with the error when the abandon fails, and Cancel leaves the card where it was", async () => {
    const onAbandon = vi.fn().mockRejectedValue(new Error("This listing is already closed. Refresh the board."));
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={vi.fn()} onAbandon={onAbandon} onReopen={vi.fn()} shown={[row({})]} />);
    const abandonedColumn = screen.getByRole("region", { name: "Abandoned" });
    fireEvent.dragStart(document.querySelector("[data-card=a]") as HTMLElement);
    fireEvent.drop(abandonedColumn);
    const prompt = within(screen.getByRole("form", { name: "Abandon deal" }));
    expect(prompt.getByRole("radio", { name: "Stock gone" })).toBeTruthy();
    fireEvent.click(prompt.getByRole("radio", { name: "Stock gone" }));
    fireEvent.click(prompt.getByRole("button", { name: "Abandon" }));
    expect(await prompt.findByRole("alert")).toHaveTextContent("already closed");
    fireEvent.click(prompt.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Abandon deal" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Offered" })).getByText("40x Toyota Proace 50kWh Packs")).toBeTruthy();
  });

  it("reopens a card dragged out of Abandoned, and only Abandoned takes live cards", () => {
    const onReopen = vi.fn();
    render(<BulkBoard loading={false} error={null} today="2026-10-23" onOpen={vi.fn()} onAbandon={vi.fn()} onReopen={onReopen} shown={[]}
      abandoned={[row({ key: "x", id: "x", abandoned: { reason: "gone", at: null } })]} />);
    fireEvent.dragStart(document.querySelector("[data-card=x]") as HTMLElement);
    expect(screen.getByRole("region", { name: "Abandoned" }).getAttribute("data-drop-target")).toBeNull();
    const offered = screen.getByRole("region", { name: "Offered" });
    fireEvent.drop(offered);
    expect(onReopen).toHaveBeenCalledWith(expect.objectContaining({ id: "x" }));
  });
});
