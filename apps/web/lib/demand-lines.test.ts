import { describe, expect, it } from "vitest";
import { lineFor, needText, parseLines, type DemandLine } from "./demand-lines";

const L = (id: string, label: string, products: string[], kwh: number[], qty_min: number, qty_max: number | null = null): DemandLine => ({ id, label, products, kwh, qty_min, qty_max });
const LINES = [
  L("meb82", "VW MEB 82 kWh", ["meb"], [82], 10, 20),
  L("ioniq5", "Ioniq 5 77.4 kWh", ["ioniq 5"], [77.4], 8),
  L("zoe", "Renault Zoe 41 kWh", ["zoe"], [41], 4),
  L("hyb", "Stellantis hybrid", ["stellantis"], [12.44, 13.2], 48),
  L("stlam", "STLA-M 81.6 / 105 kWh", ["stla-m"], [81.6, 105], 22),
];
const c = (make: string, model: string, kwh: number | null, kwhEstimated = false) => ({ make, model, title: `${make} ${model}`, kwh, kwhEstimated });

describe("parseLines", () => {
  it("keeps good lines, tidies words and makes ids", () => {
    const out = parseLines([{ label: "  VW  MEB 82 kWh ", products: ["MEB", "meb", " ID.4 "], kwh: [82, "82"], qty_min: "10", qty_max: 20 }]);
    expect("value" in out && out.value[0]).toMatchObject({ label: "VW MEB 82 kWh", products: ["meb", "id.4"], kwh: [82], qty_min: 10, qty_max: 20 });
    expect("value" in out && out.value[0].id).toMatch(/^[a-z0-9]{4,24}$/);
  });

  it("drops a range that is one number and keeps a given id", () => {
    const out = parseLines([{ id: "zoe41", label: "Zoe", qty_min: 4, qty_max: 4 }]);
    expect("value" in out && out.value[0]).toEqual({ id: "zoe41", label: "Zoe", products: [], kwh: [], qty_min: 4, qty_max: null });
  });

  it("refuses what makes no sense", () => {
    for (const bad of [{}, [{ label: "", qty_min: 1 }], [{ label: "x", qty_min: 0 }], [{ label: "x", qty_min: 5, qty_max: 2 }], [{ label: "x", qty_min: 1, kwh: [-3] }], Array.from({ length: 13 }, () => ({ label: "x", qty_min: 1 }))]) {
      expect("error" in parseLines(bad)).toBe(true);
    }
  });

  it("writes the need", () => {
    expect(needText({ qty_min: 10, qty_max: 20 })).toBe("10–20");
    expect(needText({ qty_min: 1200, qty_max: null })).toBe("1,200");
  });
});

describe("lineFor", () => {
  it("places a pack by platform and capacity", () => {
    expect(lineFor(c("Volkswagen", "ID.4", 82), LINES)).toMatchObject({ line: { id: "meb82" }, state: "fits" });
    expect(lineFor(c("Audi", "Q4 e-tron", 82), LINES)?.line.id).toBe("meb82");
    expect(lineFor(c("Hyundai", "Ioniq 5", 77.4), LINES)?.line.id).toBe("ioniq5");
  });

  it("keeps apart a pack of the same platform but another capacity", () => {
    expect(lineFor(c("Cupra", "Born", 62), LINES)).toBeNull();
    expect(lineFor(c("Peugeot", "3008 E-210", 73), LINES)).toBeNull();
  });

  it("allows 5% on capacity, and prefers the model to the make", () => {
    expect(lineFor(c("Peugeot", "5008", 80.1), LINES)?.line.id).toBe("stlam");
    expect(lineFor(c("Opel", "Grandland X", 13.2), LINES)).toMatchObject({ line: { id: "hyb" }, state: "fits" });
  });

  it("is only close when the capacity is not stated or only estimated", () => {
    expect(lineFor(c("Skoda", "Enyaq iV", null), LINES)).toEqual({ line: LINES[0], state: "close", why: "kWh not stated" });
    expect(lineFor(c("Volkswagen", "ID.4", 82, true), LINES)?.state).toBe("close");
  });

  it("takes any capacity when the line names none", () => {
    expect(lineFor(c("Renault", "Zoe", 52), [L("zoe", "Zoe", ["zoe"], [], 4)])?.state).toBe("fits");
  });
});
