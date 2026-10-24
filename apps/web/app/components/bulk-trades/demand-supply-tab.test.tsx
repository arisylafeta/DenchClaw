// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DemandSupply } from "@/lib/demand-supply-types";
import { SupplyTab } from "./demand-supply-tab";

const base: DemandSupply = {
  requirement: { pinned: [], unitsNeeded: 100000, kwhNeeded: null, buyerEurPerKwh: null, buyerEurPerUnit: null, country: "PL" },
  groups: [], totalGroups: 0, smallGroups: 0, totalUnits: 0, considered: { marketplace: 0, trades: 0 }, hiddenCount: 0,
  shortlisted: [], shortlistGone: [], targetBuyEurPerKwh: null, targetBuyEurPerUnit: null, buyerUnit: null, blocked: null, errors: [], fxNote: "Approximate FX",
};
const view = (supply: DemandSupply) => render(<SupplyTab supply={supply} loading={false} error={null} onVerdict={async () => {}} busy={false} leads={[]} />);

describe("In the market buy price", () => {
  it("shows the target per unit when the buyer prices per cell", () => {
    view({ ...base, requirement: { ...base.requirement, buyerEurPerUnit: 1 }, targetBuyEurPerUnit: 0.9, buyerUnit: "cell" });
    expect(screen.getByText(/€0\.90 per cell/)).toBeTruthy();
    expect(screen.getByText(/€1\.00 per cell/, { exact: false })).toBeTruthy();
    expect(screen.queryByText(/No buyer price yet/)).toBeNull();
  });
  it("still asks for a price when the buyer gave none", () => {
    view(base);
    expect(screen.getByText(/No buyer price yet/)).toBeTruthy();
  });
});
