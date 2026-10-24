// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DemandSupply } from "@/lib/demand-supply-types";
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
