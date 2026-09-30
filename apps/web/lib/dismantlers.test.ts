import { describe, expect, it } from "vitest";
import {
  addWorkingDays,
  dueLabel,
  effectiveStage,
  groupDismantlers,
  nextStage,
  parseDismantlerPatch,
  parseImport,
  platformLabel,
  summarise,
  type Dismantler,
  type PlatformFacts,
} from "./dismantlers";

const D = (o: Partial<Dismantler>): Dismantler => ({
  id: o.name!, company_id: "c", name: "", stage: "Talking", saved_stage: "Talking", stage_since: "2026-09-01", parked_from: null,
  park_reason: null, revisit_on: null, next_step: null, next_step_due: null, next_step_person_id: null, next_step_person_name: null,
  owner_user_id: null, owner_name: null, goal: false, country: null, ebay_username: null, ebay_listings: null,
  platform_account_id: null, platform: null, source: null, notes: null, last_contact: null, updated_at: "", ...o,
});

const P = (o: Partial<PlatformFacts>): PlatformFacts => ({
  account_id: "acc", account_name: "Yard Ltd", matched_by: "email", signed_up_on: "2026-09-01",
  listed: 0, listed_ever: 0, sold: 0, first_listed_on: null, last_listed_on: null, ...o,
});

describe("dismantler rules", () => {
  it("validates patches: parking needs a reason, dates are checked, blanks clear, old fields are gone", () => {
    expect(parseDismantlerPatch({ stage: "Parked" })).toEqual({ error: "Say why it is parked." });
    expect(parseDismantlerPatch({ stage: "Parked", park_reason: " Not now " })).toEqual({ patch: { stage: "Parked", park_reason: "Not now" } });
    expect(parseDismantlerPatch({ stage: "Contacted" })).toEqual({ error: "Unknown stage." });
    expect(parseDismantlerPatch({ next_step_due: "2026-02-30" })).toEqual({ error: "next_step_due must be a YYYY-MM-DD date." });
    expect(parseDismantlerPatch({ country: "", platform_account_id: "none" })).toEqual({ patch: { country: null, platform_account_id: "none" } });
    expect(parseDismantlerPatch({ route: "eBay" })).toEqual({ error: "Unknown field: route" });
    expect(parseDismantlerPatch({ waiting_on: "them" })).toEqual({ error: "Unknown field: waiting_on" });
  });

  it("lifts the stage to what ReBattery proves, and never lowers it", () => {
    expect(effectiveStage("Talking", null)).toBe("Talking");
    expect(effectiveStage("Talking", P({}))).toBe("Signed up");
    expect(effectiveStage("Found", P({ listed_ever: 3 }))).toBe("Live");
    expect(effectiveStage("Parked", P({ sold: 1 }))).toBe("Live");
    expect(effectiveStage("Live", P({}))).toBe("Live");
    expect(platformLabel(P({}))).toBe("Signed up, nothing listed yet");
    expect(platformLabel(P({ listed: 14, listed_ever: 20, sold: 3 }))).toBe("14 listed · 3 sold");
    expect(platformLabel(null)).toBe("");
  });

  it("groups dismantlers in play by what needs attention, Q4 goal first, leaving Found and Parked out", () => {
    const groups = groupDismantlers([
      D({ name: "Late", next_step: "Chase", next_step_due: "2026-09-28" }),
      D({ name: "Today", next_step: "Call", next_step_due: "2026-09-30", stage: "Signed up" }),
      D({ name: "Blank", stage: "Live" }),
      D({ name: "Goal blank", goal: true }),
      D({ name: "Soon", next_step: "They send list", next_step_due: "2026-10-05" }),
      D({ name: "Later", next_step: "Check in", next_step_due: "2026-10-20", stage: "Live" }),
      D({ name: "Backlog", stage: "Found" }),
      D({ name: "Away", stage: "Parked" }),
    ], "2026-09-30");
    expect(groups.map((group) => [group.name, group.dismantlers.map((d) => d.name)])).toEqual([
      ["Overdue", ["Late"]], ["Due today", ["Today"]], ["No next step", ["Goal blank", "Blank"]], ["This week", ["Soon"]], ["Later", ["Later"]],
    ]);
  });

  it("sums the numbers the tab exists to move", () => {
    const totals = summarise([
      D({ name: "A", goal: true, stage: "Live", platform: P({ listed: 4, listed_ever: 6, sold: 2 }) }),
      D({ name: "B", goal: true }),
      D({ name: "C", stage: "Live", platform: P({ listed: 1, listed_ever: 1 }), next_step: "x", next_step_due: "2026-10-02" }),
      D({ name: "D", stage: "Found", next_step: "x", next_step_due: "2026-09-01" }),
    ], "2026-09-30");
    expect(totals).toEqual({ live: 2, goal: 2, goalLive: 1, listed: 5, sold: 2, due: 1 });
  });

  it("labels due dates and steps along the journey", () => {
    const today = "2026-09-30";
    expect(dueLabel(D({ name: "a", next_step: "x", next_step_due: "2026-09-28" }), today)).toBe("2 days late");
    expect(dueLabel(D({ name: "b", next_step: "x", next_step_due: "2026-10-01" }), today)).toBe("Tomorrow");
    expect(dueLabel(D({ name: "c", next_step: "x" }), today)).toBe("No date");
    expect(dueLabel(D({ name: "d" }), today)).toBe("None");
    expect([nextStage("Found"), nextStage("Talking"), nextStage("Live"), nextStage("Parked")]).toEqual(["Talking", "Signed up", null, null]);
  });

  it("counts follow-ups in working days", () => {
    expect(addWorkingDays("2026-09-30", 4)).toBe("2026-10-06");
    expect(addWorkingDays("2026-10-02", 1)).toBe("2026-10-05");
  });

  it("reads a pasted list, from commas or a spreadsheet", () => {
    expect(parseImport("Name, Country\nPrestige Auto Salvage, UK, prestige-auto-salvage, 16\nSoton Car Parts\tUK\tsotoncarparts\t15\n\nBare Yard")).toEqual({
      rows: [
        { name: "Prestige Auto Salvage", country: "UK", ebay_username: "prestige-auto-salvage", ebay_listings: 16 },
        { name: "Soton Car Parts", country: "UK", ebay_username: "sotoncarparts", ebay_listings: 15 },
        { name: "Bare Yard", country: null, ebay_username: null, ebay_listings: null },
      ],
      errors: [],
    });
    expect(parseImport("Yard A\nyard a").errors).toEqual(["Line 2: yard a is listed twice."]);
    expect(parseImport("Smith, Jones Breakers\tUK\tsmithjones\t16").rows).toEqual([
      { name: "Smith, Jones Breakers", country: "UK", ebay_username: "smithjones", ebay_listings: 16 },
    ]);
    expect(parseImport("Smith, Jones Breakers, UK, smithjones, 16").errors[0]).toMatch(/more than 4 columns/);
    expect(parseImport("Yard, UK, seller, lots").errors).toEqual(["Line 1: battery listings must be a number."]);
  });
});
