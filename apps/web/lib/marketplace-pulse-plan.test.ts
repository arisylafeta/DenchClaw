import { describe, expect, it } from "vitest";
import type { Breakdown, PulseWeek } from "./marketplace-pulse";
import { actualSeries, baseline, measure, paidPerMonth, parsePlan, planPath, sensitivity, standing, waterfall, type Lever, type Plan } from "./marketplace-pulse-plan";

const week = (week_start: string, values: PulseWeek["values"]): PulseWeek => ({ week_start, values });
const row = (week_start: string, metric: string, value: number, dimension = "All"): Breakdown => ({ week_start, metric, dimension, value });

const LEVERS: Lever[] = [
  { id: "a", name: "Answer", owner: "Alex", status: "Done", steps: { deal: 0.45 } },
  { id: "c", name: "Channels", owner: "Ari", status: "Planned", steps: { visitors: 600, started: 0.1 } },
];
const PLAN: Plan = { target_paid: 9, target_date: "2027-01-05", start: { date: "2026-10-06", paid: 2 }, levers: LEVERS, channels: [] };

describe("growth plan maths", () => {
  it("measures today's rates from the last four weeks with funnel rows, as a month", () => {
    const weeks = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"].map((d, i) =>
      week(d, { deals_created: i ? 1 : 50, deals_paid: i === 4 ? 1 : 0, reply_intents: 2, reply_24h: 1, reply_none: 1 }));
    const rows = weeks.slice(1).flatMap((w) => [row(w.week_start, "funnel_reached", 100), row(w.week_start, "funnel_viewed", 60),
      row(w.week_start, "funnel_started", 5), row(w.week_start, "funnel_sent", 3)]);
    const m = measure(weeks, rows);
    expect(m.weeks).toBe(4);
    // 400 people in 4 weeks is about 435 a month; the first week has no funnel rows, so its 50 deals are left out.
    expect(m.rates.visitors).toBeCloseTo(434.9, 1);
    expect(m.rates).toMatchObject({ viewed: 0.6, started: 5 / 60, sent: 0.6, deal: 4 / 12, paid: 0.25 });
    expect(m.fill).toBeCloseTo(1 / 12);
    expect(m.reply).toMatchObject({ within24h: 0.5, asked: 8, unanswered: 4 });
  });

  it("adds up each fix in order and ends at the plan", () => {
    const start = baseline({ visitors: 400, viewed: 0.6, started: 0.08, sent: 0.5, deal: 0.3, paid: 0.67 }, LEVERS).rates;
    expect(paidPerMonth(start)).toBeCloseTo(1.93, 2);
    const { steps, final } = waterfall(start, LEVERS);
    // 1.93 → 2.89 when every buyer is answered, → 5.43 with the channels fix.
    expect(steps.map((s) => Math.round(s.delta * 100) / 100)).toEqual([0.96, 2.53]);
    expect(paidPerMonth(final)).toBeCloseTo(5.427, 3);
    const s = sensitivity(final);
    // One point more on 'started' (10% to 11%) adds a tenth of the plan's deals.
    expect(s.started).toBeCloseTo(paidPerMonth(final) / 10, 5);
    expect(s.visitors).toBeCloseTo(paidPerMonth(final) / 10, 5);
  });

  it("never lets a fix lower a step", () => {
    const start = baseline({ visitors: 400, viewed: 0.6, started: 0.08, sent: 0.5, deal: 0.6, paid: 0.67 }, LEVERS).rates;
    const { steps, final } = waterfall(start, LEVERS);
    // Deals already at 60%, above the fix's 45%: the fix adds nothing.
    expect(steps[0].delta).toBe(0);
    expect(final.deal).toBe(0.6);
  });

  it("fills a step with no data from the first fix that sets it, and says which are assumed or missing", () => {
    expect(baseline({ visitors: 100 }, LEVERS)).toEqual({
      rates: { visitors: 100, viewed: 0, started: 0.1, sent: 0, deal: 0.45, paid: 0 },
      assumed: ["started", "deal"],
      missing: ["viewed", "sent", "paid"],
    });
  });

  it("flags rates over 100% instead of capping them", () => {
    const weeks = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"].map((d) => week(d, { deals_created: 3, deals_paid: 1 }));
    const rows = weeks.flatMap((w) => [row(w.week_start, "funnel_reached", 10), row(w.week_start, "funnel_viewed", 5),
      row(w.week_start, "funnel_started", 2), row(w.week_start, "funnel_sent", 1)]);
    const m = measure(weeks, rows);
    expect(m.rates.deal).toBe(3);
    expect(m.over).toEqual(["deal"]);
  });

  it("draws a straight path to the target and says how we stand", () => {
    expect(planPath(PLAN, "2026-10-06")).toBe(2);
    expect(planPath(PLAN, "2026-01-01")).toBe(2);
    expect(planPath(PLAN, "2027-03-01")).toBe(9);
    expect(planPath(PLAN, "2026-11-20")).toBeCloseTo(2 + 7 * (45 / 91), 5);
    expect([standing(4, 4), standing(3, 4), standing(2, 4), standing(null, 4)]).toEqual(["On track", "Slightly behind", "Off track", "Not enough weeks yet"]);
  });

  it("turns weekly paid deals into a rolling four-week monthly rate, skipping windows with a missing week", () => {
    const weeks = [1, 0, 0, 1, 2].map((paid, i) => week(new Date(Date.UTC(2026, 7, 31 + 7 * i)).toISOString().slice(0, 10), { deals_paid: paid }));
    expect(actualSeries(weeks).map((p) => Math.round(p.paid * 100) / 100)).toEqual([2.17, 3.26]);
    // Drop the third week: no window of four whole weeks is left.
    expect(actualSeries(weeks.filter((_, i) => i !== 2))).toEqual([]);
  });

  it("refuses plans that cannot be right", () => {
    expect(parsePlan(PLAN)).toEqual({ plan: PLAN });
    expect(parsePlan({ ...PLAN, target_date: "2026-01-01" })).toEqual({ error: "The target date must be after the start." });
    expect(parsePlan({ ...PLAN, levers: [{ ...LEVERS[0], steps: { deal: 1.5 } }] })).toMatchObject({ error: expect.stringContaining("between 0% and 100%") });
    expect(parsePlan({ ...PLAN, levers: [{ ...LEVERS[0], steps: { price: 0.5 } }] })).toMatchObject({ error: expect.stringContaining("unknown step") });
    expect(parsePlan({ ...PLAN, channels: [{ channel: "TikTok", goal: 1, owner: "", action: "" }] })).toMatchObject({ error: expect.stringContaining("Unknown channel") });
    expect(parsePlan({ ...PLAN, target_paid: 0 })).toMatchObject({ error: expect.stringContaining("more than 0") });
    expect(parsePlan({ ...PLAN, target_paid: Number.NaN })).toMatchObject({ error: expect.stringContaining("more than 0") });
    expect(parsePlan({ ...PLAN, target_date: "2027-02-31" })).toMatchObject({ error: expect.stringContaining("must be a date") });
    expect(parsePlan({ ...PLAN, target_date: "2099-01-01" })).toMatchObject({ error: expect.stringContaining("three years") });
    const twins = parsePlan({ ...PLAN, levers: [LEVERS[0], { ...LEVERS[1], id: "a" }] });
    expect("plan" in twins && twins.plan.levers.map((l) => l.id)).toEqual(["a", "fix-2-1"]);
  });
});
