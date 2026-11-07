import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Demand } from "../bulk-demand";

vi.mock("server-only", () => ({}));
// Only the read queries are faked. `matchVerdicts` runs for real, so the verdict rows below are what its
// `distinct on (key) … order by occurred_at desc, id desc` returns: the latest row per key.
const state = vi.hoisted(() => ({ demand: [] as unknown[], activity: [] as unknown[] }));
vi.mock("../postgres", () => ({
  queryPg: vi.fn(async (sql: string) =>
    sql.includes("crm_bulk_listing_supply_feed") ? [{
      id: "bts_1", kind: "supply", title: "680,000x Panasonic NCR2170M-4 Cells", seller: "WHS Energy",
      size: "680,000 cells", location: "Poland", seen: null, href: "/x", strength: null, reason: null,
    }]
      : sql.includes("crm_bulk_listing_activity") ? state.activity
        : []),
}));
vi.mock("./bulk-demand", () => ({ listDemand: vi.fn(async () => state.demand) }));
vi.mock("./bulk-listings", () => ({ getListing: vi.fn(async () => ({ id: "bts_1", kind: "supply", party: "WHS Energy", company_id: "co_whs", person_id: null })) }));

function demand(o: Partial<Demand>): Demand {
  return {
    id: "btd_x", kind: "request", basis: null, buyer: "Buyer", company_id: null, person_id: null, contact: null, email: null,
    wants: "", quantity: null, location: null, note: null, needed_by: null, volume: null, volume_unit: null, max_price: null,
    price_currency: null, price_unit: null, spec: {}, source_kind: null, source_label: null, source_url: null, source_quote: null,
    observed_on: null, status: "open", product_family: null, fee_eur: null, price_basis: null, reputation: null, qualify_question: null,
    qualify_asked_on: null, qualify_entered_on: null, activity_count: 0, last_activity_at: null, moved_to: null, asked_on: null,
    score: null, expected_fee: null, has_stock: false, closed_reason: null, confirmed_on: null, updated_at: "", fits: [], trades: [],
    tier: null, waiting: null, priority: false, missing: [], context_notes: [], inventory_matches: [], context: {},
    ...o,
  } as Demand;
}

describe("supplyMatches latest verdict (REB-565)", () => {
  beforeEach(() => {
    state.demand = [demand({ id: "btd_a", buyer: "Cell Buyer", wants: "Panasonic NCR2170M-4 cells", quantity: "100,000 cells", spec: { formats: ["Cells"] } })];
  });

  it("hides a Not a fit demand, then shows it again once a later Clear is the latest verdict", async () => {
    const { supplyMatches } = await import("./supply-matches");
    state.activity = [{ key: "demand:btd_a", verdict: "not_a_fit", at: "2026-11-01 10:00:00+00", note: null, reason: "Only buys packs" }];
    const hidden = await supplyMatches("bts_1");
    expect(hidden?.matches).toEqual([]);
    expect(hidden?.notAFit).toBe(1);
    // A later Clear for the same key is now the latest row the query returns, so the demand is back on the list.
    state.activity = [{ key: "demand:btd_a", verdict: "clear", at: "2026-11-02 10:00:00+00", note: null, reason: null }];
    const shown = await supplyMatches("bts_1");
    expect(shown?.notAFit).toBe(0);
    expect(shown?.notAFitReasons).toEqual([]);
    expect(shown?.matches.map((m) => m.demandId)).toEqual(["btd_a"]);
  });
});
