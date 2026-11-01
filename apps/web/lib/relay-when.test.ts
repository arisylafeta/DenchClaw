import { describe, expect, it } from "vitest";
import { describeWhen, parseWhen } from "./relay-when";

// Thursday 5 Nov 2026, 10:00 London.
const now = new Date("2026-11-05T10:00:00Z");
const day = (text: string) => parseWhen(text, now)?.date;

describe("parseWhen", () => {
  it("reads relative days", () => {
    expect(day("call him today")).toBe("2026-11-05");
    expect(day("call him tomorrow")).toBe("2026-11-06");
    expect(day("call in 3 days")).toBe("2026-11-08");
    expect(day("chase in 2 weeks")).toBe("2026-11-19");
    expect(day("next week review")).toBe("2026-11-09");
    expect(day("next month invoice")).toBe("2026-12-01");
  });
  it("reads weekdays: bare is the next one, 'next' is in next week", () => {
    expect(day("call Lubomir fri")).toBe("2026-11-06");
    expect(day("wed")).toBe("2026-11-11");
    expect(day("thu")).toBe("2026-11-12");
    expect(day("next wed")).toBe("2026-11-11");
    expect(day("next monday")).toBe("2026-11-09");
    expect(day("next friday")).toBe("2026-11-13");
    expect(day("add a to do for next wed")).toBe("2026-11-11");
  });
  it("next <weekday> from a Monday means the following week", () => {
    const monday = new Date("2026-11-09T09:00:00Z");
    expect(parseWhen("next wed", monday)?.date).toBe("2026-11-18");
    expect(parseWhen("wed", monday)?.date).toBe("2026-11-11");
  });
  it("reads dates, day first, rolling into next year when passed", () => {
    expect(day("pay 12 Nov")).toBe("2026-11-12");
    expect(day("pay Nov 12th")).toBe("2026-11-12");
    expect(day("pay 3 oct")).toBe("2027-10-03");
    expect(day("pay 12/11")).toBe("2026-11-12");
    expect(day("pay 2026-12-25")).toBe("2026-12-25");
    expect(day("pay 31 feb")).toBeUndefined();
  });
  it("reads a time and strips the date words from the title", () => {
    const w = parseWhen("call Lubomir next wed at 3pm", now)!;
    expect(w).toMatchObject({ date: "2026-11-11", time: "15:00", title: "call Lubomir" });
    expect(parseWhen("remind me to send the NDA tomorrow 9:30", now)).toMatchObject({ title: "send the NDA", time: "09:30" });
    expect(parseWhen("ping Rahul on Friday", now)?.title).toBe("ping Rahul");
  });
  it("returns null when there is no day", () => {
    expect(parseWhen("order 5 packs", now)).toBeNull();
    expect(parseWhen("see the 12 kWh pack", now)).toBeNull();
  });
  it("uses the London day around midnight", () => {
    expect(parseWhen("tomorrow", new Date("2026-06-30T23:30:00Z"))?.date).toBe("2026-07-02");
  });
  it("describes the day", () => {
    expect(describeWhen("2026-11-11", null)).toBe("Wed 11 Nov 08:00");
    expect(describeWhen("2026-11-11", "15:00")).toBe("Wed 11 Nov 15:00");
  });
});
