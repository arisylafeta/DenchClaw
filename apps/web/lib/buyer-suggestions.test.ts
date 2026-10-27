import { describe, expect, it } from "vitest";
import { compareBuyers, isLead, scoreBuyer, type SupplyProfile } from "./buyer-suggestions";

const cells: SupplyProfile = { chemistry: "NMC", format: "Cells", text: "panasonic ncr2170 series (ncr2170m-4)", country: "US" };

describe("scoreBuyer", () => {
  it("matches on chemistry and format, and notes what is unknown", () => {
    const fit = scoreBuyer(cells, { chemistries: ["NMC", "LFP"], formats: ["Cells", "Modules"], makes: ["LG"] })!;
    expect(fit.matched).toEqual(["Chemistry NMC", "Format Cells"]);
    expect(fit.gaps[0]).toMatch(/names makes/);
  });
  it("rules out a stated different chemistry or format", () => {
    expect(scoreBuyer(cells, { chemistries: ["LFP"], formats: ["Cells"] })).toBeNull();
    expect(scoreBuyer(cells, { chemistries: ["NMC"], formats: ["Packs"] })).toBeNull();
  });
  it("needs one positive match: an unknown supply does not match everybody", () => {
    expect(scoreBuyer({ chemistry: null, format: null, text: "", country: null }, { chemistries: ["NMC"], formats: ["Cells"] })).toBeNull();
    expect(scoreBuyer({ ...cells, chemistry: null }, { chemistries: ["NMC"], formats: ["Cells"] })?.matched).toEqual(["Format Cells"]);
  });
  it("reads make, cell maker and origin", () => {
    const fit = scoreBuyer(cells, { chemistries: ["NMC"], cell_makers: ["Panasonic"], origins: ["US"] })!;
    expect(fit.matched).toContain("Make Panasonic");
    expect(fit.matched).toContain("Origin US");
    expect(scoreBuyer(cells, { chemistries: ["NMC"], origins: ["DE"] })!.gaps[0]).toMatch(/sources from DE/);
  });
});

describe("ranking and leads", () => {
  const fit = { matched: [], gaps: [], score: 2 };
  it("ranks stated before researched, then stage, then tier", () => {
    const rows = [
      { id: "lead", basis: "researched", stage: "Identified", tier: "A", fit },
      { id: "bid", basis: "stated", stage: "Bidding", tier: "C", fit },
      { id: "resp", basis: "stated", stage: "Responded", tier: "A", fit },
    ];
    expect(rows.sort(compareBuyers).map((r) => r.id)).toEqual(["bid", "resp", "lead"]);
  });
  it("calls an uncontacted researched company a lead", () => {
    expect(isLead({ basis: "researched", stage: "Identified" })).toBe(true);
    expect(isLead({ basis: "researched", stage: null })).toBe(true);
    expect(isLead({ basis: "stated", stage: "Identified" })).toBe(false);
    expect(isLead({ basis: "researched", stage: "Responded" })).toBe(false);
  });
});
