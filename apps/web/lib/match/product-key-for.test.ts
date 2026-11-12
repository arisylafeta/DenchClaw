import { describe, expect, it } from "vitest";
import {
  broaderKeysFor,
  expandProductFacts,
  isProseModel,
  kwhKeyText,
  makeKey,
  packFamilyFor,
  productFactsFromKey,
  productKeyFor,
  productKeyLevel,
  productKeysFor,
} from "./product-key-for";

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
    // The range is not a pack, but the stated make still scopes the bucket rather than being dropped.
    expect(key).toBe("broad:hyundai-any-packs");
    expect(broaderKeysFor({ make: "Hyundai", model: "Ioniq 5", kwhMin: 50, kwhMax: 60, format: "Packs" }))
      .toEqual(["broad:hyundai-any-packs", "broad:any-packs"]);
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
    expect(keys).toEqual([
      "pack:stellantis-ecmp-50kwh", "model:vauxhall-corsae-50kwh", "broad:vauxhall-nmc-packs", "broad:nmc-packs",
    ]);
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

  it("takes the facts from the supply parser's product key, one fact set per product line", () => {
    const facts = productFactsFromKey({
      lines: [{ format: "Packs", chemistry: "NMC", kwh: 77.4, kwhMin: null, kwhMax: null, units: 10, partNumber: null,
        make: "Hyundai", makeGroup: "Hyundai or Kia", model: "Hyundai Ioniq 5", platform: "E-GMP", moduleSeries: null,
        unknown: { kwh: false, format: false, chemistry: false }, basis: "77.4 kWh per pack" }],
      partNumbers: [], chemistry: "NMC", format: "Packs",
    });
    expect(facts).toHaveLength(1);
    expect(productKeyFor(facts[0])).toBe("pack:hyundai-kia-egmp-77kwh");

    // Two product lines are two products: the second is not dropped.
    const two = productFactsFromKey({
      lines: [
        { format: "Packs", chemistry: "NMC", kwh: 50, kwhMin: null, kwhMax: null, units: 4, partNumber: null,
          make: "Vauxhall", makeGroup: null, model: "Corsa-e", platform: null, moduleSeries: null,
          unknown: { kwh: false, format: false, chemistry: false }, basis: null },
        { format: "Modules", chemistry: "LFP", kwh: null, kwhMin: null, kwhMax: null, units: 20, partNumber: null,
          make: null, makeGroup: null, model: null, platform: null, moduleSeries: null,
          unknown: { kwh: true, format: false, chemistry: false }, basis: null },
      ],
      partNumbers: [], chemistry: null, format: null,
    });
    expect(two.map(productKeyFor)).toEqual(["pack:stellantis-ecmp-50kwh", "broad:lfp-modules"]);
  });

  it("fans every stated make and chemistry out instead of keeping only the first", () => {
    const { facts, stated } = expandProductFacts({
      makes: ["Toyota or Lexus", "Stellantis"], chemistries: ["NMC", "LFP"], formats: ["Packs"], kwhMin: 50, kwhMax: 60,
    });
    expect(stated).toBe(4);
    expect(facts.map(productKeyFor)).toEqual([
      "broad:stellantis-lfp-packs",
      "broad:stellantis-nmc-packs",
      "broad:toyota-or-lexus-lfp-packs",
      "broad:toyota-or-lexus-nmc-packs",
    ]);
  });

  it("splits a compound make into one want per make, never one slugged phrase", () => {
    const split = expandProductFacts({ makes: ["BMW / Volvo"], formats: ["Packs"] });
    expect(split.stated).toBe(2);
    expect(split.facts.map(productKeyFor).sort()).toEqual(["broad:bmw-any-packs", "broad:volvo-any-packs"]);
    expect(expandProductFacts({ makes: ["MG, Stellantis, Tesla"], chemistries: ["LFP"], formats: ["Packs"] })
      .facts.map(productKeyFor).sort()).toEqual([
      "broad:mg-lfp-packs", "broad:stellantis-lfp-packs", "broad:tesla-lfp-packs",
    ]);
    // A group name stays one demand: "Hyundai or Kia" is not two makes.
    expect(expandProductFacts({ makes: ["Hyundai or Kia"], formats: ["Packs"] }).facts.map(productKeyFor))
      .toEqual(["broad:hyundai-or-kia-any-packs"]);
  });

  it("keeps a prose model out of the key and falls back to the make", () => {
    const prose = "82 kWh: ID.4, Q4 e-tron, Enyaq, ID.7, Elroq";
    expect(isProseModel(prose)).toBe(true);
    expect(isProseModel("hybrid 2015-2022 (225xe, 330e)")).toBe(true);
    expect(isProseModel("Ioniq 5")).toBe(false);
    expect(productKeyFor({ make: "VW Group", model: prose, chemistry: "NMC", format: "packs", kwh: 82 }))
      .toBe("broad:vw-group-nmc-packs");
    // A capacity written into the model name is the capacity the facts already state.
    expect(productKeyFor({ make: "Renault", model: "Zoe 41 kWh", format: "packs", kwh: 41 }))
      .toBe("model:renault-zoe-41kwh");
  });

  it("never keys a product name as a part number", () => {
    // A dossier put a module name in part_number: it must not become part:0NYXSTRATAH415.
    expect(productKeyFor({ partNumbers: ["Onyx Strata H4-15"], make: "Proterra", format: "packs" }))
      .toBe("broad:proterra-any-packs");
    expect(productKeyFor({ partNumbers: ["37501AO050"] })).toBe("part:37501A0050");
  });

  it("caps the fan-out and reports how many combinations the source stated", () => {
    const makes = ["Toyota", "Stellantis", "Hyundai", "Kia", "BMW"];
    const chemistries = ["NMC", "LFP", "NCA"];
    const { facts, stated } = expandProductFacts({ makes, chemistries, formats: ["Packs"] });
    expect(stated).toBe(15);
    expect(facts).toHaveLength(12);
    expect(new Set(facts.map(productKeyFor)).size).toBe(12);
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
    // Tesla 75/78/82 kWh are different packs by generation, so the list stays out of it and the key stops at model.
    expect(packFamilyFor({ make: "Tesla", model: "Model 3", kwh: 78 })).toBeNull();
    expect(productKeyFor({ make: "Tesla", model: "Model 3", kwh: 78, chemistry: "NMC", format: "Packs" }))
      .toBe("model:tesla-model3-78kwh");
    // The EV9 is a 99.8 kWh pack, not the 77 kWh E-GMP one.
    expect(packFamilyFor({ make: "Kia", model: "EV9", kwh: 99.8 })).toBeNull();
    expect(packFamilyFor({ make: "Kia", model: "EV6", kwh: 77.4 })?.id).toBe("hyundai-kia-egmp-77kwh");
  });
});
