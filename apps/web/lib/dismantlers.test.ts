import { describe, expect, it } from "vitest";
import {
  addWorkingDays,
  dueLabel,
  groupDismantlers,
  nextStage,
  parseDismantlerPatch,
  parseImport,
  type Dismantler,
} from "./dismantlers";

const D = (o: Partial<Dismantler>): Dismantler => ({
  id: o.name!, company_id: "c", name: "", stage: "Contacted", stage_since: "2026-09-01", parked_from: null, park_reason: null,
  revisit_on: null, next_step: null, next_step_due: null, next_step_person_id: null, next_step_person_name: null,
  waiting_on: "us", waiting_since: null, owner_user_id: null, owner_name: null, goal: false, route: null, country: null,
  ebay_username: null, ebay_listings: null, platform_account_id: null, source: null, notes: null,
  setup_account_on: null, setup_route_on: null, setup_connected_on: null, setup_first_stock_on: null,
  setup_first_sync_on: null, setup_second_sync_on: null, last_contact: null, updated_at: "", ...o,
});

describe("dismantler rules", () => {
  it("validates patches: parking needs a reason, dates and routes are checked, blanks clear", () => {
    expect(parseDismantlerPatch({ stage: "Parked" })).toEqual({ error: "Say why it is parked." });
    expect(parseDismantlerPatch({ stage: "Parked", park_reason: " Not now " })).toEqual({ patch: { stage: "Parked", park_reason: "Not now" } });
    expect(parseDismantlerPatch({ route: "Website" })).toEqual({ error: "route must be eBay, API or Other." });
    expect(parseDismantlerPatch({ next_step_due: "2026-02-30" })).toEqual({ error: "next_step_due must be a YYYY-MM-DD date." });
    expect(parseDismantlerPatch({ route: "", country: "", setup_account_on: "" })).toEqual({ patch: { route: null, country: null, setup_account_on: null } });
    expect(parseDismantlerPatch({ name: "x" })).toEqual({ error: "Unknown field: name" });
  });

  it("groups dismantlers in play by what needs attention, leaving Found and Parked out", () => {
    const groups = groupDismantlers([
      D({ name: "Late", next_step: "Chase", next_step_due: "2026-09-28" }),
      D({ name: "Today", next_step: "Call", next_step_due: "2026-09-30", stage: "Onboarding" }),
      D({ name: "Blank", stage: "Live" }),
      D({ name: "Waiting", waiting_on: "them", waiting_since: "2026-09-24", next_step: "They send list", next_step_due: "2026-10-05" }),
      D({ name: "Later", next_step: "Check sync", next_step_due: "2026-10-08", stage: "Syncing" }),
      D({ name: "Backlog", stage: "Found" }),
      D({ name: "Away", stage: "Parked" }),
    ], "2026-09-30");
    expect(groups.map((group) => [group.name, group.dismantlers.map((d) => d.name)])).toEqual([
      ["Overdue", ["Late"]], ["Due today", ["Today"]], ["No next step", ["Blank"]], ["Waiting on them", ["Waiting"]], ["Later", ["Later"]],
    ]);
  });

  it("labels due dates and steps along the journey", () => {
    const today = "2026-09-30";
    expect(dueLabel(D({ name: "a", next_step: "x", next_step_due: "2026-09-28" }), today)).toBe("2 days late");
    expect(dueLabel(D({ name: "b", next_step: "x", next_step_due: "2026-10-01" }), today)).toBe("Tomorrow");
    expect(dueLabel(D({ name: "c", waiting_on: "them", waiting_since: "2026-09-24" }), today)).toBe("since 24 Sep");
    expect(dueLabel(D({ name: "d" }), today)).toBe("None");
    expect([nextStage("Found"), nextStage("Live"), nextStage("Syncing"), nextStage("Parked")]).toEqual(["Contacted", "Syncing", null, null]);
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
  });
});
