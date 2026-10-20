import { describe, expect, it } from "vitest";
import type { Demand } from "./bulk-demand";
import { TEST_REGISTRY } from "./bulk-registry.fixture";
import type { TradeField } from "./bulk-trade-details";
import { demandFacts, readiness, stillNeeded, supplyFacts, visibleGroups } from "./listing-facts";

const field = (field_key: string, value: string, extra: Partial<TradeField> = {}): TradeField => ({
  field_key, value, status: "confirmed", visibility: "teaser", source_label: "Gmail · Sam", source_url: null, source_date: "2026-09-18", alternatives: [], ...extra,
});

describe("supplyFacts", () => {
  it("lists every registry fact for the kind, filled or missing, with its group and step", () => {
    const facts = supplyFacts(TEST_REGISTRY, "packs", [field("model", "FPT eBS37"), field("soh", "", { status: "missing" })]);
    expect(facts).toHaveLength(TEST_REGISTRY.fields.packs.length);
    expect(facts.find((f) => f.key === "model")).toMatchObject({ value: "FPT eBS37", status: "confirmed", group: "Product", neededFor: "Teaser" });
    expect(facts.find((f) => f.key === "soh")).toMatchObject({ value: null, status: "missing" });
    expect(facts.find((f) => f.key === "location")).toMatchObject({ value: null, status: "missing", group: "Logistics" });
  });

  it("keeps every claim of a conflict, the recorded one first", () => {
    const facts = supplyFacts(TEST_REGISTRY, "packs", [field("quantity", "161", { status: "conflict",
      alternatives: [{ value: "about 200", source_label: "Call", source_url: null, source_date: "2026-09-20" }] })]);
    const quantity = facts.find((f) => f.key === "quantity")!;
    expect(quantity.status).toBe("conflict");
    expect(quantity.claims.map((c) => c.value)).toEqual(["161", "about 200"]);
  });

  it("counts readiness and lists what is still needed by step", () => {
    const facts = supplyFacts(TEST_REGISTRY, "packs", [field("model", "A"), field("chemistry", "NMC")]);
    const teaser = readiness(facts).find((step) => step.step === "Teaser")!;
    expect(teaser.have).toBe(2);
    expect(teaser.total).toBeGreaterThan(2);
    expect(stillNeeded(facts)[0].step).toBe("Teaser");
    expect(stillNeeded(facts)[0].facts.some((f) => f.key === "model")).toBe(false);
  });

  it("shows only recorded facts in the sections, not every gap", () => {
    const sections = visibleGroups(supplyFacts(TEST_REGISTRY, "packs", [field("model", "A")]));
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ group: "Product" });
    expect(sections[0].facts.map((f) => f.key)).toEqual(["model"]);
  });
});

describe("demandFacts", () => {
  const demand = {
    kind: "request", basis: null, product_family: "Zoe packs", quantity: null, volume: 12, volume_unit: "packs", max_price: 20,
    price_currency: "EUR", price_unit: "kWh", needed_by: null, location: "Poland",
    spec: { chemistries: ["NMC"], kwh_min: 30, kwh_max: 60, min_soh: 70 },
  } as unknown as Demand;

  it("uses the same shape: core columns first, then the registry's buyer-ask attributes", () => {
    const facts = demandFacts(TEST_REGISTRY, demand);
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]));
    expect(byKey.product_family).toMatchObject({ value: "Zoe packs", group: "Product" });
    expect(byKey.quantity.value).toBe("12 packs");
    expect(byKey.capacity.value).toBe("30–60 kWh");
    expect(byKey.chemistries).toMatchObject({ label: "Chemistry", value: "NMC", group: "Product" });
    expect(byKey.min_soh.value).toBe("70%");
    expect(byKey.max_price.value).toBe("EUR 20/kWh");
    expect(byKey.location).toMatchObject({ label: "Deliver to", group: "Logistics" });
  });

  it("leaves the agent-written context out of Details", () => {
    const facts = demandFacts(TEST_REGISTRY, { ...demand, context: { application: "stationary_storage", min_usable_energy_kwh_per_pack: 42,
      next_action: "ignored here", missing_documents: ["x"], sources: [] } } as unknown as Demand);
    expect(facts.some((f) => /use|energy|next|missing|source|project/i.test(f.label))).toBe(false);
    expect(facts.some((f) => f.group === "Project")).toBe(false);
  });

  it("flags a missing timeline as a gap only for requests", () => {
    const gaps = (kind: "request" | "standing") => demandFacts(TEST_REGISTRY, { ...demand, kind } as Demand).filter((f) => f.critical && !f.value).map((f) => f.key);
    expect(gaps("request")).toContain("needed_by");
    expect(gaps("standing")).not.toContain("needed_by");
  });
});
