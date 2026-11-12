import { describe, expect, it } from "vitest";
import { broaderKeysFor, kwhKeyText, makeKey, packFamilyFor, productFactsFromKey, productKeyFor, productKeyLevel, productKeysFor } from "./product-key-for";

describe("productKeyFor", () => {
  it("uses an OEM part number above every other fact", () => {
    expect(productKeyFor({ partNumbers: ["SU001-B5189"], make: "Toyota", model: "Prius", kwh: 8.8 })).toBe("part:SU001B5189");
    // Letter O and digit 0 fold together, as stock lot splitting already does.
    expect(productKeyFor({ partNumbers: ["37501AO050"] })).toBe("part:37501A0050");
    expect(productKeyLevel(productKeyFor({ partNumbers: ["SU001B5189"] }))).toBe("part");
  });

  it("uses a curated battery graph pack key as a pack family", () => {
    expect(productKeyFor({ packKey: "fam:kia-niro-67-5", make: "Kia", model: "Niro", kwh: 64.8 }))
      .toBe("pack:kia-niro-67-5");
    // Research keys cover a whole OEM family, so they are not a pack identity.
    expect(productKeyFor({ packKey: "res:notes-1", chemistry: "NMC", format: "packs" })).toBe("broad:nmc-packs");
  });

  it("maps the vehicles of a reviewed pack family to one key", () => {
    const corsa = productKeyFor({ make: "Vauxhall", model: "Corsa-e", format: "packs", chemistry: "NMC", kwh: 50 });
    const pug = productKeyFor({ make: "Peugeot", model: "e-208", format: "packs", chemistry: "NMC", kwh: 50 });
    expect(corsa).toBe("pack:stellantis-ecmp-50kwh");
    expect(pug).toBe(corsa);
    // A part number in the family also counts as the family pack, but the part itself is the specific key.
    expect(broaderKeysFor({ partNumbers: ["37501-Q4052"] })).toContain("pack:kia-niro-64kwh");
  });

  it("falls to make + model + one kWh figure", () => {
    expect(productKeyFor({ make: "Polestar", model: "2", chemistry: "NMC", format: "packs", kwh: 78 }))
      .toBe("model:polestar-2-78kwh");
    expect(productKeyFor({ make: "vw", model: "ID.3", kwh: 77 })).toBe("pack:vw-meb-77kwh");
    expect(kwhKeyText(77)).toBe("77");
    expect(kwhKeyText(77.04)).toBe("77");
  });

  it("does not guess a model key from a kWh range", () => {
    const key = productKeyFor({ make: "Hyundai", model: "Ioniq 5", kwhMin: 50, kwhMax: 60, format: "Packs" });
    expect(key).toBe("broad:any-packs");
    // An equal range is one figure, so it still names the pack.
    expect(productKeyFor({ make: "Nissan", model: "Leaf", kwhMin: 40, kwhMax: 40 })).toBe("pack:nissan-leaf-40kwh");
  });

  it("uses cell maker + cell model for cells", () => {
    expect(productKeyFor({ cellMaker: "Samsung SDI", model: "INR21700-50E", format: "cells", chemistry: "NMC" }))
      .toBe("cell:samsung-sdi-inr21700-50e");
  });

  it("falls to chemistry + format, and to a plain battery bucket when neither is stated", () => {
    expect(productKeyFor({ chemistry: "LFP", format: "Packs" })).toBe("broad:lfp-packs");
    expect(productKeyFor({ chemistry: "LiFePO4" })).toBe("broad:lfp-batteries");
    expect(productKeyFor({ format: "modules" })).toBe("broad:any-modules");
    expect(productKeyFor({})).toBe("broad:any-batteries");
  });

  it("rolls a specific key up to every broader key it counts as", () => {
    const keys = broaderKeysFor({ make: "Vauxhall", model: "Corsa-e", chemistry: "NMC", format: "packs", kwh: 50 });
    expect(keys).toEqual(["pack:stellantis-ecmp-50kwh", "model:vauxhall-corsae-50kwh", "broad:nmc-packs"]);
    const part = broaderKeysFor({ partNumbers: ["37501-Q4052"], make: "Kia", model: "Niro", kwh: 64.8, chemistry: "NMC", format: "packs" });
    expect(part[0]).toBe("part:37501Q4052");
    expect(part).toContain("pack:kia-niro-64kwh");
    expect(part.at(-1)).toBe("broad:nmc-packs");
    expect(new Set(part).size).toBe(part.length);
  });

  it("keys a group or alias make the way the SQL helper does", () => {
    expect(makeKey("VW")).toBe("volkswagen");
    expect(makeKey("Volkswagen Group")).toBe("vw-group");
    expect(makeKey("Hyundai or Kia")).toBe("hyundai-or-kia");
    expect(makeKey("Škoda")).toBe("skoda");
    expect(makeKey("Mercedes")).toBe("mercedes-benz");
    expect(makeKey("Polestar")).toBe("polestar");
    expect(makeKey("")).toBeNull();
    expect(productKeyFor({ make: "VW Group", model: "ID.3", chemistry: "NMC", format: "packs", kwh: 77 }))
      .toBe("pack:vw-meb-77kwh");
  });

  it("takes the facts from the supply parser's product key", () => {
    const facts = productFactsFromKey({
      lines: [{ format: "Packs", chemistry: "NMC", kwh: 77.4, kwhMin: null, kwhMax: null, units: 10, partNumber: null,
        make: "Hyundai", makeGroup: "Hyundai or Kia", model: "Hyundai Ioniq 5", platform: "E-GMP", moduleSeries: null,
        unknown: { kwh: false, format: false, chemistry: false }, basis: "77.4 kWh per pack" }],
      partNumbers: [], chemistry: "NMC", format: "Packs",
    });
    expect(productKeyFor(facts)).toBe("pack:hyundai-kia-egmp-77kwh");
  });

  it("reports the level of a key from its prefix", () => {
    expect(productKeysFor({ partNumbers: ["SU001B5189"] }).map((entry) => entry.level)).toEqual(["part", "broad"]);
    expect(productKeyLevel("pack:kia-niro-64kwh")).toBe("pack");
    expect(productKeyLevel("broad:lfp-packs")).toBe("broad");
  });

  it("finds a family by vehicle and stated capacity together", () => {
    expect(packFamilyFor({ make: "Kia", model: "e-Niro", kwh: 67.5 })?.id).toBe("kia-niro-64kwh");
    // A different capacity under the same model is not the family's pack.
    expect(packFamilyFor({ make: "Kia", model: "Niro", kwh: 39 })).toBeNull();
    expect(packFamilyFor({ make: "Tesla", model: "Model 3", kwh: 78 })?.id).toBe("tesla-model3y-75kwh");
  });
});
