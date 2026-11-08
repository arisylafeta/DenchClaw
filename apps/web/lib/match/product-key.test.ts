import { describe, expect, it } from "vitest";
import { buildProductKey, chemistriesIn, keyLine, partNumberIn, type FieldFact } from "./product-key";

// Field text shaped like the real values in `crm_bulk_listing_fields`, with seller and counterparty names
// removed. Every figure, unit and phrasing here is one a real listing used.
const fields = (values: Partial<Record<string, string>>, status: Record<string, string> = {}): FieldFact[] =>
  Object.entries(values).map(([field_key, value]) => ({ field_key, value: value ?? "", status: status[field_key] ?? "confirmed" }));

const key = (values: Partial<Record<string, string>>, status: Record<string, string> = {}) =>
  buildProductKey({ fields: fields(values, status), title: "Lot" });

describe("capacity text", () => {
  it("reads kWh per pack", () => {
    const line = key({ capacity: "44.5 kWh per pack" }).lines[0];
    expect(line.kwh).toBe(44.5);
    expect(line.format).toBe("Packs");
  });

  it("prefers the nominal figure over the usable one", () => {
    const line = key({ capacity: "37 kWh nominal (35 kWh usable) · 355 V · 104 Ah" }).lines[0];
    expect(line.kwh).toBe(37);
  });

  it("converts Wh and MWh to kWh", () => {
    expect(key({ capacity: "0.01188 kWh per cell" }).lines[0].kwh).toBe(0.01188);
    expect(key({ capacity: "379 Wh per cell" }).lines[0].kwh).toBe(0.379);
    expect(key({ capacity: "1.26 MWh per container" }).lines[0].kwh).toBe(1260);
    expect(key({ capacity: "1.26 MWh per container" }).lines[0].format).toBe("Systems");
  });

  it("drops a lot total and keeps the per-unit figure", () => {
    expect(key({ capacity: "1.75 MWh per container, 3.50 MWh total" }).lines[0].kwh).toBe(1750);
    expect(key({ capacity: "Approximately 22.7 MWh total" }).lines[0].kwh).toBeNull();
    expect(key({ capacity: "Approximately 22.7 MWh total" }).notes.join(" ")).toMatch(/lot total/);
  });

  it("multiplies Ah by V when no energy is stated", () => {
    expect(key({ capacity: "2V / 2,527Ah (C20) per cell" }).lines[0].kwh).toBeCloseTo(5.054, 4);
  });

  it("uses the typical mAh figure, not the minimum", () => {
    const line = key({ capacity: "Minimum 5,020 mAh; typical 5,220 mAh at 3.6 V nominal" }).lines[0];
    expect(line.kwh).toBeCloseTo(18.792 / 1000, 6);
  });

  it("leaves a range a range", () => {
    const line = key({ capacity: "55-84 kWh per pack" }).lines[0];
    expect(line.kwh).toBeNull();
    expect([line.kwhMin, line.kwhMax]).toEqual([55, 84]);
  });

  it("reads a mixed lot as several product lines, never first-number-wins", () => {
    const mixed = key({ capacity: "10 packs at 60 kWh, 14 packs at 44 kWh, 42 modules at 20.7 kWh (2,085 kWh total)" });
    expect(mixed.mixed).toBe(true);
    expect(mixed.lines.map((line) => [line.units, line.kwh, line.format])).toEqual([
      [10, 60, "Packs"], [14, 44, "Packs"], [42, 20.7, "Modules"],
    ]);
    expect(mixed.lines.reduce((sum, line) => sum + (line.units ?? 0), 0)).toBe(66);
  });

  it("counts a conflicting capacity as unknown but shows both values", () => {
    const conflict = key({ capacity: "75 kWh on the pack label (system records 100 kWh; OE 1686202980)" }, { capacity: "conflict" });
    expect(conflict.lines[0].kwh).toBe(75);
    expect(conflict.lines[0].unknown.kwh).toBe(true);
    expect(conflict.conflicts[0].field).toBe("capacity");
  });

  it("has no figure when capacity is only a current", () => {
    const line = key({ capacity: "100 Ah per cell" }).lines[0];
    expect(line.kwh).toBeNull();
    expect(line.unknown.kwh).toBe(true);
  });
});

describe("format and chemistry", () => {
  it("reads the format words a seller uses", () => {
    expect(key({ format: "Battery modules" }).format).toBe("Modules");
    expect(key({ format: "Cylindrical 18650" }).format).toBe("Cells");
    expect(key({ format: "Flooded deep-cycle cells" }).format).toBe("Cells");
    expect(key({ format: "Outdoor cabinet, 1,450 x 1,300 x 2,160 mm" }).format).toBe("Systems");
  });

  it("treats a conflicting format as unknown", () => {
    const conflict = key({ format: "Cylindrical 2170, cartons of 130 cells" }, { format: "conflict" });
    expect(conflict.format).toBe("Cells");
    expect(conflict.lines[0].unknown.format).toBe(true);
  });

  it("keeps a mixed-chemistry lot unknown for rule-outs", () => {
    const mixed = key({ chemistry: "BYD and NEC: LFP; Tesla Powerpack: NCA" });
    expect(mixed.chemistries).toEqual(["LFP", "NCA"]);
    expect(mixed.chemistry).toBeNull();
    expect(mixed.lines[0].unknown.chemistry).toBe(true);
  });

  it("reads one stated chemistry", () => {
    expect(key({ chemistry: "Li-ion NMC" }).chemistry).toBe("NMC");
    expect(key({ chemistry: "Believed NMC, not LFP" }).chemistry).toBe("NMC");
    expect(key({ chemistry: "NMC 622 (LG pouch cell, 16 cells per module, 2P8S)" }).chemistry).toBe("NMC");
  });

  it("never treats a missing chemistry as a conflict", () => {
    const missing = key({ chemistry: "" }, { chemistry: "missing" });
    expect(missing.chemistries).toEqual([]);
    expect(missing.chemistry).toBeNull();
  });

  it("reads chemistries in order and skips negations", () => {
    expect(chemistriesIn("LFP, not NMC")).toEqual(["LFP"]);
    expect(chemistriesIn("Li-ion")).toEqual(["Li-ion"]);
  });
});

describe("part numbers, make and platform", () => {
  it("reads a labelled part number", () => {
    expect(partNumberIn("Stellantis battery module MB6VAD, part no. 9831394980")).toBe("9831394980");
    expect(partNumberIn("Tesla Megapack, part 1462965-00")).toBe("1462965-00");
    expect(partNumberIn("Toyota Proace SU001B5189")).toBe("SU001B5189");
  });

  it("leaves an unlabelled model alone", () => {
    expect(partNumberIn("MG ZS EV")).toBeNull();
    expect(partNumberIn("Hyundai IONIQ Premium / Premium SE BEV")).toBeNull();
  });

  it("reads make and platform from the model text", () => {
    const line = key({ model: "VW Group MEB packs: ID.3, ID.4, Cupra Born, Enyaq and Q4 e-tron" }).lines[0];
    expect(line.platform).toBe("MEB");
    expect(line.makeGroup).toBe("VW Group");
    expect(key({ model: "Stellantis e-CMP / EMP2 50 kWh CATL" }).lines[0].platform).toBe("e-CMP");
    expect(key({ model: "Fiat 500e Low Range (E52 200km 60Ah 108s1p)" }).lines[0].make).toBe("Fiat");
  });

  it("reads a module series", () => {
    expect(key({ model: "FPT eBS 37 (NDE MY22) · 96s2p · 260 kg" }).lines[0].moduleSeries).toBe("96s2p");
  });
});

describe("units", () => {
  it("reads a stated count", () => {
    expect(key({ quantity: "120 modules" }).units).toBe(120);
    expect(key({ quantity: "Up to 85,000 cells, superseding 50,000" }).units).toBe(85000);
    expect(key({ quantity: "100,000 cells; smaller quantities possible" }).units).toBe(100000);
  });

  it("leaves a disputed count open", () => {
    const conflict = key({ quantity: "161 packs complete; 9 more incomplete" }, { quantity: "conflict" });
    expect(conflict.units).toBeNull();
    expect(conflict.notes.join(" ")).toMatch(/Quantity is disputed/);
  });

  it("uses the mixed-lot counts when the state has them", () => {
    expect(key({ capacity: "10 packs at 60 kWh, 14 packs at 44 kWh" }).units).toBe(24);
  });
});

describe("seller price", () => {
  it("accepts one firm amount, one currency and a unit", () => {
    const price = key({ seller_price: "£1,150 per pack" }).sellerPrice;
    expect(price).toMatchObject({ amount: 1150, currency: "GBP", per: "unit" });
    expect(price?.eurPerUnit).toBeCloseTo(1334, 0);
  });

  it("converts a per-kWh price and a per-MWh price", () => {
    expect(key({ seller_price: "EUR 40 per kWh" }).sellerPrice?.eurPerKwh).toBe(40);
    expect(key({ seller_price: "€28,000 per MWh" }).sellerPrice?.eurPerKwh).toBe(28);
  });

  it("rejects a guide, a target, an estimate or an offer", () => {
    for (const text of [
      "£1,495 per pack, buyer-facing guide price quoted to the trader; not a confirmed seller reserve",
      "Target €20-25/kWh net; target, not an accepted bid",
      "ReBattery indicative resale estimate GBP 15,000-30,000 per MWh",
      "Seeking an offer near £23.00 per kWh, not a firm asking price",
      "Around €29/kWh expected; offers invited",
    ]) {
      expect(key({ seller_price: text }).sellerPrice).toBeNull();
    }
  });

  it("rejects a disputed price even when it would parse", () => {
    const conflict = key({ seller_price: "USD 0.76 per cell, USD 516,800 total" }, { seller_price: "conflict" });
    expect(conflict.sellerPrice).toBeNull();
    expect(conflict.priceNote).toMatch(/disputed/);
  });

  it("rejects two amounts in different currencies", () => {
    expect(key({ seller_price: "€90,000 per container or USD 96,000 per container" }).sellerPrice).toBeNull();
  });

  it("rejects a price with no unit", () => {
    expect(key({ seller_price: "£28,000 for the complete 72-cell battery bank" }).sellerPrice).toBeNull();
  });
});

describe("the key line", () => {
  it("reads as one sentence", () => {
    const line = keyLine(key({ model: "Toyota Proace SU001B5189", capacity: "50 kWh per pack", chemistry: "NMC", quantity: "40 packs" }));
    expect(line).toBe("part SU001B5189 · Toyota · Proace SU001B5189 · 50 kWh · Packs · NMC · 40 units");
  });
});

// How much of the real field text the parser actually reads. These are 45 real values with seller and
// counterparty names removed; the test pins the coverage so a regression shows up as a number, not a vibe.
describe("coverage of real-shaped field text", () => {
  const CAPACITY = [
    "100 Ah per cell",
    "10 packs at 60 kWh, 14 packs at 44 kWh, 42 modules at 20.7 kWh (2,085 kWh total)",
    "1.26 MWh and 1.26 MVA per container; 2.52 MWh combined",
    "128 Ah per module; 6.6 kWh per module",
    "23.8 kWh per pack",
    "2503.2 kWh per pack",
    "2.6 Ah at 3.65 V, about 9.5 Wh (0.0095 kWh) per cell",
    "2V / 2,527Ah (C20) per cell",
    "37 kWh nominal (35 kWh usable) · 355 V · 104 Ah",
    "55-84 kWh per pack",
    "Minimum 5,020 mAh; typical 5,220 mAh at 3.6 V nominal",
    "75 kWh on the pack label (system records 100 kWh; OE 1686202980)",
    "0.01188 kWh per cell",
    "1.0048 kWh per cell (314Ah)",
    "103 Ah, approximately 379 Wh per cell; approximately 32.2 MWh at full 85,000-cell quantity",
    "11.52 kWh per module",
    "2.7 kWh, 14.6 V, 186 Ah per module",
    "50 kWh per pack",
    "233 kWh nominal, 221 kWh usable per cabinet; 832 Vdc (650-949 Vdc); about 1,165 kWh nominal for 5",
    "Approximately 22.7 MWh total",
  ];
  const MODEL = [
    "BAK N18650CL-29",
    "BYD C648 and C655 containers; NEC Grid Bank containers; Tesla Powerpack installations",
    "EPES233 outdoor liquid-cooled C&I energy storage cabinet; CE",
    "Fiat 500e Low Range (E52 200km 60Ah 108s1p)",
    "FPT eBS69",
    "Hyundai IONIQ Premium / Premium SE BEV",
    "KCL255103EN1",
    "LG Energy Solution EM048128P6BA",
    "MG ZS EV",
    "Panasonic NCR2170 series (NCR2170M-4)",
    "Stellantis battery module MB6VAD, part no. 9831394980",
    "Stellantis e-CMP / EMP2 50 kWh CATL",
    "Voltaplex INR18650-26E (label: INR18650-26E, 3.65 V, 2600 mAh)",
    "VW Group MEB packs: ID.3, ID.4, Cupra Born, Enyaq, Elroq and Q4 e-tron",
    "Tesla Megapack, part 1462965-00, serial TG121316003550",
    "Toyota Proace SU001B5189",
    "BMW 330e / 530e module",
    "Proterra (pack model not stated)",
  ];
  const FORMAT = ["Battery modules", "Cylindrical 18650", "Flooded deep-cycle cells", "Prismatic", "Cell", "Module", "Pouch; 78 cells/carton"];
  const CHEMISTRY = ["LFP", "Li-ion", "Li-ion NMC", "NCA", "NMC 622 (LG pouch cell E76A, 16 cells per module, 2P8S)", "Believed NMC, not LFP"];

  it("parses the capacity figure in most real capacity values", () => {
    let kwh = 0;
    let range = 0;
    const missed: string[] = [];
    for (const value of CAPACITY) {
      const parsed = key({ capacity: value }, { capacity: value.includes("system records") ? "conflict" : "confirmed" });
      if (parsed.lines.some((line) => line.kwh != null)) {
        kwh += 1;
      } else if (parsed.lines.some((line) => line.kwhMin != null)) {
        range += 1;
      } else {
        missed.push(value);
      }
    }
    console.log(`capacity: ${kwh}/${CAPACITY.length} kWh, ${range} range, missed ${missed.length}`);
    // The two that do not parse are honest misses: a bare current with no voltage, and a lot total only.
    expect(kwh + range).toBe(18);
    expect(missed).toEqual(["100 Ah per cell", "Approximately 22.7 MWh total"]);
  });

  it("parses format, chemistry, make and platform in most real values", () => {
    const formats = FORMAT.filter((value) => key({ format: value }).format != null).length;
    const chemistries = CHEMISTRY.filter((value) => key({ chemistry: value }).chemistries.length > 0).length;
    const makes = MODEL.filter((value) => key({ model: value }).lines[0].make != null).length;
    const platforms = MODEL.filter((value) => key({ model: value }).lines[0].platform != null).length;
    const parts = MODEL.filter((value) => key({ model: value }).lines[0].partNumber != null).length;
    console.log(`format ${formats}/${FORMAT.length}, chemistry ${chemistries}/${CHEMISTRY.length}, make ${makes}/${MODEL.length}, platform ${platforms}/${MODEL.length}, part ${parts}/${MODEL.length}`);
    expect(formats).toBe(FORMAT.length);
    expect(chemistries).toBe(CHEMISTRY.length);
    expect(makes).toBeGreaterThanOrEqual(11);
    expect(platforms).toBeGreaterThanOrEqual(3);
    expect(parts).toBeGreaterThanOrEqual(4);
  });
});
