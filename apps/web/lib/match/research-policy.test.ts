import { describe, expect, it } from "vitest";
import { activityFit, RESEARCH_POLICY, RESEARCH_POLICY_VERSION } from "./research-policy";

const weights = (activity: string) => RESEARCH_POLICY[activity].formats;

describe("research policy v1", () => {
  it("is version 1", () => expect(RESEARCH_POLICY_VERSION).toBe(1));
  it.each([
    ["repairs_ev_packs", { packs: 3, modules: 2 }],
    ["repairs_hybrid_packs", { packs: 3, modules: 2 }],
    ["replaces_modules", { modules: 3 }],
    ["replaces_cells", { cells: 2 }],
    ["builds_packs_from_cells", { cells: 3, modules: 2 }],
    ["sells_loose_cells", { cells: 3 }],
    ["sells_finished_batteries", {}],
    ["integrates_storage", { modules: 3, packs: 3, systems: 3 }],
    ["converts_vehicles", { packs: 3, modules: 3 }],
    ["recycles", { cells: 2, modules: 2, packs: 2, systems: 2 }],
    ["trades_used_batteries", { cells: 3, modules: 3, packs: 3 }],
    ["manufactures_batteries", {}],
    ["none", {}],
  ])("%s", (activity, expected) => expect(weights(activity)).toEqual(expected));

  it("takes the strongest weight over several activities", () => {
    expect(activityFit(["recycles", "sells_loose_cells"], "cells")).toEqual({ weight: 3, activity: "sells_loose_cells" });
    expect(activityFit(["recycles"], "Packs")).toEqual({ weight: 2, activity: "recycles" });
  });
  it("gives 0 for no fit, unknown activities and a lot without a format", () => {
    expect(activityFit(["sells_loose_cells"], "packs").weight).toBe(0);
    expect(activityFit(["made_up"], "packs").weight).toBe(0);
    expect(activityFit(["recycles"], null).weight).toBe(0);
  });
});
