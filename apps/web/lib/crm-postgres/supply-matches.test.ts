import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Demand } from "../bulk-demand";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ demand: [] as unknown[], saved: [] as unknown[], verdicts: new Map<string, unknown>(), feed: [] as unknown[] }));
vi.mock("../postgres", () => ({
  queryPg: vi.fn(async (sql: string) => (sql.includes("crm_bulk_listing_supply_feed") ? state.feed : sql.includes("supply_matches") ? state.saved : [])),
}));
vi.mock("./bulk-demand", () => ({ listDemand: vi.fn(async () => state.demand) }));
vi.mock("./bulk-listings", () => ({ getListing: vi.fn(async () => ({ id: "bts_1", kind: "supply", party: "WHS Energy", company_id: "co_whs", person_id: null })) }));
vi.mock("./demand-match-supply", async (orig) => ({ ...(await orig<typeof import("./demand-match-supply")>()), matchVerdicts: vi.fn(async () => state.verdicts) }));

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

describe("supplyMatches (REB-565/564)", () => {
  beforeEach(() => {
    state.feed = [{ id: "bts_1", kind: "supply", title: "680,000x Panasonic NCR2170M-4 Cells", seller: "WHS Energy", size: "680,000 cells", location: "Poland", seen: null, href: "/x", strength: null, reason: null }];
    state.saved = []; state.verdicts = new Map();
    state.demand = [
      demand({ id: "btd_fit", buyer: "Cell Buyer", wants: "Panasonic NCR2170M-4 cells", quantity: "100,000 cells", spec: { formats: ["Cells"] } }),
      demand({ id: "btd_own", buyer: "WHS Energy", company_id: "co_whs", wants: "Panasonic NCR2170M-4 cells", spec: { formats: ["Cells"] } }),
      demand({ id: "btd_closed", buyer: "Closed Co", status: "closed", wants: "Panasonic NCR2170M-4 cells", spec: { formats: ["Cells"] } }),
      demand({ id: "btd_packs", buyer: "Pack Buyer", wants: "Kona packs", spec: { formats: ["Packs"] } }),
    ];
  });

  it("lists live demand that fits, as Check when facts are missing, and leaves out own, closed and different-format demand", async () => {
    const { supplyMatches } = await import("./supply-matches");
    const r = await supplyMatches("bts_1");
    expect(r?.matches.map((m) => m.demandId)).toEqual(["btd_fit"]);
    expect(r?.matches[0]).toMatchObject({ buyer: "Cell Buyer", verdict: "check" });
  });

  it("hides a Not a fit demand and counts it, and floats a shortlisted one first", async () => {
    state.demand = [
      demand({ id: "btd_a", buyer: "A", wants: "Panasonic NCR2170M-4 cells", spec: { formats: ["Cells"] } }),
      demand({ id: "btd_b", buyer: "B", wants: "Panasonic NCR2170M-4 cells", spec: { formats: ["Cells"] } }),
      demand({ id: "btd_c", buyer: "C", wants: "Panasonic NCR2170M-4 cells", spec: { formats: ["Cells"] } }),
    ];
    state.verdicts = new Map([["demand:btd_a", { verdict: "not_a_fit" }], ["demand:btd_c", { verdict: "shortlist" }]]);
    const { supplyMatches } = await import("./supply-matches");
    const r = await supplyMatches("bts_1");
    expect(r?.notAFit).toBe(1);
    expect(r?.matches.map((m) => m.demandId)).toEqual(["btd_c", "btd_b"]);
    expect(r?.matches[0].userVerdict).toBe("shortlist");
  });

  it("keeps a saved pair visible as Check even when the scorer cannot confirm it", async () => {
    state.saved = [{ demand_id: "btd_packs", strength: "partial", reason: "Alex judged it close" }];
    const { supplyMatches } = await import("./supply-matches");
    const r = await supplyMatches("bts_1");
    const row = r?.matches.find((m) => m.demandId === "btd_packs");
    expect(row).toMatchObject({ verdict: "check", saved: { strength: "partial" } });
  });

  it("says why when the listing is not in the supply feed", async () => {
    state.feed = [];
    const { supplyMatches } = await import("./supply-matches");
    expect((await supplyMatches("bts_1"))?.blocked).toMatch(/not in the live supply feed/);
  });
});
