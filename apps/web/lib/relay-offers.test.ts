import { describe, expect, it } from "vitest";
import { offerLines } from "./relay-offers";

describe("offerLines", () => {
  it("states stage, what was offered, their terms and who the ball is with", () => {
    const text = offerLines([{ name: "STN Power Systems", stage: "offered", wants: "40 Toyota Proace 50 kWh packs", terms: { amount: 1150, currency: "GBP", unit: "pack", firmness: "firm" },
      last_touch_on: "2026-10-21", last_touch_via: "mail", waiting_on: "us", declined_reason: null }]);
    expect(text).toContain("STN Power Systems: Offered; offered: 40 Toyota Proace 50 kWh packs; their terms: 1150 GBP per pack firm");
    expect(text).toContain("last touch 2026-10-21 by mail; waiting on us");
    expect(text).toMatch(/do not name the seller/);
  });
  it("is empty with no offers, and copes with missing terms", () => {
    expect(offerLines([])).toBe("");
    expect(offerLines([{ name: null, stage: null, wants: null, terms: null, last_touch_on: null, last_touch_via: null, waiting_on: null, declined_reason: null }])).toContain("- Offer: no stage");
  });
});
