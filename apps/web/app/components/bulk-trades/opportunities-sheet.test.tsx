// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NO_FILTERS } from "@/lib/bulk-sheet";
import { OpportunitiesSheet } from "./opportunities-sheet";

describe("OpportunitiesSheet loading", () => {
  it("keeps filters, columns and eight real row layouts without exposing data or actions", () => {
    const onOpen = vi.fn();
    const onNext = vi.fn();
    const { container } = render(<OpportunitiesSheet rows={[]} shown={[]} filters={NO_FILTERS}
      loading error={null} today="2026-10-20" onFilters={vi.fn()} onOpen={onOpen} onNext={onNext} />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    for (const heading of ["Score", "Opportunity", "Ticket", "Fee", "Chance", "Driver", "Stage", "Next action"]) {
      expect(screen.getByText(heading)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Buying" })).toBeTruthy();
    expect(screen.getByRole("searchbox")).toBeTruthy();
    expect(screen.queryByText("0 of 0 live")).toBeNull();
    expect(screen.queryByText("Nothing live right now.")).toBeNull();
    const rows = container.querySelectorAll("li");
    expect(rows.length).toBe(8);
    expect(rows[0].className).toContain("grid");
    fireEvent.click(rows[0]);
    expect(onOpen).not.toHaveBeenCalled();
    for (const button of container.querySelectorAll<HTMLButtonElement>("li button")) expect(button.disabled).toBe(true);
    expect(onNext).not.toHaveBeenCalled();
  });
});

describe("OpportunitiesSheet sort control", () => {
  it("offers a Sort menu only when a handler is given, and reports the chosen order", () => {
    const base = { rows: [], shown: [], filters: NO_FILTERS, loading: false, error: null, today: "2026-10-20", onFilters: vi.fn(), onOpen: vi.fn(), onNext: vi.fn() };
    const { rerender } = render(<OpportunitiesSheet {...base} />);
    expect(screen.queryByLabelText("Sort by")).toBeNull();
    const onSort = vi.fn();
    rerender(<OpportunitiesSheet {...base} sort="newest" onSort={onSort} />);
    const select = screen.getByLabelText("Sort by") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["newest", "score_desc", "score_asc", "due", "stage", "fee_desc"]);
    fireEvent.change(select, { target: { value: "score_asc" } });
    expect(onSort).toHaveBeenCalledWith("score_asc");
  });
});

describe("OpportunitiesSheet waiting-on", () => {
  const mk = (id: string, waiting_on: "us" | "them" | null) => ({
    key: id, id, kind: "demand" as const, side: "buyer" as const, title: `Row ${id}`, company: "Co", company_id: null, category: null,
    progress: "New" as const, tone: "new" as const, score: null, latest: null, next_action: null, next_due: null, owner: null, touched: null,
    waiting_on, waiting_since: waiting_on ? "2026-10-20" : null,
  });
  it("shows a badge per row, and a Waiting on filter that reports the choice", () => {
    const onFilters = vi.fn();
    const rows = [mk("a", "us"), mk("b", "them"), mk("c", null)];
    render(<OpportunitiesSheet rows={rows} shown={rows} filters={NO_FILTERS} loading={false} error={null} today="2026-10-20" onFilters={onFilters} onOpen={vi.fn()} onNext={vi.fn()} />);
    expect(document.querySelectorAll("[data-waiting-on=us]").length).toBe(1);
    expect(document.querySelectorAll("[data-waiting-on=them]").length).toBe(1);
    expect(screen.getByText(/On us/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Waiting on"), { target: { value: "us" } });
    expect(onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, waiting: "us" });
  });
  it("offers to clear a waiting-on filter", () => {
    render(<OpportunitiesSheet rows={[]} shown={[]} filters={{ ...NO_FILTERS, waiting: "us" }} loading={false} error={null} today="2026-10-20" onFilters={vi.fn()} onOpen={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });
});


describe("OpportunitiesSheet value and fee", () => {
  it("shows approximate value and the 10% fee, and a prompt to fill them in when unknown", () => {
    const mk = (id: string, value_eur: number | null, fee_eur: number | null) => ({
      key: id, id, kind: "supply" as const, side: "seller" as const, title: `Row ${id}`, company: "Co", company_id: null, category: null,
      progress: "New" as const, tone: "new" as const, score: null, latest: null, next_action: null, next_due: null, owner: null, touched: null, value_eur, fee_eur,
    });
    const rows = [mk("a", 480000, 48000), mk("b", null, null)];
    render(<OpportunitiesSheet rows={rows} shown={rows} filters={NO_FILTERS} loading={false} error={null} today="2026-10-20" onFilters={vi.fn()} onOpen={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByText("€480k")).toBeTruthy();
    expect(screen.getByText("€48k")).toBeTruthy();
    expect(screen.getByText("Add size")).toBeTruthy();
    expect(screen.getByText("Set fee")).toBeTruthy();
  });
});

describe("OpportunitiesSheet stage chips", () => {
  it("shows each stage with its count and filters on a click, a second click clearing it", () => {
    const mk = (id: string, progress: "New" | "Qualified") => ({
      key: id, id, kind: "demand" as const, side: "buyer" as const, title: `Row ${id}`, company: "Co", company_id: null, category: null,
      progress, tone: "new" as const, score: null, latest: null, next_action: null, next_due: null, owner: null, touched: null,
    });
    const rows = [mk("a", "New"), mk("b", "New"), mk("c", "Qualified")];
    const onFilters = vi.fn();
    const { rerender } = render(<OpportunitiesSheet rows={rows} shown={rows} filters={NO_FILTERS} loading={false} error={null} today="2026-10-20" stages={["New", "Qualified", "Sourcing"]} onFilters={onFilters} onOpen={vi.fn()} onNext={vi.fn()} />);
    const chips = screen.getByRole("group", { name: "Stage" }).querySelectorAll("button");
    expect(Array.from(chips).map((chip) => chip.textContent)).toEqual(["All3", "New2", "Qualified1", "Sourcing0"]);
    fireEvent.click(chips[1]);
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, progress: "New" });
    rerender(<OpportunitiesSheet rows={rows} shown={rows} filters={{ ...NO_FILTERS, progress: "New" }} loading={false} error={null} today="2026-10-20" stages={["New", "Qualified", "Sourcing"]} onFilters={onFilters} onOpen={vi.fn()} onNext={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^New/ }));
    expect(onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, progress: "all" });
  });
});
