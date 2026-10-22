import { describe, expect, it } from "vitest";
import {
  EUR_GBP, FUNNEL_STEPS, TARGETS,
  biggestDrop, fillRate, freshness, funnelEnd, funnelSteps, funnelWeeks, isWeekComplete, lastCompleteWeek, longDayLabel,
  monthPosition, pace, shortPounds, snapshotSum, toGbp, weekOf, weekRange, windowRate,
} from "./home-metrics";
import type { MetricKey, PulseWeek } from "./marketplace-pulse";

const week = (week_start: string, values: Partial<Record<MetricKey, number>>): PulseWeek => ({ week_start, values });

// Thursday 22 October 2026; the collector last ran on Sunday 18 October.
const NOW = new Date("2026-10-22T15:00:00Z");

// The real snapshot weeks, 10 Aug to 12 Oct.
const F = {
  visitors: [254, 234, 137, 85, 95, 101, 110, 113, 142, 97],
  viewed_listing: [115, 110, 83, 49, 62, 64, 71, 66, 94, 50],
  started_contact: [7, 8, 1, 2, 8, 1, 8, 5, 6, 14],
  sent_contact: [1, 4, 1, 1, 6, 1, 4, 1, 4, 3],
  deals_paid: [1, 0, 0, 0, 0, 0, 0, 2, 0, 0],
};
const WEEKS: PulseWeek[] = weekRange("2026-10-12", 10).map((start, i) =>
  week(start, Object.fromEntries(Object.entries(F).map(([k, v]) => [k, v[i]]))));

describe("targets", () => {
  it("holds only the four agreed targets, each with a source", () => {
    expect(Object.values(TARGETS).map((t) => [t.key, t.value, t.source])).toEqual([
      ["marketplace_paid", 4, "Pulse"],
      ["bulk_closed", 2, "19 Oct call"],
      ["fees_long_term", 10_000, "7 Sep call"],
      ["seller_reply", 1, "Pulse"],
    ]);
  });
});

describe("weeks", () => {
  it("buckets timestamps into Monday-start UTC weeks", () => {
    expect(weekOf("2026-10-19T00:00:00Z")).toBe("2026-10-19");
    expect(weekOf("2026-10-25T23:59:59Z")).toBe("2026-10-19");
    expect(weekOf("2026-10-18T23:59:59Z")).toBe("2026-10-12");
    // 20:00 on Sunday in Guatemala is already Monday in UTC.
    expect(weekOf("2026-10-18T20:00:00-06:00")).toBe("2026-10-19");
  });

  it("counts a week as complete once its Monday plus seven days has passed", () => {
    expect(isWeekComplete("2026-10-12", new Date("2026-10-18T23:59:59Z"))).toBe(false);
    expect(isWeekComplete("2026-10-12", new Date("2026-10-19T00:00:00Z"))).toBe(true);
    expect(lastCompleteWeek(NOW)).toBe("2026-10-12");
  });
});

describe("month and pace", () => {
  it("places today in the month", () => {
    expect(monthPosition(NOW)).toMatchObject({ month: "2026-10", day: 22, days_in_month: 31 });
    expect(longDayLabel(NOW)).toBe("Thursday 22 October");
  });

  it("works out where an even month would be by today", () => {
    expect(pace(1, 4, NOW)).toMatchObject({ pace: 2.8, to_go: 3 });
    expect(pace(0, 2, NOW)).toMatchObject({ pace: 1.4, to_go: 2 });
    expect(pace(5, 4, NOW).to_go).toBe(0);
    expect(pace(0, 4, NOW).share_of_month).toBeCloseTo(22 / 31);
  });
});

describe("money", () => {
  it("converts euros with the one configured rate and refuses unknown currencies", () => {
    expect(EUR_GBP).toBe(0.86);
    expect(toGbp(400, "eur")).toBeCloseTo(344);
    expect(toGbp(155, "GBP")).toBe(155);
    expect(toGbp(155, null)).toBe(155);
    expect(toGbp(100, "usd")).toBeNull();
  });

  it("shortens pounds for cards", () => {
    expect(shortPounds(24_618.4)).toBe("£24.6k");
    expect(shortPounds(6926.6)).toBe("£6.9k");
    expect(shortPounds(155)).toBe("£155");
  });
});

describe("freshness", () => {
  it("is stale after 36 hours or when nothing was collected", () => {
    expect(freshness("2026-10-18T08:40:59Z", NOW).stale).toBe(true);
    expect(freshness("2026-10-21T08:00:00Z", NOW).stale).toBe(false);
    expect(freshness(null, NOW)).toEqual({ collected_at: null, hours_old: null, stale: true });
  });
});

describe("funnel", () => {
  it("ends at the latest complete week with numbers, not the current partial week", () => {
    expect(funnelEnd(WEEKS, NOW)).toBe("2026-10-12");
    expect(funnelEnd([...WEEKS, week("2026-10-19", { visitors: 40 })], NOW)).toBe("2026-10-12");
    expect(funnelEnd([], NOW)).toBeNull();
    expect(funnelEnd([week("2026-10-12", { listings_live: 3 })], NOW)).toBeNull();
  });

  it("charts from the first week with numbers, up to thirteen weeks", () => {
    const weeks = funnelWeeks(WEEKS, "2026-10-12");
    expect(weeks[0]).toBe("2026-08-10");
    expect(weeks).toHaveLength(10);
    expect(funnelWeeks(WEEKS, "2026-10-12", 4)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
  });

  it("compares the last four weeks with the four before", () => {
    const steps = funnelSteps(WEEKS, "2026-10-12", funnelWeeks(WEEKS, "2026-10-12"));
    const send = steps.find((s) => s.key === "start_send")!;
    expect(send.current).toEqual({ num: 12, den: 33, rate: 12 / 33 });
    expect(send.previous).toEqual({ num: 9, den: 12, rate: 0.75 });
    expect(Math.round(send.current.rate! * 100)).toBe(36);
    expect(Math.round(send.delta_pts!)).toBe(-39);
    const view = steps.find((s) => s.key === "visit_view")!;
    expect(view.current).toMatchObject({ num: 281, den: 462 });
    expect(view.previous).toMatchObject({ num: 258, den: 418 });
    expect(send.weekly.at(-1)).toEqual({ week_start: "2026-10-12", den: 14, num: 3 });
  });

  it("treats a missing week as adding nothing, and has no rate without anyone entering", () => {
    const rate = windowRate(FUNNEL_STEPS[2], [week("2026-10-12", { started_contact: 4, sent_contact: 1 })], ["2026-10-05", "2026-10-12"]);
    expect(rate).toEqual({ num: 1, den: 4, rate: 0.25 });
    expect(windowRate(FUNNEL_STEPS[2], [], ["2026-10-12"]).rate).toBeNull();
  });

  it("flags the step that fell most, ignoring steps too small to judge and steps that rose", () => {
    const steps = funnelSteps(WEEKS, "2026-10-12", []);
    expect(biggestDrop(steps)).toBe("start_send");
    // With only three starts in the last four weeks, start to send is too small to call.
    const small = steps.map((s) => (s.key === "start_send" ? { ...s, current: { ...s.current, den: 3 } } : s));
    expect(biggestDrop(small)).toBe("visit_view");
    expect(biggestDrop(steps.map((s) => ({ ...s, delta_pts: 4 })))).toBeNull();
    expect(biggestDrop(steps.map((s) => ({ ...s, delta_pts: null })))).toBeNull();
  });

  it("reads the fill rate as paid over sent", () => {
    expect(fillRate(WEEKS, funnelWeeks(WEEKS, "2026-10-12"))).toEqual({ num: 3, den: 26, rate: 3 / 26 });
  });

  it("adds a snapshot metric from a week on, or has no data", () => {
    expect(snapshotSum(WEEKS, "sent_contact", "2026-10-05")).toBe(7);
    expect(snapshotSum(WEEKS, "reply_24h", "2026-08-01")).toBeNull();
  });
});
