import { describe, expect, it } from "vitest";
import { askInstruction, askLabel, buildChecklist, dismantlerInstruction, missingInstruction, type ChecklistListing } from "./relay-checklist";

const now = new Date("2026-11-07T12:00:00Z");
const supply: ChecklistListing = {
  id: "btd_s", kind: "supply", title: "30x Nissan Leaf packs", quantity: "30 packs", location: "Leeds, UK", clear_by: null,
  context: { listing_title: "30x Nissan Leaf 40kWh", intake_ticks: { split: true } }, spec: {},
  volume: null, volume_unit: null, max_price: null, price_currency: null, price_unit: null, needed_by: null, product_family: null,
};

describe("buildChecklist for a seller", () => {
  const c = buildChecklist(supply, [
    { field_key: "model", value: "Nissan Leaf", status: "confirmed" },
    { field_key: "seller_price", value: null, status: "missing" },
    { field_key: "clear_by", value: "Gone by 30 Nov", status: "confirmed" },
    { field_key: "soh", value: "18 of 30 read, 81-92%", status: "unverified" },
  ], [
    { file_name: "Test report.pdf", title: null, doc_type: null, source_date: "2024-03-10", created_at: null },
    { file_name: "label1.jpg", title: null, doc_type: null, source_date: null, created_at: null },
    { file_name: "label2.jpg", title: null, doc_type: null, source_date: null, created_at: null },
  ], now);

  it("ticks what the CRM holds and leaves the price missing", () => {
    expect(c.required.map((i) => [i.key, i.have])).toEqual([["what", true], ["how_many", true], ["price", false], ["when", true], ["where", true], ["health", true]]);
    expect(c.required[0].warn).toBe("kWh not stated");
  });
  it("dates the test report, flags it as old and counts photos", () => {
    const test = c.helpful.find((i) => i.key === "test_report")!;
    expect(test.value).toBe("Dated March 2024");
    expect(test.warn).toBe("over a year old");
    expect(c.helpful.find((i) => i.key === "photos")!.value).toBe("2 on file");
  });
  it("uses hand ticks only for facts the CRM has no field for", () => {
    expect(c.helpful.filter((i) => i.manual).map((i) => [i.key, i.have])).toEqual([["per_pack_health", false], ["split", true], ["owner", false]]);
  });
  it("flags facts nobody has confirmed", () => {
    expect(c.required.find((i) => i.key === "health")!.warn).toBe("unverified");
  });
  it("turns the gaps into one instruction for Relay AI, including what to confirm", () => {
    const text = missingInstruction(c)!;
    expect(text).toContain("Ask them for, or to confirm, what we still need: price, what (kWh not stated), health (unverified).");
    expect(text).toContain("test report (over a year old)");
    expect(text).toContain("health per pack with tag");
    expect(text).not.toContain("whole lot or split");
  });
});

describe("buildChecklist for a buyer", () => {
  it("reads the demand's own columns", () => {
    const c = buildChecklist({ ...supply, id: "btd_d", kind: "demand", quantity: null, location: "France", context: {}, spec: { min_soh: 80 },
      volume: 15, volume_unit: "packs", max_price: 50, price_currency: "EUR", price_unit: null, needed_by: "2026-12-31", product_family: "Renault Zoe packs" }, [], [], now);
    expect(c.required.map((i) => i.value)).toEqual(["Renault Zoe packs", "15 packs", "Max EUR 50", "2026-12-31", "France"]);
    expect(c.required[2].warn).toBe("unit not stated");
    expect(c.helpful[0].value).toBe("80%");
  });
  it("never ticks a buyer's What from the title alone", () => {
    const c = buildChecklist({ ...supply, kind: "demand", product_family: null, spec: {} }, [], [], now);
    expect(c.required[0].have).toBe(false);
  });
  it("needs nothing added when every box is ticked", () => {
    const full = buildChecklist({ ...supply, context: { intake_ticks: { per_pack_health: true, split: true, owner: true } } }, [
      { field_key: "model", value: "Leaf", status: "confirmed" }, { field_key: "capacity", value: "40 kWh", status: "confirmed" },
      { field_key: "seller_price", value: "€1,900 a pack", status: "confirmed" }, { field_key: "clear_by", value: "30 Nov", status: "confirmed" },
      { field_key: "soh", value: "80%+", status: "confirmed" },
    ], [{ file_name: "report.pdf", title: "Test report", doc_type: null, source_date: "2026-11-01", created_at: null }, { file_name: "a.jpg", title: null, doc_type: null, source_date: null, created_at: null }], now);
    expect(missingInstruction(full)).toBeNull();
  });
});

describe("evidence that does not count", () => {
  it("a stated 'untested' answers Health but is not a test report, and a readout photo is a photo", () => {
    const c = buildChecklist(supply, [{ field_key: "test_data", value: "Untested", status: "confirmed" }],
      [{ file_name: "soh_readout.jpg", title: null, doc_type: null, source_date: "2026-11-01", created_at: null }], now);
    expect(c.required.find((i) => i.key === "health")!.have).toBe(true);
    expect(c.helpful.find((i) => i.key === "test_report")!.have).toBe(false);
    expect(c.helpful.find((i) => i.key === "photos")!.value).toBe("1 on file");
  });
  it("shows when two sources disagree", () => {
    const c = buildChecklist({ ...supply, quantity: null }, [{ field_key: "quantity", value: "680,000 cells", status: "conflict" }], [], now);
    expect(c.required.find((i) => i.key === "how_many")!.warn).toBe("sources disagree");
  });
});

describe("askInstruction", () => {
  const bare = buildChecklist({ ...supply, quantity: "30 packs", location: null, context: {} }, [{ field_key: "model", value: "Nissan Leaf", status: "confirmed" }], [], now);
  it("writes the first ask while we have next to nothing", () => {
    const text = askInstruction(bare)!;
    expect(text).toMatch(/^First reply from the intake guide/);
    expect(text).toContain("stock list, label photos");
    expect(text).toContain("price, when, where, health");
    expect(text).toContain("Never offer a price");
  });
  it("asks only for the gaps once most facts are in", () => {
    const most = buildChecklist(supply, [
      { field_key: "model", value: "Leaf", status: "confirmed" }, { field_key: "capacity", value: "40 kWh", status: "confirmed" },
      { field_key: "clear_by", value: "30 Nov", status: "confirmed" }, { field_key: "soh", value: "80%+", status: "confirmed" },
    ], [], now);
    const text = askInstruction(most)!;
    expect(text).toMatch(/^Second reply from the intake guide: thank them for what they sent\. Ask them for, or to confirm, what we still need: price, and say why it matters\./);
    expect(text).not.toContain("Keep the rest of the email");
    expect(askLabel(most)).toMatch(/^Draft the ask: price/);
  });
  it("switches from the first ask to the gaps at three facts, counting doubtful ones", () => {
    const three = buildChecklist(supply, [{ field_key: "model", value: "Leaf", status: "unverified" }], [], now);  // what, how many, where
    expect(three.required.filter((i) => i.have).length).toBe(3);
    expect(askInstruction(three)).toMatch(/^Second reply/);
    expect(askInstruction(three)).toContain("what (kWh not stated)");
  });
  it("asks a buyer for their spec sheet first", () => {
    const buyer = buildChecklist({ ...supply, kind: "demand", quantity: null, location: null, context: {}, product_family: "Zoe packs" }, [], [], now);
    expect(askInstruction(buyer)).toContain("their spec sheet");
    expect(askLabel(buyer)).toBe("Draft the ask: first ask, everything they have");
  });
});

describe("dismantlerInstruction", () => {
  it("points each dismantler to the channel they have, and never prices", () => {
    expect(dismantlerInstruction("marketplace")).toContain("marketplace account");
    expect(dismantlerInstruction("stock_only")).toContain("stock list they send us");
    expect(dismantlerInstruction("none")).toContain("set them up on the ReBattery marketplace");
    for (const p of ["marketplace", "stock_only", "none"] as const) expect(dismantlerInstruction(p)).toContain("Never offer a price");
  });
});
