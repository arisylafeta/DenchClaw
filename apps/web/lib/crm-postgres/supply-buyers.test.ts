import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ companies: [] as unknown[], verdicts: new Map<string, unknown>() }));
vi.mock("../postgres", () => ({
  queryPg: vi.fn(async (sql: string) => (sql.includes("from crm_companies") ? state.companies
    : sql.includes("from crm_people") ? [] : [])),
}));
vi.mock("./bulk-listings", () => ({
  getListing: vi.fn(async () => ({
    id: "bts_1", kind: "supply", company_id: "co_us", location: "Poland", summary: "",
    context: { listing_title: "100,000 NMC cells" }, spec: {},
  })),
}));
vi.mock("./demand-match-supply", async (orig) => ({ ...(await orig<typeof import("./demand-match-supply")>()), matchVerdicts: vi.fn(async () => state.verdicts) }));

const company = (o: Record<string, unknown>) => ({
  id: "co_a", name: "Alpha Batteries", stage: "Customer", tier: "A", basis: "stated",
  profile: { chemistries: ["NMC"], formats: ["Cells"] }, next_step: null, main_contact: null, ...o,
});

describe("supplyBuyers verdicts (Matches 2.0 phase 2)", () => {
  beforeEach(() => {
    state.verdicts = new Map();
    state.companies = [
      company({}),
      company({ id: "co_z", name: "Zeta Metals", stage: "Contacted", tier: null }),
      company({ id: "co_h", name: "Hidden Co" }),
      company({ id: "co_l", name: "Lead Research", stage: "Identified", tier: null, basis: "researched" }),
    ];
  });

  it("hides a company marked not a fit, counts it and keeps its reason", async () => {
    state.verdicts = new Map([["company:co_h", { verdict: "not_a_fit", reason: "Takes packs only" }]]);
    const { supplyBuyers } = await import("./supply-buyers");
    const r = await supplyBuyers("bts_1");
    expect(r?.ranked.map((b) => b.companyId)).toEqual(["co_a", "co_z"]);
    expect(r?.leads.map((b) => b.companyId)).toEqual(["co_l"]);
    expect(r?.notAFit).toBe(1);
    expect(r?.notAFitReasons).toEqual([{ company: "Hidden Co", reason: "Takes packs only" }]);
  });

  it("puts a shortlisted company first and reports its verdict", async () => {
    state.verdicts = new Map([["company:co_z", { verdict: "shortlist" }]]);
    const { supplyBuyers } = await import("./supply-buyers");
    const r = await supplyBuyers("bts_1");
    expect(r?.ranked.map((b) => b.companyId)).toEqual(["co_z", "co_a", "co_h"]);
    expect(r?.ranked[0].userVerdict).toBe("shortlist");
    expect(r?.ranked[1].userVerdict).toBeNull();
  });
});
