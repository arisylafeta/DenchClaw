import { describe, expect, it } from "vitest";
import { demandRow, filterSheet, filtersFromRoute, routeFromFilters, NO_FILTERS, sheetOptions, sortSheet, supplyRow, tradeRow } from "./bulk-sheet";

const demand = (over = {}) => demandRow({
  id: "d1", buyer: "H. Nolden", company_id: "c1", wants: "Complete packs", product_family: "Ioniq", activity_count: 0, linked_trades: 0,
  latest_kind: null, latest_title: null, latest_at: null, asked_on: "2026-10-01", updated_at: "2026-10-02", ...over,
});
const trade = (over = {}) => tradeRow({
  id: "t1", title: "eBS37 lot", origin: "supply", seller_name: "Seller", has_seller: true, has_buyer: false, trade_stage: "With buyers",
  trade_kind: "packs", next_step: "Call buyer", next_step_due: "2026-10-20", waiting_on: "them", waiting_since: "2026-10-10",
  owner_name: "Alex", last_touched: "2026-10-12", hold_until: null, updated_at: "2026-10-12", ...over,
});

describe("sheet rows", () => {
  it("states only what the record says: a new demand has no development, next action or owner", () => {
    expect(demand()).toMatchObject({ progress: "New", latest: null, next_action: null, owner: null, side: "buyer" });
  });

  it("a demand is 'Being worked' on recorded activity and 'On a trade' only on a real buyer link, never on a suggestion", () => {
    expect(demand({ activity_count: 2, latest_kind: "outreach", latest_title: "Asked A", latest_at: "2026-10-05" }))
      .toMatchObject({ progress: "Being worked", latest: { label: "Asked A", kind: "Outreach", at: "2026-10-05" } });
    expect(demand({ linked_trades: 1 })).toMatchObject({ progress: "On a trade" });
  });

  it("a trade starts on the side it began on, even once both parties are identified", () => {
    expect(trade({ has_buyer: true })).toMatchObject({ side: "seller" });
    expect(trade({ origin: "demand", has_seller: true, has_buyer: true })).toMatchObject({ side: "buyer" });
    expect(trade({ origin: "demand", has_seller: false })).toMatchObject({ side: "buyer" });
    expect(trade()).toMatchObject({ side: "seller", progress: "With buyers", next_action: "Call buyer", owner: "Alex", latest: { label: "Waiting on them" } });
  });

  it("an offer is a seller-led row labelled by how it arrived", () => {
    expect(supplyRow({ id: "s1", seller: "Seller Ltd", company_id: null, offers: "3 packs", trade_kind: "packs", source_kind: "email",
      source_label: null, observed_on: "2026-10-07", updated_at: "2026-10-07" })).toMatchObject({ side: "seller", latest: { label: "Offer by email" } });
  });

  it("keeps a demand and an offer as separate rows even when they share a company", () => {
    expect(new Set([demand().key, supplyRow({ id: "d1", seller: "H. Nolden", company_id: "c1", offers: "x", trade_kind: null,
      source_kind: null, source_label: null, observed_on: null, updated_at: "2026-10-01" }).key]).size).toBe(2);
  });
});

describe("sheet filters", () => {
  const rows = [demand(), trade(), trade({ id: "t2", title: "Cells lot", seller_name: "Other", trade_kind: "cells", trade_stage: "Closing", last_touched: "2026-10-11" })];

  it("filters by side, progress, company and category and searches across the visible text", () => {
    expect(filterSheet(rows, { ...NO_FILTERS, side: "buyer" }).map((row) => row.id)).toEqual(["d1"]);
    expect(filterSheet(rows, { ...NO_FILTERS, progress: "Closing" }).map((row) => row.id)).toEqual(["t2"]);
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
});
