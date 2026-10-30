import { describe, expect, it } from "vitest";
import { compareEnergy, correctionInstruction, decisionObservation, groupEntries, groupKeyOf, parseLabelText, validateDecision, validateGroupDecision, type LabelReviewEntry } from "./contract";

const OBS = "11111111-1111-4111-8111-111111111111";

describe("parseLabelText", () => {
  it("reads kWh, V and Ah from an OEM label", () => {
    expect(parseLabelText("VW; 1EA 915 910 AC; Nominal Voltage 352 V; Nominal Capacity 234 Ah; Nominal Energy 82 kWh; Weight 485 kg"))
      .toEqual({ kwh: 82, voltage: 352, ah: 234 });
  });
  it("converts Wh to kWh and accepts spaces and decimal commas", () => {
    expect(parseLabelText("E nenn = 13500 Wh; U nenn = 365V; C = 37,0 Ah").kwh).toBe(13.5);
    expect(parseLabelText("NOMINAL ENERGY 26 800 Wh").kwh).toBe(26.8);
    expect(parseLabelText("Nominal Energy 13,0kWh").kwh).toBe(13);
  });
  it("returns nulls when the reading holds no figures", () => {
    expect(parseLabelText("Enclosed metal battery assembly with orange HV connector")).toEqual({ kwh: null, voltage: null, ah: null });
  });
});

describe("compareEnergy", () => {
  it("matches within rounding and flags real differences", () => {
    expect(compareEnergy(26.8, 26.8)).toBe("match");
    expect(compareEnergy(44.305, 44.3)).toBe("match");
    expect(compareEnergy(82, 77)).toBe("mismatch");
    expect(compareEnergy(null, 77)).toBe("no_energy");
    expect(compareEnergy(82, null)).toBe("no_stored");
  });
});

describe("validateDecision", () => {
  it("accepts approve with no note", () => {
    expect(validateDecision({ observationId: OBS, decision: "approve", note: "" })).toMatchObject({ ok: true });
  });
  it("requires a reason to reject and a value to correct", () => {
    expect(validateDecision({ observationId: OBS, decision: "reject", note: "" })).toMatchObject({ ok: false });
    expect(validateDecision({ observationId: OBS, decision: "correct", note: "", correctedKwh: null })).toMatchObject({ ok: false });
    expect(validateDecision({ observationId: OBS, decision: "correct", note: "label says 82", correctedKwh: 82 })).toMatchObject({ ok: true, value: { correctedKwh: 82 } });
  });
  it("rejects bad ids, unknown decisions and absurd energy", () => {
    expect(validateDecision({ observationId: "x", decision: "approve", note: "" })).toMatchObject({ ok: false });
    expect(validateDecision({ observationId: OBS, decision: "delete", note: "" })).toMatchObject({ ok: false });
    expect(validateDecision({ observationId: OBS, decision: "correct", note: "", correctedKwh: 4000 })).toMatchObject({ ok: false });
  });
});

describe("what gets written", () => {
  const entry = { observationId: OBS, photoUrl: "https://cdn.example/p.jpg", photoNumber: 5 };
  it("records the decision as an append-only observation with the person and note", () => {
    const body = decisionObservation(entry, { observationId: OBS, decision: "correct", note: "label says 82", correctedKwh: 82 }, "crm:ari@example.com");
    expect(body.values).toMatchObject({ humanLabelCheck: "correct", observationId: OBS, decidedBy: "crm:ari@example.com", correctedKwh: 82 });
    expect(body.text).toContain("Corrected pack energy: 82 kWh");
    expect(body.source).toEqual({ kind: "text" });
  });
  it("states the owner instruction for a correction", () => {
    const i = correctionInstruction(entry, { observationId: OBS, decision: "correct", note: "Audi Q4", correctedKwh: 82 }, "crm:ari@example.com");
    expect(i.text).toContain("packKwh to 82 kWh");
    expect(i.source).toContain("label review");
  });
});

const entry = (over: Partial<LabelReviewEntry>): LabelReviewEntry => ({
  observationId: "11111111-1111-4111-8111-111111111111", itemId: "i1", itemVersion: 1, actor: null, createdAt: "x", make: "Dacia", model: "Spring",
  partNumbers: ["295107843R"], donorYear: null, text: "", quote: null, photoUrl: "u", photoNumber: 1, otherPhotos: [], listingUrl: null,
  stored: { packKwh: 26.8, voltageNominal: null, capacityAh: null, packKwhAuthority: null }, parsed: { kwh: 26.8, voltage: null, ah: null }, match: "match", decision: null, ...over,
});

describe("grouping by part code", () => {
  it("normalises the code so spacing and case do not split a group", () => {
    expect(groupKeyOf({ partNumbers: ["295 107-843r"], make: "Dacia", model: "Spring" })).toBe("pn:295107843R");
  });
  it("groups rows that share a part code and counts rows, readings and what differs", () => {
    const groups = groupEntries([
      entry({ observationId: "a", itemId: "i1" }),
      entry({ observationId: "b", itemId: "i1", photoNumber: 2 }),
      entry({ observationId: "c", itemId: "i2", model: "Spring Electric", match: "mismatch", parsed: { kwh: 27, voltage: null, ah: null } }),
      entry({ observationId: "d", itemId: "i3", partNumbers: ["0Z1915910AL"], make: "Audi", model: "Q4" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ key: "pn:295107843R", rows: 2, pending: 3, mismatches: 1 });
    expect(groups[0].subtitle).toContain("2 rows");
    expect(groups[0].subtitle).toContain("3 readings");
  });
  it("groups codeless rows by make and model, and lists groups that differ first", () => {
    const groups = groupEntries([
      entry({ observationId: "a", partNumbers: [], make: "Toyota", model: "Yaris Cross", match: "match" }),
      entry({ observationId: "b", partNumbers: [], make: "Toyota", model: "Yaris Cross", itemId: "i2" }),
      entry({ observationId: "c", partNumbers: ["X1"], make: "Kia", model: "Niro", match: "mismatch" }),
    ]);
    expect(groups[0].key).toBe("pn:X1");
    expect(groups[1].title).toBe("Toyota Yaris Cross (no part code)");
    expect(groups[1].rows).toBe(2);
  });
  it("a group with every reading checked has nothing pending", () => {
    const [g] = groupEntries([entry({ decision: { decision: "approve", note: "", by: "x", at: "y" } })]);
    expect(g.pending).toBe(0);
  });
});

describe("validateGroupDecision", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  it("accepts several readings, removes duplicates and reuses the single-decision rules", () => {
    expect(validateGroupDecision({ observationIds: [A, B, A], decision: "approve", note: "" })).toMatchObject({ ok: true, value: { observationIds: [A, B] } });
    expect(validateGroupDecision({ observationIds: [A, B], decision: "reject", note: "" })).toMatchObject({ ok: false });
    expect(validateGroupDecision({ observationIds: [A, B], decision: "correct", note: "", correctedKwh: 26 })).toMatchObject({ ok: true, value: { correctedKwh: 26 } });
  });
  it("refuses an empty, oversized or malformed list", () => {
    expect(validateGroupDecision({ observationIds: [], decision: "approve", note: "" })).toMatchObject({ ok: false });
    expect(validateGroupDecision({ observationIds: ["nope"], decision: "approve", note: "" })).toMatchObject({ ok: false });
    expect(validateGroupDecision({ observationIds: Array(101).fill(A), decision: "approve", note: "" })).toMatchObject({ ok: false });
  });
});
