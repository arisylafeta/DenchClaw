// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CompanyContextNote } from "@/lib/crm-postgres/company-context";
import { CompanyContext } from "./company-context";

afterEach(cleanup);
const notes: CompanyContextNote[] = [
  { id: "old", company_id: "buyer", note: "Earlier price", category: "bid", source_kind: "email", source_ref: "demand:old", source_url: "https://example.com/evidence", observed_on: "2026-05-01", created_at: "2026-10-16" },
  { id: "new", company_id: "buyer", note: "New project", category: "project", source_kind: "call", source_ref: null, source_url: null, observed_on: "2026-10-06", created_at: "2026-10-16" },
];

describe("company context", () => {
  it("shows category chips and dated notes newest first on sheets", () => {
    render(<CompanyContext notes={notes} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "projectNew projectcall · 2026-10-06", "bidEarlier priceemail · 2026-05-01 · Source",
    ]);
    expect(screen.getByRole("link", { name: "Source" }).getAttribute("href")).toBe(notes[0].source_url);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("filters company notes by category and restores all without changing date order", () => {
    render(<CompanyContext notes={notes} filterable />);
    const filters = within(screen.getByRole("group", { name: "Filter context by category" }));
    fireEvent.click(filters.getByRole("button", { name: "bid" }));
    expect(screen.queryByText("New project")).toBeNull();
    expect(screen.getByText("Earlier price")).toBeTruthy();
    expect(filters.getByRole("button", { name: "bid" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(filters.getByRole("button", { name: "all" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps empty company state but omits empty sheet sections", () => {
    const view = render(<CompanyContext notes={[]} />);
    expect(screen.queryByRole("region")).toBeNull();
    view.rerender(<CompanyContext notes={[]} filterable />);
    expect(screen.getByText("No context notes yet.")).toBeTruthy();
  });
});
