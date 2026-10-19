import { describe, expect, it } from "vitest";
import { demandDescription, demandTitle, demandValue } from "./bulk-demand-header";
import type { Demand } from "./bulk-demand";

describe("demand header", () => {
  it("titles the ask, not the buyer", () => {
    expect(demandTitle({ wants: "4 Renault Zoe 41 kWh packs.", product_family: null, buyer: "R3" })).toBe("4 × Renault Zoe 41 kWh packs");
    expect(demandTitle({ wants: "41 kWh packs, any make", product_family: null, buyer: "R3" })).toBe("41 kWh packs, any make");
    expect(demandTitle({ wants: "x".repeat(200), product_family: null, buyer: "R3" }).length).toBeLessThanOrEqual(91);
  });
  it("values only matching units", () => {
    const base = { expected_fee: null, price_currency: "EUR", volume: 4 };
    expect(demandValue({ ...base, max_price: 500, price_unit: "pack", volume_unit: "packs" })?.text).toBe("≈ EUR 2,000");
    expect(demandValue({ ...base, max_price: 20, price_unit: "kWh", volume_unit: "packs" })).toBeNull();
  });
  it("caps the description at 200 words", () => {
    const demand = { buyer: "R3", kind: "request", wants: "4 packs", spec: {}, context: {}, context_notes: [{ note: "word ".repeat(150) }, { note: "more ".repeat(150) }], note: null, volume: null, volume_unit: null, quantity: null, max_price: null, price_currency: null, price_unit: null, needed_by: null, location: null } as unknown as Demand;
    const text = demandDescription(demand);
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(200);
    expect(text.startsWith("R3 is asking for: 4 packs.")).toBe(true);
  });
});
