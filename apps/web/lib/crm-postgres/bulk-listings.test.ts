import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), demand: vi.fn() }));
vi.mock("../postgres", () => ({ queryPg: mocks.query }));
vi.mock("./bulk-demand", () => ({ getDemand: mocks.demand }));
import { listingView, listingFurthestStage } from "./bulk-listings";

describe("listing view", () => {
  beforeEach(() => vi.resetAllMocks());
  it("returns null without querying offers for an absent listing", async () => {
    mocks.query.mockResolvedValue([]);
    expect(await listingView("missing")).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it("reads counterpart offers with the same stage order as direct offers", async () => {
    mocks.query.mockResolvedValue([{ stage: "paid" }]);
    expect(await listingFurthestStage("demand")).toBe("paid");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("bulk_listing_id = $1 or counterpart_id = $1"),
      ["demand", ["candidate", "offered", "contract_out", "signed", "invoiced", "paid", "complete"]]);
  });
  it.each([
    [{ listing_title: "Spec title" }, { listing_title: "Context title" }, "Spec title"],
    [{}, { listing_title: "Context title" }, "Context title"],
    [{ listing_title: " " }, {}, "Summary"],
  ])("uses supply title fallbacks", async (spec, context, title) => {
    mocks.query.mockResolvedValueOnce([{ id: "supply", kind: "supply", summary: "Summary", spec, context }]).mockResolvedValueOnce([{ stage: "contract_out" }]).mockResolvedValueOnce([{ listing_stage: "Signed & Paid" }]);
    expect(await listingView("supply")).toMatchObject({ title, furthest_stage: "contract_out", is_trade: true, stage: "Signed & Paid" });
    expect(mocks.demand).not.toHaveBeenCalled();
  });
  it("attaches the existing demand and uses its headline rules", async () => {
    const demand = { wants: "4 Renault packs", buyer: "Buyer", product_family: null, context: {} };
    mocks.query.mockResolvedValueOnce([{ id: "demand", kind: "demand", summary: "Summary", spec: {}, context: {} }]).mockResolvedValueOnce([{ stage: "candidate" }]).mockResolvedValueOnce([{ listing_stage: "Matched" }]);
    mocks.demand.mockResolvedValue(demand);
    expect(await listingView("demand")).toMatchObject({ demand, title: "4 × Renault packs", is_trade: false });
  });
});
