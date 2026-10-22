import { describe, expect, it } from "vitest";
import {
  TARGETS, WATCH, ageLabel, aboutPounds, bottleneck, buildHome, freshness, goal, isWeekComplete, lastCompleteWeek,
  monthTotal, needsYou, series, statusFor, targetCards, watchItems, weekValue,
} from "./home-metrics";
import type { FollowUp, MetricKey, PulseWeek, WaitingItem } from "./marketplace-pulse";

const week = (week_start: string, values: Partial<Record<MetricKey, number>>): PulseWeek => ({ week_start, values });
const def = (key: string) => TARGETS.find((t) => t.key === key)!;

// Thursday 22 October 2026; the collector last ran on Sunday 18 October.
const NOW = new Date("2026-10-22T15:00:00Z");
const COLLECTED = "2026-10-18T08:40:59Z";
const WEEKS = [
  week("2026-09-21", { viewed_listing: 71, sent_contact: 4, started_contact: 8, reply_intents: 4, reply_24h: 1, reply_none: 3, deals_created: 0, deals_paid: 0, paid_value_gbp: 0 }),
  week("2026-09-28", { viewed_listing: 66, sent_contact: 1, started_contact: 5, reply_intents: 0, reply_24h: 0, deals_created: 1, deals_paid: 2, paid_value_gbp: 4990 }),
  week("2026-10-05", { viewed_listing: 94, sent_contact: 4, started_contact: 6, reply_intents: 5, reply_24h: 1, deals_created: 0, deals_paid: 0, paid_value_gbp: 0, listings_live: 542 }),
  week("2026-10-12", { viewed_listing: 50, sent_contact: 3, started_contact: 14, reply_intents: 4, reply_24h: 0, reply_none: 3, deals_created: 0, deals_paid: 0, paid_value_gbp: 0, listings_live: 893, drop_contact_error: 0, drop_search_no_exact: 3 }),
];

describe("weeks", () => {
  it("counts a week as complete once its Monday plus seven days has passed, in UTC", () => {
    expect(isWeekComplete("2026-10-12", new Date("2026-10-18T23:59:59Z"))).toBe(false);
    expect(isWeekComplete("2026-10-12", new Date("2026-10-19T00:00:00Z"))).toBe(true);
    expect(lastCompleteWeek(NOW)).toBe("2026-10-12");
    expect(lastCompleteWeek(new Date("2026-10-19T00:00:00Z"))).toBe("2026-10-12");
    expect(lastCompleteWeek(new Date("2026-10-18T23:00:00Z"))).toBe("2026-10-05");
  });

  it("leaves gaps for weeks without data instead of zeros", () => {
    const points = series(def("viewed"), [WEEKS[0], WEEKS[3]], "2026-10-12", 4);
    expect(points.map((p) => p.week_start)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(points.map((p) => p.value?.value ?? null)).toEqual([71, null, null, 50]);
  });
});

describe("values", () => {
  it("reads ratios as x of y, and has no data when nobody asked", () => {
    expect(weekValue(def("reply"), WEEKS[3])).toEqual({ value: 0, numerator: 0, denominator: 4 });
    expect(weekValue(def("reply"), WEEKS[1])).toBeNull();
    expect(weekValue(def("reply"), week("2026-10-12", { reply_24h: 1 }))).toBeNull();
    expect(weekValue(def("viewed"), week("2026-10-12", {}))).toBeNull();
    expect(weekValue(def("viewed"), undefined)).toBeNull();
  });

  it("subtracts for started but not sent", () => {
    expect(weekValue(WATCH[0], WEEKS[3])).toEqual({ value: 11, numerator: 11, denominator: 14 });
  });
});

describe("month attribution", () => {
  it("counts each week in the month its Monday falls in", () => {
    // The week of 28 September holds 2 paid deals; it belongs to September even though it runs into October.
    expect(monthTotal(WEEKS, "deals_paid", "2026-10")).toBe(0);
    expect(monthTotal(WEEKS, "deals_paid", "2026-09")).toBe(2);
    expect(monthTotal(WEEKS, "deals_paid", "2026-11")).toBeNull();
  });

  it("builds the goal strip for the month to date", () => {
    const g = goal(WEEKS, NOW);
    expect(g).toMatchObject({
      month: "2026-10", month_label: "October", paid: 0, target: 4, paid_value_gbp: 0, deals_created: 0,
      last_month_label: "September", last_month_paid: 2, last_month_paid_value_gbp: 4990,
    });
    expect(g.pace).toBeCloseTo(22 / 31);
    expect(goal([], NOW).paid).toBeNull();
  });

  it("writes paid values as estimates", () => {
    expect(aboutPounds(0)).toBe("about £0");
    expect(aboutPounds(4990)).toBe("about £5k");
    expect(aboutPounds(null)).toBe("No data yet");
  });
});

describe("status and freshness", () => {
  it("uses the thresholds, with stale data winning", () => {
    expect(statusFor(1, false)).toBe("on-target");
    expect(statusFor(0.75, false)).toBe("close");
    expect(statusFor(0.74, false)).toBe("behind");
    expect(statusFor(null, false)).toBe("no-data");
    expect(statusFor(1.2, true)).toBe("stale");
  });

  it("is stale after 36 hours, or with no collection at all", () => {
    expect(freshness("2026-10-21T04:00:00Z", NOW).stale).toBe(false);
    expect(freshness("2026-10-21T02:59:00Z", NOW).stale).toBe(true);
    expect(freshness(COLLECTED, NOW)).toMatchObject({ stale: true, collected_at: COLLECTED });
    expect(freshness(null, NOW).stale).toBe(true);
  });
});

describe("cards and bottleneck", () => {
  it("shows last complete week against each target", () => {
    const cards = targetCards(WEEKS, NOW, "2026-10-22T06:00:00Z");
    expect(cards.map((c) => [c.key, c.value_label, c.status])).toEqual([
      ["viewed", "50", "behind"],
      ["sent", "3", "behind"],
      ["reply", "0 of 4", "behind"],
      ["deals_created", "0", "behind"],
      ["deals_paid", "0", "behind"],
    ]);
    expect(cards[0].history).toHaveLength(12);
    expect(targetCards(WEEKS, NOW, COLLECTED).every((c) => c.status === "stale")).toBe(true);
    expect(targetCards([], NOW, "2026-10-22T06:00:00Z").map((c) => c.value_label)).toEqual(Array(5).fill("No data yet"));
  });

  it("names the target furthest behind, reply rate first on a tie", () => {
    const b = bottleneck(targetCards(WEEKS, NOW, COLLECTED), WEEKS[3]);
    expect(b).toMatchObject({
      kind: "behind", key: "reply",
      sentence: "Buyers answered within 24 hours: 0 of 4 last week (target: all)",
      reason: "3 of last week's 4 buyer questions and offers have had no reply at all.",
    });
  });

  it("follows the precedence when shares tie, and skips targets without data", () => {
    const tied = targetCards([week("2026-10-12", { viewed_listing: 50, sent_contact: 2.5, deals_created: 1, deals_paid: 1 })], NOW, COLLECTED);
    // viewed 50%, sent 50%, created 50%; reply has no data.
    expect(bottleneck(tied)).toMatchObject({ key: "sent", reason: "Furthest behind of the five targets, at 50% of target." });
    const met = targetCards([week("2026-10-12", { viewed_listing: 120, sent_contact: 5, deals_created: 2, deals_paid: 1 })], NOW, COLLECTED);
    expect(bottleneck(met).kind).toBe("on-target");
    expect(bottleneck(targetCards([], NOW, COLLECTED)).kind).toBe("no-data");
  });
});

describe("watch list", () => {
  it("compares with the week before, and live listings with the observation before", () => {
    const items = watchItems(WEEKS, NOW);
    expect(items.map((i) => [i.key, i.value_label, i.comparison])).toEqual([
      ["started_not_sent", "11 of 14", "Up from 2 of 6 the week before"],
      ["send_errors", "0", null],
      ["search_no_exact", "3", null],
      ["listings_live", "893", "Up from 542"],
    ]);
  });
});

describe("needs you", () => {
  const waiting: WaitingItem = {
    kind: "offer", text: "Offer GBP 900", buyer: "Volt Ltd", seller: "Seller Co", listing_title: "Kia packs",
    listing_url: "https://rebattery.io/marketplace/kia", at: "2026-10-10T09:00:00Z", expires_at: null,
  };
  const followUp = (key: string, at: string, contacted_since: boolean): FollowUp => ({
    key, name: key, email: `${key}@example.com`, person_id: `p-${key}`, first_name: null, subscribed: false, opted_out: false,
    last_contact: null, contacted_since, more: 0, similar: [],
    latest: { kind: "chat", status: "", text: "Messaged about a listing", listing_title: "Kia packs", listing_url: null, at },
  });

  it("puts the stale alert first, then oldest first, at most seven", () => {
    const { items, total } = needsYou({
      now: NOW, collectedAt: COLLECTED,
      weeks: [week("2026-10-12", { drop_contact_error: 2 })],
      waiting: [waiting],
      followUps: [
        followUp("newer", "2026-10-20T00:00:00Z", false),
        followUp("done", "2026-10-01T00:00:00Z", true),
        ...Array.from({ length: 6 }, (_, i) => followUp(`old${i}`, `2026-10-0${i + 1}T00:00:00Z`, false)),
      ],
    });
    expect(total).toBe(10);
    expect(items).toHaveLength(7);
    expect(items[0]).toMatchObject({ tag: "DATA", title: "Marketplace numbers are stale since 18 Oct", severity: "high", owner: "Ari" });
    expect(items.slice(1).map((i) => i.id)).toEqual(["follow-up:old0", "follow-up:old1", "follow-up:old2", "follow-up:old3", "follow-up:old4", "follow-up:old5"]);
    expect(items.some((i) => i.id === "follow-up:done")).toBe(false);
  });

  it("raises send errors and waiting offers from data, and nothing when all is well", () => {
    const { items } = needsYou({ now: NOW, collectedAt: "2026-10-22T06:00:00Z", weeks: [week("2026-10-12", { drop_contact_error: 2 })], waiting: [waiting], followUps: [] });
    expect(items.map((i) => [i.tag, i.title])).toEqual([
      ["REPLY", "Volt Ltd: offer not answered"],
      ["ERROR", "2 buyers hit an error sending a message, offer or buy"],
    ]);
    expect(needsYou({ now: NOW, collectedAt: "2026-10-22T06:00:00Z", weeks: WEEKS, waiting: [], followUps: [] }).items).toEqual([]);
  });

  it("labels ages briefly", () => {
    expect(ageLabel(COLLECTED, NOW)).toBe("4d");
    expect(ageLabel("2026-10-22T10:00:00Z", NOW)).toBe("5h");
  });
});

describe("buildHome", () => {
  it("assembles the payload", () => {
    const home = buildHome({ now: NOW, weeks: WEEKS, collectedAt: COLLECTED, waiting: [], followUps: [], followUpError: null });
    expect(home.last_week).toBe("2026-10-12");
    expect(home.freshness.stale).toBe(true);
    expect(home.bottleneck).toMatchObject({ key: "reply" });
    expect(home.needs_you.map((i) => i.tag)).toEqual(["DATA"]);
  });
});
