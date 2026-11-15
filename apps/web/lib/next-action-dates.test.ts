import { describe, expect, it } from "vitest";
import { addDays, dueLabel, nextMonday, quickDays } from "./next-action-dates";

describe("next action dates", () => {
  it("adds days across a month end", () => {
    expect(addDays("2026-11-29", 3)).toBe("2026-12-02");
  });

  it("next Monday is never today", () => {
    expect(nextMonday("2026-11-16")).toBe("2026-11-23"); // a Monday
    expect(nextMonday("2026-11-15")).toBe("2026-11-16"); // a Sunday
  });

  it("names quick days one way and drops duplicates", () => {
    // Sunday: tomorrow is also next Monday, so it appears once.
    expect(quickDays("2026-11-15")).toEqual([
      { day: "2026-11-15", label: "Today" },
      { day: "2026-11-16", label: "Tomorrow" },
      { day: "2026-11-18", label: "Wed 18" },
    ]);
    expect(quickDays("2026-11-18").map((q) => q.label)).toEqual(["Today", "Tomorrow", "Sat 21", "Mon 23"]);
  });

  it("labels the due pill", () => {
    expect(dueLabel("2026-11-02", "2026-11-15")).toEqual({ text: "Overdue 2 Nov", tone: "overdue" });
    expect(dueLabel("2026-11-15", "2026-11-15")).toEqual({ text: "Today", tone: "today" });
    expect(dueLabel("2026-11-16", "2026-11-15")).toEqual({ text: "Tomorrow", tone: "later" });
    expect(dueLabel("2026-12-20", "2026-11-15")).toEqual({ text: "20 Dec", tone: "later" });
    expect(dueLabel(null, "2026-11-15")).toEqual({ text: "No date", tone: null });
  });
});
