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
    for (const heading of ["Score", "Opportunity", "Company", "Progress", "Latest", "Next action"]) {
      expect(screen.getByText(heading)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Buying" })).toBeTruthy();
    expect(screen.getByRole("searchbox")).toBeTruthy();
    expect(screen.queryByText("0 of 0 open")).toBeNull();
    expect(screen.queryByText("Nothing open right now.")).toBeNull();
    const rows = container.querySelectorAll("li");
    expect(rows.length).toBe(8);
    expect(rows[0].className).toContain("grid");
    fireEvent.click(rows[0]);
    expect(onOpen).not.toHaveBeenCalled();
    for (const button of container.querySelectorAll<HTMLButtonElement>("li button")) expect(button.disabled).toBe(true);
    expect(onNext).not.toHaveBeenCalled();
  });
});
