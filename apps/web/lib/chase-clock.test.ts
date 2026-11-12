import { describe, expect, it } from "vitest";
import cases from "./chase-clock.cases.json";
import { addWorkingDays, CHASE_DAYS, chaseClock, chaseLabel, leadLate, workingMinutesBetween } from "./chase-clock";
import { chaseDue } from "./match/working-days";

describe("the chase clock", () => {
  it("falls due on working day 1, 3 and 5", () => {
    expect(CHASE_DAYS).toEqual([1, 3, 5]);
  });

  // The same cases run in scripts/rebattery/test_relay_scan.py against the scan's mirror.
  for (const c of cases.cases) {
    it(c.name, () => {
      const clock = chaseClock({ since: c.since, last: (c as { last?: string }).last ?? null, chases: c.chases, answered: (c as { answered?: boolean }).answered ?? false }, c.now);
      expect({ state: clock.state, waited: clock.waited, next: clock.next, due_on: clock.due_on }).toEqual(c.expect);
    });
  }

  it("counts working days forward from the London date", () => {
    expect(addWorkingDays("2026-11-06T15:00:00Z", 1)).toBe("2026-11-09");
    expect(addWorkingDays("2026-11-02T09:00:00Z", 5)).toBe("2026-11-09");
    expect(addWorkingDays("2026-11-02T09:00:00Z", 0)).toBe("2026-11-02");
  });

  it("labels each state in plain words", () => {
    expect(chaseLabel(chaseClock({ since: "2026-11-02T09:00:00Z", chases: 1 }, "2026-11-05T09:00:00Z"))).toBe("Chase 2 of 3 due (3 working days without an answer)");
    expect(chaseLabel(chaseClock({ since: "2026-11-02T09:00:00Z", chases: 3, last: "2026-11-09T09:00:00Z" }, "2026-11-10T09:00:00Z"))).toBe("3 chases unanswered: park it?");
    expect(chaseLabel(chaseClock({ since: "2026-11-02T09:00:00Z", chases: 0 }, "2026-11-02T10:00:00Z"))).toBe("Sent today, no answer yet");
  });

  it("drives the offer chase too: due from working day 1, not day 3 any more", () => {
    expect(chaseDue("2026-11-02T09:00:00Z", "2026-11-02T17:00:00Z")).toBe(false);
    expect(chaseDue("2026-11-02T09:00:00Z", "2026-11-03T09:00:00Z")).toBe(true);
    expect(chaseDue("2026-11-02T09:00:00Z", "2026-11-04T09:00:00Z", 1)).toBe(false);
    expect(chaseDue("2026-11-02T09:00:00Z", "2026-11-05T09:00:00Z", 1)).toBe(true);
    expect(chaseDue("2026-11-02T09:00:00Z", "2026-11-20T09:00:00Z", 3)).toBe(false);
  });
});

describe("the two working hours rule for a new lead", () => {
  it("counts only Monday to Friday, 09:00 to 18:00 London", () => {
    // Thursday 12 Nov 2026 (GMT): 10:00 to 11:30 is 90 minutes.
    expect(workingMinutesBetween("2026-11-12T10:00:00Z", "2026-11-12T11:30:00Z")).toBe(90);
    // Before opening and after closing count nothing.
    expect(workingMinutesBetween("2026-11-12T06:00:00Z", "2026-11-12T09:30:00Z")).toBe(30);
    expect(workingMinutesBetween("2026-11-12T17:30:00Z", "2026-11-12T23:00:00Z")).toBe(30);
  });

  it("does not count the weekend: Friday 17:00 to Monday 10:30 is two working hours and a half", () => {
    expect(workingMinutesBetween("2026-11-13T17:00:00Z", "2026-11-16T10:30:00Z")).toBe(150);
    expect(leadLate("2026-11-13T17:00:00Z", "2026-11-16T09:59:00Z")).toBe(false);
    expect(leadLate("2026-11-13T17:00:00Z", "2026-11-16T10:01:00Z")).toBe(true);
    // A lead on Saturday morning is not late until Monday 11:00.
    expect(leadLate("2026-11-14T08:00:00Z", "2026-11-16T10:59:00Z")).toBe(false);
    expect(leadLate("2026-11-14T08:00:00Z", "2026-11-16T11:01:00Z")).toBe(true);
  });

  it("uses London hours in summer: 09:00 BST is 08:00 UTC", () => {
    expect(workingMinutesBetween("2026-07-06T07:00:00Z", "2026-07-06T09:00:00Z")).toBe(60);
    expect(workingMinutesBetween("2026-07-06T16:00:00Z", "2026-07-06T18:00:00Z")).toBe(60);
  });

  it("an unknown arrival is never late", () => {
    expect(leadLate(null, "2026-11-16T11:01:00Z")).toBe(false);
  });
});
