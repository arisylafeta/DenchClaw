// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { buildOkr } from "@/lib/okr";
import { OkrBody, formatValue } from "./okr-view";

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
});
