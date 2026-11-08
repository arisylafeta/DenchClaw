import { describe, expect, it } from "vitest";
import { londonInputValue, londonWallToUtc, sendAtProblem, sendLabel, sendSlots } from "./relay-send-time";

describe("londonWallToUtc", () => {
  it("uses GMT in winter and BST in summer", () => {
    expect(londonWallToUtc("2026-11-09", "08:00").toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(londonWallToUtc("2026-07-06", "08:00").toISOString()).toBe("2026-07-06T07:00:00.000Z");
  });
});

describe("sendSlots", () => {
  it("Sunday night offers Monday 8:00 and 10:00", () => {
    const now = new Date("2026-11-08T22:30:00Z"); // Sun 22:30 London
    expect(sendSlots(now)).toEqual([
      { at: "2026-11-09T08:00:00.000Z", label: "Tomorrow 8:00" },
      { at: "2026-11-09T10:00:00.000Z", label: "Tomorrow 10:00" },
    ]);
  });

  it("after midnight the next morning is today", () => {
    const now = new Date("2026-11-09T00:40:00Z"); // Mon 00:40 London
    expect(sendSlots(now).map((s) => s.label)).toEqual(["Today 8:00", "Today 10:00"]);
  });

  it("Friday evening adds Monday 8:00", () => {
    const now = new Date("2026-11-13T21:00:00Z"); // Fri
    const slots = sendSlots(now);
    expect(slots.map((s) => s.label)).toEqual(["Tomorrow 8:00", "Tomorrow 10:00", "Mon 8:00"]);
    expect(slots[2].at).toBe("2026-11-16T08:00:00.000Z");
  });

  it("Saturday evening adds Monday 8:00 after Sunday", () => {
    const slots = sendSlots(new Date("2026-11-14T21:00:00Z"));
    expect(slots.map((s) => s.label)).toEqual(["Tomorrow 8:00", "Tomorrow 10:00", "Mon 8:00"]);
  });

  it("summer times are London times", () => {
    expect(sendSlots(new Date("2026-07-05T21:00:00Z"))[0]).toEqual({ at: "2026-07-06T07:00:00.000Z", label: "Tomorrow 8:00" });
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

  it("round-trips a datetime-local value", () => {
    const at = new Date("2026-07-06T07:00:00Z");
    expect(londonInputValue(at)).toBe("2026-07-06T08:00");
  });
});
