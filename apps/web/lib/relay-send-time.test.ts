import { describe, expect, it } from "vitest";
import { londonInputValue, londonWallToUtc, sendAtProblem, sendLabel, sendSlots, snoozeSlots, undoSecondsLeft } from "./relay-send-time";

describe("londonWallToUtc", () => {
  it("uses GMT in winter and BST in summer", () => {
    expect(londonWallToUtc("2026-11-09", "08:00").toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(londonWallToUtc("2026-07-06", "08:00").toISOString()).toBe("2026-07-06T07:00:00.000Z");
  });
});

describe("sendSlots", () => {
  it("Sunday night offers tomorrow 8am, 11am and 2pm, and the day after at 8am", () => {
    const now = new Date("2026-11-08T22:30:00Z"); // Sun 22:30 London
    expect(sendSlots(now)).toEqual([
      { at: "2026-11-09T08:00:00.000Z", label: "Tomorrow 8am" },
      { at: "2026-11-09T11:00:00.000Z", label: "Tomorrow 11am" },
      { at: "2026-11-09T14:00:00.000Z", label: "Tomorrow 2pm" },
      { at: "2026-11-10T08:00:00.000Z", label: "Tue 8am" },
    ]);
  });

  it("after midnight the next morning is today", () => {
    const now = new Date("2026-11-09T00:40:00Z"); // Mon 00:40 London
    expect(sendSlots(now).map((s) => s.label)).toEqual(["Today 8am", "Today 11am", "Today 2pm", "Tomorrow 8am"]);
  });

  it("summer times are London times", () => {
    expect(sendSlots(new Date("2026-07-05T21:00:00Z"))[0]).toEqual({ at: "2026-07-06T07:00:00.000Z", label: "Tomorrow 8am" });
  });
});

describe("sendLabel and checks", () => {
  it("labels further days with the date", () => {
    const now = new Date("2026-11-08T22:00:00Z");
    expect(sendLabel("2026-11-11T14:30:00Z", now)).toBe("Wed 14:30");
    expect(sendLabel("2026-11-20T08:00:00Z", now)).toBe("Fri 20 Nov, 8:00");
  });

  it("refuses the past and the far future", () => {
    const now = new Date("2026-11-08T22:00:00Z");
    expect(sendAtProblem(new Date("2026-11-08T21:00:00Z"), now)).toMatch(/future/);
    expect(sendAtProblem(new Date("2027-03-01T08:00:00Z"), now)).toMatch(/60 days/);
    expect(sendAtProblem(new Date("2026-11-09T08:00:00Z"), now)).toBeNull();
  });

  it("counts down a Send hold and never shows more than the hold", () => {
    const now = new Date("2026-11-09T19:00:00Z");
    expect(undoSecondsLeft("2026-11-09T19:00:29.200Z", now)).toBe(30);
    expect(undoSecondsLeft("2026-11-09T19:00:04.100Z", now)).toBe(5);
    expect(undoSecondsLeft("2026-11-09T18:59:59Z", now)).toBe(0);
    expect(undoSecondsLeft("2026-11-09T19:02:00Z", now)).toBe(30); // browser clock behind the server
  });

  it("round-trips a datetime-local value", () => {
    const at = new Date("2026-07-06T07:00:00Z");
    expect(londonInputValue(at)).toBe("2026-07-06T08:00");
  });
});

describe("snoozeSlots", () => {
  const keys = (now: string) => snoozeSlots(new Date(now)).map((s) => `${s.key} ${s.when}`);
  it("offers later today, tomorrow, next Monday and a week on a Wednesday morning", () => {
    expect(keys("2026-11-18T10:10:00Z")).toEqual(["later Today 13:30", "tomorrow Tomorrow 8:00", "monday Mon 8:00", "week Wed 25 Nov, 8:00"]);
  });
  it("drops later today in the evening, and Monday when tomorrow is Monday", () => {
    expect(keys("2026-11-22T18:00:00Z")).toEqual(["tomorrow Tomorrow 8:00", "week Sun 29 Nov, 8:00"]);
  });
  it("calls it Monday morning on a Friday", () => {
    expect(snoozeSlots(new Date("2026-11-20T11:00:00Z")).find((s) => s.key === "monday")?.label).toBe("Monday morning");
  });
});
