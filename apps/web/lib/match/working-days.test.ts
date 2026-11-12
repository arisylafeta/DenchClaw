import { describe, expect, it } from "vitest";
import { chaseDue, londonDate, workingDaysBetween } from "./working-days";

// November 2026: Mon 2, Tue 3, Wed 4, Thu 5, Fri 6, Sat 7, Sun 8, Mon 9.
const at = (day: string, time = "09:00") => `${day}T${time}:00Z`;

describe("working days", () => {
  it("counts Monday to Friday and skips the weekend", () => {
    expect(workingDaysBetween(at("2026-11-02"), at("2026-11-03"))).toBe(1);
    expect(workingDaysBetween(at("2026-11-02"), at("2026-11-06"))).toBe(4);
    expect(workingDaysBetween(at("2026-11-06"), at("2026-11-09"))).toBe(1);
    expect(workingDaysBetween(at("2026-11-02"), at("2026-11-09"))).toBe(5);
  });

  it("does not count the day it was sent, or a same-day check", () => {
    expect(workingDaysBetween(at("2026-11-02", "09:00"), at("2026-11-02", "17:00"))).toBe(0);
    expect(workingDaysBetween(at("2026-11-06"), at("2026-11-08"))).toBe(0);
  });

  it("never returns a negative count", () => {
    expect(workingDaysBetween(at("2026-11-06"), at("2026-11-02"))).toBe(0);
  });

  it("chases on working day 1, 3 and 5 (lib/chase-clock.ts), not on the day it was sent", () => {
    const sent = at("2026-11-02");
    expect(chaseDue(sent, at("2026-11-02", "17:00"))).toBe(false);
    expect(chaseDue(sent, at("2026-11-03"))).toBe(true);
    expect(chaseDue(sent, at("2026-11-04", "23:00"), 1)).toBe(false);
    expect(chaseDue(sent, at("2026-11-05"), 1)).toBe(true);
    // Friday to Monday is one working day: the first chase, not the second.
    expect(chaseDue(at("2026-11-06"), at("2026-11-09"))).toBe(true);
    expect(chaseDue(at("2026-11-06"), at("2026-11-09"), 1)).toBe(false);
  });

  it("uses the London date, so a late-evening send is not a day ahead", () => {
    // 23:30 UTC on 2 November is still 2 November in London in winter.
    expect(londonDate("2026-11-02T23:30:00Z")).toBe("2026-11-02");
    // 23:30 UTC on 2 July is 00:30 on 3 July in London.
    expect(londonDate("2026-07-02T23:30:00Z")).toBe("2026-07-03");
  });
});
