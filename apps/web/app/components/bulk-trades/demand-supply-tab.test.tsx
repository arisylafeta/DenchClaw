// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DemandSupply, SupplyUnitView } from "@/lib/demand-supply-types";
import { SupplyTab } from "./demand-supply-tab";

const base: DemandSupply = {
  requirement: { pinned: [], unitsNeeded: 100000, kwhNeeded: null, buyerEurPerKwh: null, buyerEurPerUnit: 1, country: "PL" },
  groups: [], totalGroups: 0, smallGroups: 0, totalUnits: 0, considered: { marketplace: 0, trades: 0 }, hiddenCount: 0,
  shortlisted: [], shortlistGone: [], targetBuyEurPerKwh: 0.9, blocked: null, errors: [], fxNote: "Approximate FX 1 GBP ≈ €1.16",
};

describe("Matches tab", () => {
  it("shows no exchange-rate footnote, buy-at sentence or empty market section", () => {
    render(<SupplyTab supply={base} loading={false} error={null} onVerdict={async () => {}} busy={false} leads={[]} />);
    expect(screen.queryByText(/exchange rates/)).toBeNull();
    expect(screen.queryByText(/Buy at/)).toBeNull();
    expect(screen.queryByText(/No buyer price yet/)).toBeNull();
    expect(screen.queryByText(/In the market/)).toBeNull();
  });
});

const cell = (o: Partial<SupplyUnitView>): SupplyUnitView => ({
  key: "listing:1", source: "marketplace", alsoIn: [], title: "Voltaplex INR18650-26E", seller: "Luis Diaz", make: "Voltaplex", model: "INR18650-26E",
  format: "Cells", chemistry: null, location: null, country: "US", kwh: 0.0095, kwhEstimated: false, units: 600, price: 0.5, currency: "USD",
  currencyAssumed: false, eurPerKwh: 45, eurPerUnit: 0.43, marginPct: 0.57, spreadEur: null, cheapestRank: null, peers: 0, verdict: "exact",
  checks: [], photos: 0, soh: null, year: null, partNumber: null, href: "https://example.test", seen: null, ai: null, userVerdict: null, ...o,
});
const group = (item: SupplyUnitView, o: object = {}) => ({
  key: item.key, label: "Voltaplex INR18650-26E", verdict: item.verdict, units: item.units ?? 0, unitsKnown: item.units != null, sellers: ["Luis Diaz"], sources: ["marketplace" as const],
  eurPerKwh: item.eurPerKwh ? { min: item.eurPerKwh, max: item.eurPerKwh } : null, eurPerUnit: item.eurPerUnit ? { min: item.eurPerUnit, max: item.eurPerUnit } : null,
  bestMarginPct: item.marginPct, covers: { have: item.units ?? 0, need: 100000 }, small: false, checks: item.checks, items: [item], more: 0, fill: null,
  bySeller: [{ key: "luis", name: "Luis Diaz", country: "US", location: null, sources: ["marketplace" as const], units: item.units ?? 0, kwh: null,
    eurPerKwh: null, eurPerUnit: null, totalEur: null, pricedUnits: 0, verdict: item.verdict, withPhotos: 0, items: [item], more: 0 }], ...o,
});

describe("Matches rows for a per-cell buyer", () => {
  it("shows the seller price per cell, not per kWh", () => {
    const supply = { ...base, requirement: { ...base.requirement, priceUnit: "cell" }, groups: [group(cell({}))], totalGroups: 1 };
    render(<SupplyTab supply={supply} loading={false} error={null} onVerdict={async () => {}} busy={false} leads={[]} />);
    expect(screen.getByText("€0.43/cell")).toBeTruthy();
    expect(screen.queryByText(/\/kWh/)).toBeNull();
  });

  it("says the quantity is not stated instead of 1 / 100k", () => {
    const item = cell({ units: null, price: null, eurPerKwh: null, eurPerUnit: null, marginPct: null, verdict: "check",
      checks: [{ key: "quantity", label: "Quantity", state: "unknown", detail: "Quantity not stated" }, { key: "price", label: "Price", state: "unknown", detail: "No seller price" }] });
    const supply = { ...base, requirement: { ...base.requirement, priceUnit: "cell" }, groups: [group(item)], totalGroups: 1 };
    render(<SupplyTab supply={supply} loading={false} error={null} onVerdict={async () => {}} busy={false} leads={[]} />);
    expect(screen.getAllByText(/Quantity not stated/).length).toBeGreaterThan(0);
    expect(screen.getByText("No price")).toBeTruthy();
    expect(screen.queryByText(/100k/)).toBeNull();
    expect(screen.getByText("Check")).toBeTruthy();
  });
});
