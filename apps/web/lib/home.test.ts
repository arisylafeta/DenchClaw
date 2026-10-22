import { describe, expect, it } from "vitest";
import { buildHome, healthItems, overviewReading, stepReading, teaserNote, type Segment } from "./home";
import { freshness, funnelSteps, funnelWeeks, weekRange } from "./home-metrics";
import type { PlatformHome } from "./home-platform";
import type { BulkHome } from "./home-bulk";
import type { MetricKey, PulseWeek } from "./marketplace-pulse";

const NOW = new Date("2026-10-22T15:00:00Z");
const COLLECTED = "2026-10-18T08:40:59Z";
const text = (segments: Segment[]) => segments.map((s) => (typeof s === "string" ? s : s.strong)).join("");

const F = {
  visitors: [254, 234, 137, 85, 95, 101, 110, 113, 142, 97],
  viewed_listing: [115, 110, 83, 49, 62, 64, 71, 66, 94, 50],
  started_contact: [7, 8, 1, 2, 8, 1, 8, 5, 6, 14],
  sent_contact: [1, 4, 1, 1, 6, 1, 4, 1, 4, 3],
  deals_paid: [1, 0, 0, 0, 0, 0, 0, 2, 0, 0],
  reply_intents: [1, 4, 0, 1, 3, 0, 4, 0, 5, 4],
  reply_24h: [0, 1, 0, 1, 0, 0, 1, 0, 1, 0],
};
const WEEKS: PulseWeek[] = weekRange("2026-10-12", 10).map((week_start, i) =>
  ({ week_start, values: Object.fromEntries(Object.entries(F).map(([k, v]) => [k as MetricKey, v[i]])) }));

const PLATFORM: PlatformHome = {
  paid_this_month: 1,
  last_paid_at: "2026-10-02T15:33:27Z",
  fees: { ytd_gbp: 24_618, month_gbp: 6926.6, top_share: 0.966, top_deal_id: "d1", skipped: 0, top_label: "Pylon Technologies Co.,LTD", paid_deals_ytd: 4 },
  reply: { within: 7, later: 2, never: 14, open: 2 },
  since_deal: { last_at: "2026-10-02T15:33:25Z", days: 19, enquiries_since: 18 },
  overview: {
    weeks: weekRange("2026-10-19", 13).map((week_start, i) => ({ week_start, enquiries: i, opened: 0, paid: 0, partial: i === 12 })),
    enquiries_30d: 24, opened_30d: 1, enquiry_blocks: [5, 5, 24], opened_blocks: [1, 6, 1],
  },
};

const BULK: BulkHome = {
  closed_this_month: 0, lost_this_month: 2,
  closing: [{ title: "Oklahoma Panasonic 2170 cells", value: "$516,800" }],
  order_book: { open: 18, priced: 6, quiet: 7, buy_boxes: 22, buy_boxes_priced: 5 },
  bids: { since: "2026-09-29T20:11:19Z", total_30d: 7, firm_30d: 1, weekly: [] },
  buyers: { steps: [], teaser_passed: 6, teaser_total: 48 },
};

describe("readings", () => {
  it("reads the overview from the three 30-day blocks", () => {
    expect(text(overviewReading([5, 5, 24], [1, 6, 1]))).toBe(
      "Enquiries went 5, 5, 24 across the last three 30-day blocks. Deals opened went 1, 6, 1. Demand is arriving; it is not turning into deals.");
    expect(text(overviewReading([5, 9, 4], [1, 1, 1]))).toMatch(/Fewer buyers enquired/);
    expect(text(overviewReading([1, 2, 3], [1, 2, 3]))).toMatch(/Both are rising\.$/);
  });

  it("reads each funnel step from its numbers", () => {
    const weeks = funnelWeeks(WEEKS, "2026-10-12");
    const steps = funnelSteps(WEEKS, "2026-10-12", weeks);
    const fill = { num: 3, den: 26, rate: 3 / 26, since: "2026-08-10" };
    const by = (key: string) => steps.find((s) => s.key === key)!;
    expect(text(stepReading(by("visit_view"), false, fill))).toBe("About 6 in 10 visitors open a listing in both periods. Reach is not the constraint.");
    expect(text(stepReading(by("view_start"), false, fill))).toBe("Starts went from 12 to 33 in the last 4 weeks. More than double.");
    expect(text(stepReading(by("start_send"), true, fill))).toBe(
      "Starts went from 12 to 33, sends from 9 to 12. Week of 12 Oct: 14 started, 3 sent. Fix the send step before buying traffic.");
    expect(text(stepReading(by("start_send"), false, fill))).not.toMatch(/Fix/);
    expect(text(stepReading(by("send_paid"), false, fill))).toBe("3 paid of 26 sent since 10 Aug. One more paid deal needs about 9 more sent at this rate.");
    expect(text(stepReading({ ...by("send_paid"), current: { num: 0, den: 0, rate: null }, previous: { num: 0, den: 0, rate: null } }, false, fill)))
      .toBe("No data yet for this step.");
  });

  it("notes teaser pass-through, and calls the leak only when few get past", () => {
    expect(teaserNote(7, 49)).toBe("7 of 49 buyers who got a teaser moved past it (14%). Teaser to NDA is the leak.");
    expect(teaserNote(5, 10)).toBe("5 of 10 buyers who got a teaser moved past it (50%).");
    expect(teaserNote(0, 0)).toBeNull();
  });
});

describe("data health", () => {
  it("flags a stale collector, the PostHog undercount and differing reply counts, then the counting rules", () => {
    const items = healthItems({ funnel: freshness(COLLECTED, NOW), reply: PLATFORM.reply, weeks: WEEKS, platformError: null, crmError: null, skippedFees: 0 });
    expect(items.map((i) => `${i.title ?? ""} ${i.text}`.trim())).toEqual([
      "Weekly funnel stale since 18 Oct (collector stopped)",
      "Visitors about half of real traffic since the 27 Aug consent change",
      "Reply counts differ: live 7 of 23, snapshots 4 of 22",
      "Paid deals counted by payment date, not by week as in Pulse. Euro fees at 0.86 to the pound. Open lots leave out On hold.",
    ]);
  });

  it("names a missing source, and skips the reply comparison without both counts", () => {
    const items = healthItems({ funnel: freshness("2026-10-22T08:00:00Z", NOW), reply: null, weeks: [], platformError: "Could not read ReBattery", crmError: null, skippedFees: 2 });
    expect(items[0]).toMatchObject({ warn: true, title: "Platform numbers missing:" });
    expect(items.some((i) => i.title === "Reply counts differ:")).toBe(false);
    expect(items.some((i) => i.title === "Weekly funnel stale")).toBe(false);
    expect(items.some((i) => i.title === "Fees left out:")).toBe(true);
  });
});

describe("buildHome", () => {
  it("assembles the page", () => {
    const home = buildHome({ now: NOW, weeks: WEEKS, collectedAt: COLLECTED, platform: PLATFORM, platformError: null, bulk: BULK, crmError: null });
    expect(home.header).toMatchObject({ date: "Thursday 22 October", day: 22, days_in_month: 31, platform_to: NOW.toISOString() });
    expect(home.header.funnel.stale).toBe(true);
    expect(home.header.targets).toEqual([{ label: "4 paid a month", source: "Pulse" }, { label: "2 bulk a month", source: "19 Oct call" }]);
    expect(home.marketplace).toMatchObject({ paid: 1, pace: { target: 4, pace: 2.8, to_go: 3 }, last_paid_days: 19 });
    expect(home.marketplace?.fill).toEqual({ num: 3, den: 26, rate: 3 / 26, since: "2026-08-10" });
    expect(home.bulk_goal).toMatchObject({ closed: 0, pace: { target: 2, pace: 1.4, to_go: 2 }, lost: 2, month_label: "October" });
    expect(home.fees).toMatchObject({ ytd_gbp: 24_618, month_label: "October", goal_label: "£10k a month", goal_source: "7 Sep call" });
    expect(home.reply).toMatchObject({ within: 7, later: 2, never: 14, open: 2, since: "2026-08-01", target_label: "all" });
    expect(home.overview?.no_deal_since).toBe("2026-10-02T15:33:25Z");
    expect(home.funnel?.biggest_drop).toBe("start_send");
    expect(home.funnel?.weeks[0]).toBe("2026-08-10");
    expect(home.bulk?.teaser_note).toMatch(/^6 of 48/);
    expect(home.errors).toEqual({ platform: null, crm: null });
  });

  it("does not call out a quiet spell shorter than two weeks", () => {
    const home = buildHome({ now: NOW, weeks: WEEKS, collectedAt: COLLECTED, platform: { ...PLATFORM, since_deal: { ...PLATFORM.since_deal!, days: 6 } }, platformError: null, bulk: BULK, crmError: null });
    expect(home.overview?.no_deal_since).toBeNull();
  });

  it("keeps the CRM parts when the platform cannot be read, and the reverse", () => {
    const noPlatform = buildHome({ now: NOW, weeks: WEEKS, collectedAt: COLLECTED, platform: null, platformError: "down", bulk: BULK, crmError: null });
    expect(noPlatform).toMatchObject({ marketplace: null, fees: null, reply: null, since_deal: null, overview: null });
    expect(noPlatform.header.platform_to).toBeNull();
    expect(noPlatform.bulk_goal?.closed).toBe(0);
    expect(noPlatform.funnel?.steps).toHaveLength(4);

    const noCrm = buildHome({ now: NOW, weeks: [], collectedAt: null, platform: PLATFORM, platformError: null, bulk: null, crmError: "down" });
    expect(noCrm).toMatchObject({ bulk_goal: null, bulk: null, funnel: null });
    expect(noCrm.marketplace?.paid).toBe(1);
    expect(noCrm.marketplace?.fill).toBeNull();
    expect(noCrm.errors.crm).toBe("down");
  });
});
