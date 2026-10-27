import { describe, expect, it } from "vitest";
import { BOARD_STAGES, DEMAND_STAGES, LISTING_STAGES, SUPPLY_STAGES, stagesFor } from "./bulk-listing";
import { listingRow, STAGE_TONE, filterSheet, filtersFromRoute, routeFromFilters, NO_FILTERS, sheetOptions, sortSheet, sortRows, SHEET_SORTS, valueAndFee, formatEurCompact } from "./bulk-sheet";

const demand = (over = {}) => listingRow({
  id: "d1", kind: "demand", party: "H. Nolden", company_id: "c1", summary: "Complete packs",
  spec: { product_family: "Ioniq" }, context: {}, status: "open", activity_count: 0, score: null,
  latest_kind: null, latest_title: null, latest_at: null, observed_on: "2026-10-01", updated_at: "2026-10-02",
  next_action: null, next_due: null, furthest_stage: null, stage: "New", ...over,
});
const supply = (over = {}) => listingRow({
  id: "t1", kind: "supply", party: "Seller", company_id: null, summary: "eBS37 lot",
  spec: { trade_kind: "packs" }, context: {}, status: "open", activity_count: 0, score: null,
  latest_kind: null, latest_title: null, latest_at: null, observed_on: "2026-10-12", updated_at: "2026-10-12",
  next_action: "Call buyer", next_due: "2026-10-20", furthest_stage: "offered", stage: "Offered", ...over,
});

describe("sheet rows", () => {
  const listing = (over = {}) => listingRow({ id: "bt_1", kind: "supply", party: "Seller", company_id: null,
    summary: "Battery lot", spec: { is_trade: true }, context: {}, status: "open", score: null, activity_count: 0,
    latest_kind: null, latest_title: null, latest_at: null, observed_on: null, updated_at: "2026-10-21",
    next_action: null, next_due: null, furthest_stage: null, stage: "Offered", ...over });

  it("keeps mirrored lots as supply listings, and makes a trade only from accepted offers", () => {
    expect(listing()).toMatchObject({ id: "bt_1", key: "bt_1", kind: "supply", side: "seller", progress: "Offered" });
    for (const stage of ["contract_out", "signed", "invoiced", "paid", "complete"]) expect(listing({ furthest_stage: stage, stage: "Agreed" }))
      .toMatchObject({ progress: "Agreed", tone: "closing", is_trade: true });
    expect(listing({ furthest_stage: "negotiating", stage: "Negotiating" })).toMatchObject({ progress: "Negotiating", tone: "waiting", is_trade: false });
    expect(listing({ furthest_stage: "offered" }).is_trade).toBe(false);
    expect(listing({ kind: "demand", furthest_stage: "contract_out", stage: "Agreed" })).toMatchObject({ side: "buyer", progress: "Agreed" });
  });

  it("shows offer progress and preserves an explicit hold", () => {
    for (const stage of LISTING_STAGES)
      expect(listing({ stage }).progress).toBe(stage);
    expect(listing({ stage: "Offered", spec: { trade_stage: "On hold", hold_until: "2026-11-01" } }))
      .toMatchObject({ progress: "Offered", held: true, tone: "hold" });
    expect(listing({ stage: "Offered" })).toMatchObject({ held: false });
  });
  it("states only what the record says: a new demand has no development, next action or owner", () => {
    expect(demand()).toMatchObject({ progress: "New", latest: null, next_action: null, owner: null, side: "buyer" });
  });

  it("shows the latest recorded demand activity without inventing a trade", () => {
    expect(demand({ activity_count: 2, latest_kind: "outreach", latest_title: "Asked A", latest_at: "2026-10-05" }))
      .toMatchObject({ progress: "New", latest: { label: "Asked A", kind: "Outreach", at: "2026-10-05" } });
  });

});

describe("sheet filters", () => {
  const rows = [demand(), supply(), supply({ id: "t2", summary: "Cells lot", party: "Other", spec: { trade_kind: "cells" }, furthest_stage: "contract_out", stage: "Agreed", observed_on: "2026-10-11" })];

  it("filters by side, progress, company and category and searches across the visible text", () => {
    expect(filterSheet(rows, { ...NO_FILTERS, side: "buyer" }).map((row) => row.id)).toEqual(["d1"]);
    expect(filterSheet(rows, { ...NO_FILTERS, progress: "Agreed" }).map((row) => row.id)).toEqual(["t2"]);
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
    expect(routeFromFilters(filters)).toEqual({ query: "nolden", side: "buyer", progress: "New", company: null, category: null, waiting: null });
    expect(filtersFromRoute({ ...route, ...routeFromFilters(filters) })).toEqual(filters);
    expect(routeFromFilters(NO_FILTERS)).toEqual({ query: null, side: null, progress: null, company: null, category: null, waiting: null });
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

describe("ranking", () => {
  it("ranks one side by score, unscored last, and keeps newest-first in a mixed view", () => {
    const rows = [supply({ id: "a", score: null, updated_at: "2026-10-20" }), supply({ id: "b", score: 71, updated_at: "2026-10-01" }),
      supply({ id: "c", score: 93, updated_at: "2026-10-02" }), demand({ id: "d", score: 99 })];
    expect(filterSheet(rows, { ...NO_FILTERS, side: "seller" }).map((row) => row.id)).toEqual(["c", "b", "a"]);
    expect(filterSheet(rows, NO_FILTERS).map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("sortRows", () => {
  const row = (id: string, over = {}) => ({ ...demand({ id }), ...over });
  const rows = [
    row("a", { score: 40, next_due: "2026-10-30", progress: "Found", title: "A" }),
    row("b", { score: null, next_due: null, progress: "New", title: "B" }),
    row("c", { score: 90, next_due: "2026-10-25", progress: "Offered", title: "C" }),
    row("d", { score: 12, next_due: null, progress: "Qualified", title: "D" }),
  ];
  const ids = (sort: (typeof SHEET_SORTS)[number]) => sortRows(rows, sort).map((r) => r.id);

  it("keeps the incoming order for newest and never mutates its input", () => {
    expect(ids("newest")).toEqual(["a", "b", "c", "d"]);
    ids("score_desc");
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("sorts by score either way and always puts unscored rows last", () => {
    expect(ids("score_desc")).toEqual(["c", "a", "d", "b"]);
    expect(ids("score_asc")).toEqual(["d", "a", "c", "b"]);
  });
  it("sorts by soonest due date with undated rows last", () => {
    expect(ids("due")).toEqual(["c", "a", "d", "b"]);
  });
  it("sorts by furthest stage first, then score", () => {
    expect(ids("stage")).toEqual(["c", "a", "d", "b"]);
  });
});

describe("waiting-on", () => {
  const base = { id: "x", kind: "demand" as const, party: "P", company_id: null, summary: "s", spec: {}, context: {} as never, status: "open", score: null, activity_count: 0, latest_kind: null, latest_title: null, latest_at: null, observed_on: null, updated_at: "2026-10-01", next_action: null, next_due: null, furthest_stage: null, stage: "New" as const };
  const rows = [
    listingRow({ ...base, id: "a", waiting_on: "us", waiting_since: "2026-10-20" }),
    listingRow({ ...base, id: "b", waiting_on: "them" }),
    listingRow({ ...base, id: "c", waiting_on: null }),
    listingRow({ ...base, id: "d", waiting_on: "nonsense" }),
  ];
  it("keeps only us or them, and the date it started", () => {
    expect(rows.map((r) => r.waiting_on)).toEqual(["us", "them", null, null]);
    expect(rows[0].waiting_since).toBe("2026-10-20");
  });
  it("filters to what is waiting on us and round-trips through the URL", () => {
    expect(filterSheet(rows, { ...NO_FILTERS, waiting: "us" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterSheet(rows, { ...NO_FILTERS, waiting: "them" }).map((r) => r.id)).toEqual(["b"]);
    expect(routeFromFilters({ ...NO_FILTERS, waiting: "us" }).waiting).toBe("us");
    expect(filtersFromRoute({ query: null, side: null, progress: null, company: null, category: null, tab: null, waiting: "us" }).waiting).toBe("us");
    expect(filtersFromRoute({ query: null, side: null, progress: null, company: null, category: null, tab: null, waiting: "bogus" }).waiting).toBe("all");
  });
});


describe("value and fee", () => {
  it("takes supply value from spec.value_eur and a fixed 10% fee", () => {
    expect(supply({ spec: { value_eur: 480000 } })).toMatchObject({ value_eur: 480000, fee_eur: 48000 });
    expect(supply({ spec: { value_eur: "92575" } })).toMatchObject({ value_eur: 92575, fee_eur: 9258 });
  });
  it("derives demand value from the stored fee, which is 10% of it", () => {
    expect(demand({ spec: { fee_eur: 18060 } })).toMatchObject({ value_eur: 180600, fee_eur: 18060 });
  });
  it("leaves both null when there is no usable value", () => {
    for (const spec of [{}, { value_eur: 0 }, { value_eur: "n/a" }, { value_eur: -5 }]) expect(valueAndFee("supply", spec)).toEqual({ value_eur: null, fee_eur: null, fee_is_override: false });
    expect(valueAndFee("demand", {})).toEqual({ value_eur: null, fee_eur: null, fee_is_override: false });
  });
  it("uses a fee set on the listing over the 10% default, for either kind, even without a value", () => {
    expect(valueAndFee("supply", { value_eur: 480000 }, { fee_eur: 20000 })).toEqual({ value_eur: 480000, fee_eur: 20000, fee_is_override: true });
    expect(valueAndFee("demand", { fee_eur: 18060 }, { fee_eur: 9000.4 })).toEqual({ value_eur: 180600, fee_eur: 9000, fee_is_override: true });
    expect(valueAndFee("supply", {}, { fee_eur: 2500 })).toEqual({ value_eur: null, fee_eur: 2500, fee_is_override: true });
    expect(valueAndFee("supply", { value_eur: 1000 }, { fee_eur: 0 })).toMatchObject({ fee_eur: 0, fee_is_override: true });
    for (const fee_eur of [null, -1, "5000", Number.NaN]) expect(valueAndFee("supply", { value_eur: 1000 }, { fee_eur })).toEqual({ value_eur: 1000, fee_eur: 100, fee_is_override: false });
    expect(supply({ spec: { value_eur: 50000 }, context: { fee_eur: 7000 } })).toMatchObject({ value_eur: 50000, fee_eur: 7000, fee_is_override: true });
  });
  it("formats compactly", () => {
    expect([150, 12852, 480000, 3_460_000, 16_000_000, null].map(formatEurCompact)).toEqual(["€150", "€12.9k", "€480k", "€3.46M", "€16M", "—"]);
  });
  it("sorts by fee high to low with unknown fees last", () => {
    const rows = [supply({ id: "a", spec: { value_eur: 1000 } }), supply({ id: "b" }), demand({ id: "c", spec: { fee_eur: 900 } })];
    expect(sortRows(rows, "fee_desc").map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

describe("stages", () => {
  it("orders every stage once, and splits them by kind with the deal stages shared", () => {
    expect(LISTING_STAGES).toEqual(["New", "Qualified", "Sourcing", "Found", "Can't source", "Available", "Offered", "Negotiating", "Agreed", "Paid", "Delivered"]);
    expect(DEMAND_STAGES).toEqual(["New", "Qualified", "Sourcing", "Found", "Can't source", "Offered", "Negotiating", "Agreed", "Paid", "Delivered"]);
    expect(SUPPLY_STAGES).toEqual(["New", "Qualified", "Available", "Offered", "Negotiating", "Agreed", "Paid", "Delivered"]);
    expect(BOARD_STAGES).toEqual(["Offered", "Negotiating", "Agreed", "Paid", "Delivered"]);
    expect(stagesFor("demand")).toBe(DEMAND_STAGES);
    expect(stagesFor("supply")).toBe(SUPPLY_STAGES);
    for (const stage of [...DEMAND_STAGES, ...SUPPLY_STAGES]) expect(LISTING_STAGES).toContain(stage);
  });
  it("colours early stages quiet, working stages blue, deals amber then green, and Can't source as a warning", () => {
    expect(LISTING_STAGES.map((stage) => STAGE_TONE[stage])).toEqual(
      ["new", "new", "active", "active", "warning", "active", "waiting", "waiting", "closing", "closing", "closing"]);
    expect(demand({ stage: "Can't source" })).toMatchObject({ progress: "Can't source", tone: "warning" });
  });
});
