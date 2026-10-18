import { describe, expect, it } from "vitest";
import { scoreDemand } from "./bulk-demand-score";

describe("expected fee demand ranking", () => {
  it.each([
    [50000, "estimate", "active", "2026-10-15", 98],
    [10000, "buyer", "active", "2026-10-14", 88],
    [350, "estimate", "active", "2026-10-07", 43],
    [null, "estimate", "active", "2026-10-07", null],
  ] as const)("scores fee %s with %s budget and %s reputation", (feeEur, priceBasis, reputation, askedOn, score) => {
    expect(scoreDemand({ feeEur, priceBasis, reputation, askedOn }, "2026-10-16").score).toBe(score);
  });
  it("halves expected fees after thirty days and caps future asks at zero days", () => {
    const input = { feeEur: 1000, priceBasis: "buyer", reputation: "paid", askedOn: "2026-09-16" } as const;
    expect(scoreDemand(input, "2026-10-16").expectedFee).toBe(300);
    expect(scoreDemand({ ...input, askedOn: "2026-10-17" }, "2026-10-16")).toMatchObject({ expectedFee: 600, daysAgo: 0 });
  });
  it("keeps unknown fee unscored and zero fee scored cold", () => {
    expect(scoreDemand({ feeEur: null, priceBasis: null, reputation: null, askedOn: null })).toMatchObject({ score: null, band: null, expectedFee: null });
    expect(scoreDemand({ feeEur: 0, priceBasis: null, reputation: null, askedOn: null })).toMatchObject({ score: 0, band: "Cold", expectedFee: 0 });
  });
});
