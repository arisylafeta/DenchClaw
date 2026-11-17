import { describe, expect, it } from "vitest";
import { activeFilterCount, applyStrip, daysBetween, dueChip, isOnTrack, moveLabel, moveOf, nextStrip, overviewGroups, stageTrack, stripCounts } from "./bulk-overview";
import { NO_FILTERS, type SheetRow } from "./bulk-sheet";
import { DEMAND_STAGES, SUPPLY_STAGES } from "./bulk-listing";

const TODAY = "2026-11-17";

function row(id: string, overrides: Partial<SheetRow> = {}): SheetRow {
  return {
    key: id, id, kind: "demand", side: "buyer", title: `Row ${id}`, company: `Co ${id}`, company_id: null, category: null,
    progress: "New", tone: "new", score: null, latest: null, next_action: "Do it", next_due: null, owner: "Sean", touched: null,
    waiting_on: null, waiting_since: null, ...overrides,
  };
}

const ids = (rows: SheetRow[]) => rows.map((r) => r.id);

describe("whose move", () => {
  it("is ours when we wait on nobody or on us, theirs only when waiting on them", () => {
    expect(moveOf({ waiting_on: "us" })).toBe("you");
    expect(moveOf({ waiting_on: "them" })).toBe("them");
    expect(moveOf({ waiting_on: null })).toBe("you");
    expect(moveOf({})).toBe("you");
  });

  it("groups rows into your move, their move and on track; no waiting-on is your move", () => {
    const rows = [
      row("us", { waiting_on: "us", next_due: "2026-11-18" }),
      row("them", { waiting_on: "them", next_due: "2026-11-20" }),
      row("unset", { waiting_on: null, next_due: "2026-11-17" }),
      row("later-us", { waiting_on: "us", next_due: "2026-11-24" }),
      row("later-them", { waiting_on: "them", next_due: "2026-12-01" }),
      row("undated-them", { waiting_on: "them", next_due: null }),
    ];
    const groups = overviewGroups(rows, TODAY);
    expect(ids(groups.you)).toEqual(["unset", "us"]);
    expect(ids(groups.them)).toEqual(["them", "undated-them"]);
    expect(ids(groups.onTrack)).toEqual(["later-us", "later-them"]);
  });

  it("puts a row on track only when it is due a week or more out: due in 6 days, overdue or undated stay in their group", () => {
    expect(isOnTrack({ next_due: "2026-11-24" }, TODAY)).toBe(true);
    expect(isOnTrack({ next_due: "2026-11-23" }, TODAY)).toBe(false);
    expect(isOnTrack({ next_due: "2026-11-01" }, TODAY)).toBe(false);
    expect(isOnTrack({ next_due: null }, TODAY)).toBe(false);
  });
});

describe("sort order", () => {
  it("your move runs most overdue first, then by due date, undated last", () => {
    const rows = [
      row("tomorrow", { next_due: "2026-11-18" }),
      row("undated", { next_due: null }),
      row("over-1", { next_due: "2026-11-16" }),
      row("today", { next_due: "2026-11-17" }),
      row("over-9", { next_due: "2026-11-08" }),
    ];
    expect(ids(overviewGroups(rows, TODAY).you)).toEqual(["over-9", "over-1", "today", "tomorrow", "undated"]);
  });

  it("their move runs by due date", () => {
    const rows = [row("b", { waiting_on: "them", next_due: "2026-11-20" }), row("a", { waiting_on: "them", next_due: "2026-11-19" }), row("c", { waiting_on: "them", next_due: "2026-11-10" })];
    expect(ids(overviewGroups(rows, TODAY).them)).toEqual(["c", "a", "b"]);
  });

  it("a chosen sort orders within each group instead", () => {
    const rows = [row("a", { next_due: "2026-11-10", fee_eur: 100 }), row("b", { next_due: "2026-11-12", fee_eur: 900 })];
    const byFee = (list: SheetRow[]) => [...list].sort((x, y) => (y.fee_eur ?? 0) - (x.fee_eur ?? 0));
    expect(ids(overviewGroups(rows, TODAY, byFee).you)).toEqual(["b", "a"]);
  });
});

describe("the whose-move strip", () => {
  const rows = [
    row("over", { waiting_on: "us", next_due: "2026-11-15", fee_eur: 1000 }),
    row("due", { waiting_on: null, next_due: "2026-11-17", fee_eur: 500 }),
    row("them", { waiting_on: "them", next_due: "2026-11-19", fee_eur: null }),
    row("track", { waiting_on: "us", next_due: "2026-12-01", fee_eur: 7000 }),
  ];
  const groups = overviewGroups(rows, TODAY);

  it("counts your move, how many of those are overdue, their move and all; fees cover your and their move", () => {
    expect(stripCounts(groups, TODAY)).toEqual({ you: 2, over: 1, them: 1, all: 4, fees_eur: 1500, active: 3 });
  });

  it("filters to one group, overdue to your overdue moves, and all shows on track too", () => {
    expect(ids(applyStrip(groups, "you", TODAY).you)).toEqual(["over", "due"]);
    expect(applyStrip(groups, "you", TODAY).them).toEqual([]);
    expect(ids(applyStrip(groups, "over", TODAY).you)).toEqual(["over"]);
    expect(ids(applyStrip(groups, "them", TODAY).them)).toEqual(["them"]);
    expect(applyStrip(groups, "them", TODAY).you).toEqual([]);
    expect(applyStrip(groups, "them", TODAY).onTrack).toEqual([]);
    expect(applyStrip(groups, "all", TODAY)).toBe(groups);
  });

  it("clicking the chosen count again clears it", () => {
    expect(nextStrip("all", "you")).toBe("you");
    expect(nextStrip("you", "you")).toBe("all");
    expect(nextStrip("you", "them")).toBe("them");
  });
});

describe("stage track", () => {
  it("maps every real stage onto New, Qualified, Sourcing, Offered, Negotiating, Agreed", () => {
    const step = (stage: string) => stageTrack(stage).step;
    expect([...DEMAND_STAGES, ...SUPPLY_STAGES].every((stage) => step(stage) >= 1 && step(stage) <= 6)).toBe(true);
    expect(["New", "Qualified", "Sourcing", "Offered", "Negotiating", "Agreed"].map(step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(step("Can't source")).toBe(3);
    expect(step("Available")).toBe(3);
    expect(step("Paid")).toBe(6);
    expect(step("Delivered")).toBe(6);
  });

  it("marks the done steps, the current one, and the rest; past Agreed every step is done", () => {
    expect(stageTrack("Sourcing").segments).toEqual(["done", "done", "now", "", "", ""]);
    expect(stageTrack("New").segments).toEqual(["now", "", "", "", "", ""]);
    expect(stageTrack("Agreed").segments).toEqual(["done", "done", "done", "done", "done", "now"]);
    expect(stageTrack("Paid").segments).toEqual(["done", "done", "done", "done", "done", "done"]);
  });
});

describe("row labels", () => {
  it("due chips: overdue in days, today, tomorrow, then the date", () => {
    expect(daysBetween("2026-10-30", "2026-11-17")).toBe(18);
    expect(dueChip("2026-11-16", TODAY)).toEqual({ text: "Overdue 1 day", tone: "over" });
    expect(dueChip("2026-11-14", TODAY)).toEqual({ text: "Overdue 3 days", tone: "over" });
    expect(dueChip("2026-11-17", TODAY)).toEqual({ text: "Due today", tone: "today" });
    expect(dueChip("2026-11-18", TODAY)).toEqual({ text: "Due tomorrow", tone: "soon" });
    expect(dueChip("2026-11-20", TODAY)).toEqual({ text: "Due 20 Nov", tone: "soon" });
    expect(dueChip(null, TODAY)).toBeNull();
  });

  it("move labels: since when for ours; the contact's first name and how long for theirs", () => {
    expect(moveLabel({ waiting_on: "us", waiting_since: "2026-10-30" }, TODAY)).toBe("Your move · since 30 Oct");
    expect(moveLabel({ waiting_on: null }, TODAY)).toBe("Your move");
    expect(moveLabel({ waiting_on: "them", waiting_since: "2026-11-11", contact: "Markus Nolden" }, TODAY)).toBe("Their move · Markus, 6 days");
    expect(moveLabel({ waiting_on: "them", waiting_since: "2026-11-16", contact: "Markus Nolden" }, TODAY)).toBe("Their move · Markus, 1 day");
    expect(moveLabel({ waiting_on: "them", waiting_since: "2026-08-26", contact: "Laimonas Šukys" }, TODAY)).toBe("Their move · Laimonas, 11 weeks");
    expect(moveLabel({ waiting_on: "them", waiting_since: "2026-11-17", contact: null }, TODAY)).toBe("Their move · today");
    expect(moveLabel({ waiting_on: "them" }, TODAY)).toBe("Their move");
  });
});

describe("Filters count", () => {
  it("counts the popover's filters, not search, and not a side the tab locks", () => {
    expect(activeFilterCount(NO_FILTERS, true)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, query: "packs" }, true)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, progress: "New", company: "Colvert", waiting: "us" }, true)).toBe(3);
    expect(activeFilterCount({ ...NO_FILTERS, side: "buyer", category: "Ioniq" }, true)).toBe(1);
    expect(activeFilterCount({ ...NO_FILTERS, side: "buyer", category: "Ioniq" }, false)).toBe(2);
  });
});
