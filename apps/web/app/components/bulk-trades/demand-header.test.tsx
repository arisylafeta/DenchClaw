// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Demand } from "@/lib/bulk-demand";
import { DemandHeader } from "./demand-header";
import { demandDescription } from "@/lib/bulk-demand-header";

const demand = {
  buyer: "Example buyer", kind: "request", wants: "4 example battery packs", spec: {}, context: {},
  context_notes: [], note: "Additional recorded context ".repeat(25), score: 47, tier: null, status: "open", priority: false,
  observed_on: "2026-10-01", asked_on: null, volume: null, volume_unit: null, quantity: null,
  max_price: null, price_currency: null, price_unit: null, needed_by: null, location: null,
  waiting: { who: "Example contact", since: "2026-10-01", subject: "Example reply" },
} as unknown as Demand;

describe("compact preview header", () => {
  it("shows a large waiting-on badge beside the name only when it is judged", () => {
    const { rerender } = render(<DemandHeader demand={demand} supply={null} actions={null} waiting={{ waiting_on: "them", waiting_since: "2026-10-20" }} />);
    expect(document.querySelector("[data-waiting-on=them]")).toHaveTextContent(/Waiting on them/);
    rerender(<DemandHeader demand={demand} supply={null} actions={null} waiting={{ waiting_on: null, waiting_since: null }} />);
    expect(document.querySelector("[data-waiting-on]")).toBeNull();
  });

  it("keeps the brief recoverable, metadata visible and inferred waiting absent", () => {
    render(<DemandHeader demand={demand} supply={null} actions={<button>Edit demand</button>} />);
    expect(screen.getByRole("heading", { name: "4 × example battery packs" })).toBeInTheDocument();
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByText("Approx. value")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for our reply/)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Score 47 out of 100" })).toBeInTheDocument();
    const brief = screen.getByText(/Example buyer is asking for/);
    const collapsed = brief.textContent!.length;
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(brief).toHaveTextContent(demandDescription(demand));
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(brief.textContent!.length).toBe(collapsed);
  });
});
