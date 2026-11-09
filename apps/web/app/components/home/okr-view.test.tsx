// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildOkr } from "@/lib/okr";
import { OkrBody, OkrSkeleton, formatValue } from "./okr-view";

const NOW = new Date("2026-11-09T16:00:00Z");
const data = buildOkr({
  now: NOW, platform: null, pulse: [], pulseCollectedAt: null, bulk: { listings: [], offers: [], touches: [] },
  progress: {}, errors: { platform: true, crm: false },
});

describe("OkrBody", () => {
  it("shows both objectives, the key results and the countdown to the quarter", () => {
    render(<OkrBody data={data} />);
    expect(screen.getByText("Starts in 22 days")).toBeTruthy();
    expect(screen.getByText("Grow the marketplace")).toBeTruthy();
    expect(screen.getByText("Make bulk trades repeatable")).toBeTruthy();
    expect(screen.getByText("Take from bulk trades")).toBeTruthy();
    expect(screen.getByText("Written SOP for bulk trades")).toBeTruthy();
    expect(screen.getByText("Paid marketplace deals")).toBeTruthy();
  });
  it("shows an unreadable source as no data, not zero, and says why", () => {
    render(<OkrBody data={data} />);
    expect(screen.getByText(/Could not read ReBattery just now/)).toBeTruthy();
    expect(screen.getAllByText("No data yet").length).toBeGreaterThan(0);
  });
  it("lists every KPI Sean asked for", () => {
    render(<OkrBody data={data} />);
    for (const label of ["New listings", "Web hits", "Offers made", "Conversions", "GMV", "Take", "New deals", "Active deals", "Deals closed", "Offers abandoned"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });
  it("formats money, counts and percents", () => {
    expect(formatValue(15000, "gbp")).toBe("£15k");
    expect(formatValue(1234, "count")).toBe("1,234");
    expect(formatValue(40, "percent")).toBe("40%");
  });
  it("puts web hits first in the marketplace section, ahead of its key result", () => {
    render(<OkrBody data={data} />);
    const section = screen.getByRole("region", { name: "Marketplace" });
    const hits = within(section).getByText("Web hits");
    const kr = within(section).getByText("Paid marketplace deals");
    expect(hits.compareDocumentPosition(kr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("collapses and reopens an objective, summarising its key results while closed", async () => {
    window.localStorage.clear();
    render(<OkrBody data={data} />);
    const header = screen.getByRole("button", { name: /Make bulk trades repeatable/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Deals closed")).toBeNull();
    expect(within(header).getByText(/Take from bulk trades: /)).toBeTruthy();
    expect(window.localStorage.getItem("okr-open-bulk")).toBe("0");
    await userEvent.click(header);
    expect(screen.getByText("Deals closed")).toBeTruthy();
  });

  it("shows a busy skeleton while loading", () => {
    render(<OkrSkeleton />);
    const status = screen.getByRole("status", { name: "Loading OKRs" });
    expect(status.getAttribute("aria-busy")).toBe("true");
  });
});
