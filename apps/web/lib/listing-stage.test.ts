import { describe, expect, it } from "vitest";
import { listingStage, LISTING_STAGE_ORDER } from "./listing-stage";

describe("listing stage", () => {
  it("ignores absent and unsuccessful stages", () => {
    expect(listingStage([])).toEqual({ furthest_stage: null, is_trade: false });
    expect(listingStage([null, "declined", "lost"])).toEqual({ furthest_stage: null, is_trade: false });
  });
  it.each([...LISTING_STAGE_ORDER])("orders %s independently of input order", (stage) => {
    const prefix = LISTING_STAGE_ORDER.slice(0, LISTING_STAGE_ORDER.indexOf(stage) + 1);
    expect(listingStage([stage, ...prefix, "declined", "lost"])).toEqual({
      furthest_stage: stage, is_trade: ["contract_out", "signed", "invoiced", "paid", "complete"].includes(stage),
    });
  });
});
