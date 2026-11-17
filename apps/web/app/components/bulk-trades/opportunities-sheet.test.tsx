// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NO_FILTERS } from "@/lib/bulk-sheet";
import { SheetFilterBar, WaitingBadge } from "./opportunities-sheet";

describe("SheetFilterBar sort control", () => {
  it("offers a Sort menu only when a handler is given, and reports the chosen order", () => {
    const base = { rows: [], filters: NO_FILTERS, onFilters: vi.fn() };
    const { rerender } = render(<SheetFilterBar {...base} />);
    expect(screen.queryByLabelText("Sort by")).toBeNull();
    const onSort = vi.fn();
    rerender(<SheetFilterBar {...base} sort="urgent" onSort={onSort} />);
    const select = screen.getByLabelText("Sort by") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["urgent", "newest", "score_desc", "score_asc", "due", "stage", "fee_desc"]);
    expect(select.value).toBe("urgent");
    fireEvent.change(select, { target: { value: "score_asc" } });
    expect(onSort).toHaveBeenCalledWith("score_asc");
  });
});

describe("SheetFilterBar waiting-on", () => {
  const mk = (id: string, waiting_on: "us" | "them" | null) => ({
    key: id, id, kind: "demand" as const, side: "buyer" as const, title: `Row ${id}`, company: "Co", company_id: null, category: null,
    progress: "New" as const, tone: "new" as const, score: null, latest: null, next_action: null, next_due: null, owner: null, touched: null,
    waiting_on, waiting_since: waiting_on ? "2026-10-20" : null,
  });
  it("shows the badge (still used by the listing header), and a Waiting on filter that reports the choice", () => {
    const onFilters = vi.fn();
    const rows = [mk("a", "us"), mk("b", "them"), mk("c", null)];
    render(<>{rows.map((row) => <WaitingBadge key={row.id} row={row} />)}<SheetFilterBar rows={rows} filters={NO_FILTERS} onFilters={onFilters} /></>);
    expect(document.querySelectorAll("[data-waiting-on=us]").length).toBe(1);
    expect(document.querySelectorAll("[data-waiting-on=them]").length).toBe(1);
    expect(screen.getByText(/On us/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Waiting on"), { target: { value: "us" } });
    expect(onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, waiting: "us" });
  });
  it("offers to clear a waiting-on filter", () => {
    render(<SheetFilterBar rows={[]} filters={{ ...NO_FILTERS, waiting: "us" }} onFilters={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });
});


describe("SheetFilterBar stage chips", () => {
  it("shows each stage with its count and filters on a click, a second click clearing it", () => {
    const mk = (id: string, progress: "New" | "Qualified") => ({
      key: id, id, kind: "demand" as const, side: "buyer" as const, title: `Row ${id}`, company: "Co", company_id: null, category: null,
      progress, tone: "new" as const, score: null, latest: null, next_action: null, next_due: null, owner: null, touched: null,
    });
    const rows = [mk("a", "New"), mk("b", "New"), mk("c", "Qualified")];
    const onFilters = vi.fn();
    const { rerender } = render(<SheetFilterBar rows={rows} filters={NO_FILTERS} stages={["New", "Qualified", "Sourcing"]} onFilters={onFilters} />);
    const chips = screen.getByRole("group", { name: "Stage" }).querySelectorAll("button");
    expect(Array.from(chips).map((chip) => chip.textContent)).toEqual(["All3", "New2", "Qualified1", "Sourcing0"]);
    fireEvent.click(chips[1]);
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, progress: "New" });
    rerender(<SheetFilterBar rows={rows} filters={{ ...NO_FILTERS, progress: "New" }} stages={["New", "Qualified", "Sourcing"]} onFilters={onFilters} />);
    fireEvent.click(screen.getByRole("button", { name: /^New/ }));
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, progress: "all" });
  });
});

describe("SheetFilterBar more stages", () => {
  it("keeps the main stages as buttons and the rest in a menu that filters and shows the choice", () => {
    const rows = [{ key: "a", id: "a", kind: "demand" as const, side: "buyer" as const, title: "Row a", company: "Co", company_id: null, category: null,
      progress: "Paid" as const, tone: "closing" as const, score: null, latest: null, next_action: null, next_due: null, owner: null, touched: null }];
    const onFilters = vi.fn();
    const props = { rows, stages: ["New", "Offered", "Paid", "Delivered"], mainStages: ["New", "Offered"], onFilters };
    const { rerender } = render(<SheetFilterBar {...props} filters={NO_FILTERS} />);
    expect(Array.from(screen.getByRole("group", { name: "Stage" }).querySelectorAll("button")).map((b) => b.firstChild?.textContent)).toEqual(["All", "New", "Offered"]);
    const menu = screen.getByLabelText("More stages") as HTMLSelectElement;
    expect(Array.from(menu.options).map((o) => o.textContent)).toEqual(["More stages", "Paid (1)", "Delivered (0)"]);
    fireEvent.change(menu, { target: { value: "Paid" } });
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, progress: "Paid" });
    rerender(<SheetFilterBar {...props} filters={{ ...NO_FILTERS, progress: "Paid" }} />);
    expect(screen.getByLabelText("More stages")).toHaveValue("Paid");
    fireEvent.change(screen.getByLabelText("More stages"), { target: { value: "" } });
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, progress: "all" });
  });
});

describe("SheetFilterBar in the header popover", () => {
  it("leaves search out when the page header has it", () => {
    const { rerender } = render(<SheetFilterBar rows={[]} filters={NO_FILTERS} onFilters={vi.fn()} />);
    expect(screen.getByRole("searchbox")).toBeTruthy();
    rerender(<SheetFilterBar rows={[]} filters={NO_FILTERS} onFilters={vi.fn()} hideSearch />);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});
