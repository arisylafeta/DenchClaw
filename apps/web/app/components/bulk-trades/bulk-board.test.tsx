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
      shown={[row({}), row({ key: "b", id: "b", title: "5MWh Cells", side: "buyer", progress: "Bid in" }), row({ key: "c", id: "c", title: "Odd", progress: "Unknown" })]} />);
    expect(within(screen.getByRole("region", { name: "New" })).getByText("40x Toyota Proace 50kWh Packs")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "New" })).getByText("Odd")).toBeTruthy();
    const bid = within(screen.getByRole("region", { name: "Bid in" }));
    fireEvent.click(bid.getByText("5MWh Cells"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });
});
