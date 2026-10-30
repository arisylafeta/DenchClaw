import { describe, expect, it } from "vitest";
import { compareEnergy, correctionInstruction, decisionObservation, parseLabelText, validateDecision } from "./contract";

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
