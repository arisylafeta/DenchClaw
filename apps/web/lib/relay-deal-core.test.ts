import { describe, expect, it } from "vitest";
import { askedFields, dealFromCard, dealTitle, workingDaysAfter } from "./relay-deal-core";
import { routeLead } from "./relay-front-door";
import type { LeadData } from "./relay-lead-core";

function lead(facts: Record<string, string>, over: Partial<LeadData> = {}): LeadData {
  const list = Object.entries(facts).map(([key, value]) => ({ key, value }));
  return {
    side: "seller", unit: "packs", role: "owner", firstName: "Dana", summary: "Dana has used Leaf packs.", facts: list, asked: [], other: [],
    have: list.map((f) => f.key), sent: null, deal: false, email: { subject: "", text: "", at: "2026-11-10T09:00:00Z", files: [] },
    route: routeLead({ facts: list, recycling: null }), recycling: null, ...over,
  };
}
const who = { name: "Dana Field", email: "dana@acme.example" };
const sentAt = new Date("2026-11-12T10:00:00Z"); // a Thursday

describe("a deal from a lead card", () => {
  it("titles it by naming.md: count, product, unit; no price", () => {
    expect(dealTitle(lead({ what: "Nissan Leaf 40kWh", how_many: "20 packs" }))).toBe("20x Nissan Leaf 40kWh Packs");
    expect(dealTitle(lead({ what: "LFP modules", how_many: "2 MWh" }, { unit: "modules" }))).toBe("2MWh LFP modules");
    expect(dealTitle(lead({ what: "Leaf packs €2,000 each", how_many: "10+ packs" }))).toBe("10+ Leaf packs");
  });

  it("chases two working days on", () => {
    expect(workingDaysAfter(sentAt, 2)).toBe("2026-11-16");
  });

  it("writes the seller's card to fields, the clear-by date to clear_by, and owner Alex", () => {
    const facts = lead({ what: "Nissan Leaf 40kWh", how_many: "20 packs", price: "€2,000 per pack", where: "Leeds", when: "by 30 Nov" });
    const d = dealFromCard({ lead: facts, who, route: facts.route!, asked: ["health", "docs"], sentAt });
    expect(d).toMatchObject({ kind: "supply", quantity: "20 packs", location: "Leeds", clear_by: "2026-11-30", next_due: "2026-11-16" });
    expect(d.context).toMatchObject({ owner: "Alex", size: "bulk" });
    expect(d.spec).toMatchObject({ trade_kind: "packs", value_eur: 40000 });
    expect(d.fields.find((f) => f.key === "seller_price")).toEqual({ key: "seller_price", value: "€2,000 per pack", visibility: "never" });
    expect(d.next_action).toBe("Chase Dana for the first ask: health.");
  });

  it("stores a buyer's figures in the demand shape only when they are exact", () => {
    const buyer = lead({ what: "Kona 64kWh packs", how_many: "30 packs", price: "€3,500 per pack" }, { side: "buyer" });
    const d = dealFromCard({ lead: buyer, who, route: buyer.route!, asked: ["when", "where"], sentAt });
    expect(d.spec).toMatchObject({ intent: "request", product_family: "Kona 64kWh packs", volume: 30, volume_unit: "packs", max_price: 3500, price_currency: "EUR", price_unit: "pack" });
    expect(d.clear_by).toBeNull();
    const range = dealFromCard({ lead: lead({ what: "LFP cells", how_many: "10-20 packs" }, { side: "buyer" }), who, route: buyer.route!, asked: [], sentAt });
    expect(range.spec).not.toHaveProperty("volume");
  });

  it("maps what the reply asked to the checklist's field rows", () => {
    expect(askedFields("supply", ["price", "health", "when", "docs", "owner"])).toEqual(["seller_price", "soh", "clear_by"]);
    expect(askedFields("demand", ["price", "min_health", "where"])).toEqual(["max_price", "min_soh", "location"]);
  });
});
