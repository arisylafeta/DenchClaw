import { describe, expect, it } from "vitest";
import { listingRow, filterSheet, filtersFromRoute, routeFromFilters, NO_FILTERS, sheetOptions, sortSheet } from "./bulk-sheet";

const demand = (over = {}) => listingRow({
  id: "d1", kind: "demand", party: "H. Nolden", company_id: "c1", summary: "Complete packs",
  spec: { product_family: "Ioniq" }, context: {}, status: "open", activity_count: 0, score: null,
  latest_kind: null, latest_title: null, latest_at: null, observed_on: "2026-10-01", updated_at: "2026-10-02",
  next_action: null, next_due: null, furthest_stage: null, ...over,
});
const supply = (over = {}) => listingRow({
  id: "t1", kind: "supply", party: "Seller", company_id: null, summary: "eBS37 lot",
  spec: { trade_kind: "packs" }, context: {}, status: "open", activity_count: 0, score: null,
  latest_kind: null, latest_title: null, latest_at: null, observed_on: "2026-10-12", updated_at: "2026-10-12",
  next_action: "Call buyer", next_due: "2026-10-20", furthest_stage: "teaser_sent", ...over,
});

describe("sheet rows", () => {
  const listing = (over = {}) => listingRow({ id: "bt_1", kind: "supply", party: "Seller", company_id: null,
    summary: "Battery lot", spec: { is_trade: true }, context: {}, status: "open", score: null, activity_count: 0,
    latest_kind: null, latest_title: null, latest_at: null, observed_on: null, updated_at: "2026-10-21",
    next_action: null, next_due: null, furthest_stage: null, ...over });

  it("keeps mirrored lots as supply listings, and makes a trade only from accepted offers", () => {
    expect(listing()).toMatchObject({ id: "bt_1", key: "bt_1", kind: "supply", side: "seller", progress: "Offered" });
    for (const stage of ["loi", "won"]) expect(listing({ furthest_stage: stage }))
      .toMatchObject({ progress: "Trade", tone: "closing" });
    expect(listing({ kind: "demand", furthest_stage: "loi" })).toMatchObject({ side: "buyer", progress: "Trade" });
  });

  it("shows offer progress and preserves an explicit hold", () => {
    for (const [stage, label] of [["to_contact", "To contact"], ["teaser_sent", "Sent"], ["specs_nda", "Specs and NDA"], ["bid_in", "Bid in"]])
      expect(listing({ furthest_stage: stage }).progress).toBe(label);
    expect(listing({ furthest_stage: "bid_in", spec: { trade_stage: "On hold", hold_until: "2026-11-01" } }))
      .toMatchObject({ progress: "On hold", tone: "hold" });
    expect(listing({ kind: "demand", activity_count: 1 })).toMatchObject({ progress: "Being worked" });
  });
  it("states only what the record says: a new demand has no development, next action or owner", () => {
    expect(demand()).toMatchObject({ progress: "New", latest: null, next_action: null, owner: null, side: "buyer" });
  });

  it("shows the latest recorded demand activity without inventing a trade", () => {
    expect(demand({ activity_count: 2, latest_kind: "outreach", latest_title: "Asked A", latest_at: "2026-10-05" }))
      .toMatchObject({ progress: "Being worked", latest: { label: "Asked A", kind: "Outreach", at: "2026-10-05" } });
  });

});

describe("sheet filters", () => {
  const rows = [demand(), supply(), supply({ id: "t2", summary: "Cells lot", party: "Other", spec: { trade_kind: "cells" }, furthest_stage: "loi", observed_on: "2026-10-11" })];

  it("filters by side, progress, company and category and searches across the visible text", () => {
    expect(filterSheet(rows, { ...NO_FILTERS, side: "buyer" }).map((row) => row.id)).toEqual(["d1"]);
    expect(filterSheet(rows, { ...NO_FILTERS, progress: "Trade" }).map((row) => row.id)).toEqual(["t2"]);
    expect(filterSheet(rows, { ...NO_FILTERS, company: "Seller" }).map((row) => row.id)).toEqual(["t1"]);
    expect(filterSheet(rows, { ...NO_FILTERS, category: "cells" }).map((row) => row.id)).toEqual(["t2"]);
    expect(filterSheet(rows, { ...NO_FILTERS, query: "nolden" }).map((row) => row.id)).toEqual(["d1"]);
  });

  it("offers only values that exist, and sorts newest development first", () => {
    expect(sheetOptions(rows).category).toEqual(["cells", "Ioniq", "packs"]);
    expect(sortSheet(rows).map((row) => row.id)).toEqual(["t1", "t2", "d1"]);
  });
});

describe("sheet filters in the URL", () => {
  const route = { query: null, side: null, progress: null, company: null, category: null, tab: null };

  it("round-trips, keeping defaults out of the URL", () => {
    const filters = { ...NO_FILTERS, query: "nolden", side: "buyer" as const, progress: "New" };
    expect(routeFromFilters(filters)).toEqual({ query: "nolden", side: "buyer", progress: "New", company: null, category: null });
    expect(filtersFromRoute({ ...route, ...routeFromFilters(filters) })).toEqual(filters);
    expect(routeFromFilters(NO_FILTERS)).toEqual({ query: null, side: null, progress: null, company: null, category: null });
  });

  it("maps older demand and supply tab links to the matching side, and ignores an unknown side", () => {
    expect(filtersFromRoute({ ...route, tab: "demand" }).side).toBe("buyer");
    expect(filtersFromRoute({ ...route, tab: "supply" }).side).toBe("seller");
    expect(filtersFromRoute({ ...route, tab: "today" }).side).toBe("all");
    expect(filtersFromRoute({ ...route, side: "bogus" }).side).toBe("all");
    expect(filtersFromRoute({ ...route, side: "both" }).side).toBe("all"); // retired value in an old shared link
  });

  it("titles a supply listing from its stored listing_title (migrated lots keep it in context), as the detail does", () => {
    expect(supply({ context: { listing_title: "41 FPT eBS69 packs" }, summary: "raw summary" }).title).toBe("41 FPT eBS69 packs");
  });
});
