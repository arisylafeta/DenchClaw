import { describe, expect, it } from "vitest";
import {
  computeScorecard, decideMeasure, fullyPrepared, judgedMeasure, mondayMessage, periods, preparedMeasure, quietMeasure, quotedMeasure,
  replyMeasure, scorecardText, speedMeasure, stuckMeasure, takeMeasure, wonMeasure, worstThree,
  type EnquiryFact, type OfferFact, type ScorecardFacts,
} from "./bulk-scorecard";
import type { SheetRow } from "./bulk-sheet";

// Tuesday 15 Dec 2026, 09:00 London: the week reported is Mon 7 Dec to Mon 14 Dec, the week before 30 Nov to 7 Dec.
const NOW = new Date("2026-12-15T09:00:00Z");
const P = periods(NOW);

const facts = (part: Partial<ScorecardFacts>): ScorecardFacts => ({ enquiries: [], listings: [], sheet: [], events: [], runs: [], offers: [], ...part });
const enquiry = (o: Partial<EnquiryFact>): EnquiryFact => ({
  id: "e", arrived_at: "2026-12-07T10:00:00Z", replied_at: null, card_status: "sent", route: "bulk", sent: null, dismissed_at: null,
  deal_id: null, deal_created_at: null, ...o,
});
const offer = (o: Partial<OfferFact>): OfferFact => ({
  id: "o", side: "buyer", stage: "offered", amount: 100, quantity: null, paid_on: null, paid_amount: null, paid_currency: null, take_gbp: null,
  created_at: "2026-11-20T10:00:00Z", last_touch_on: null, events: [], mail_at: [], quote: null, match: null, sheet_sent: false, from_card: false, ...o,
});
const row = (o: Partial<SheetRow>): SheetRow => ({
  key: o.id ?? "r", id: o.id ?? "r", kind: "supply", side: "seller", title: `Lot ${o.id}`, company: null, company_id: null, category: null,
  progress: "Available", tone: "new", score: null, latest: null, next_action: null, next_due: null, owner: null, touched: null, ...o,
});
const inDate = { value: "EUR 80/kWh", status: "confirmed", validUntil: "2026-12-31" };

describe("scorecard periods", () => {
  it("reports the last full London week, the week before, and the quarter from 1 Dec", () => {
    expect(P.week).toMatchObject({ label: "Week of 7 Dec 2026", from: "2026-12-07T00:00:00.000Z", to: "2026-12-14T00:00:00.000Z" });
    expect(P.previous).toMatchObject({ from: "2026-11-30T00:00:00.000Z", to: "2026-12-07T00:00:00.000Z" });
    expect(P.quarter).toMatchObject({ from: "2026-12-01T00:00:00.000Z", to: NOW.toISOString(), started: true });
    // A summer week starts at 23:00 UTC the Sunday before; --week picks the week holding a date.
    expect(periods(NOW, "2027-06-10").week.from).toBe("2027-06-06T23:00:00.000Z");
  });

  it("says no data yet for every measure before the quarter starts and when nothing was recorded, never zero", () => {
    const card = computeScorecard(facts({}), new Date("2026-11-16T09:00:00Z"));
    expect(card.periods.quarter.started).toBe(false);
    expect(card.quarter.every((m) => m.shown === "no data yet" && m.value === null && m.met === null)).toBe(true);
    expect(card.week.map((m) => m.shown)).toEqual(Array(11).fill("no data yet"));
    expect(card.week.map((m) => m.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe("measure 1: enquiries answered within 2 working hours", () => {
  it("counts working hours only, leaves out Not a lead and ones still inside the 2 hours, and splits weeks at Monday 00:00 London", () => {
    const f = facts({ enquiries: [
      enquiry({ id: "fast", arrived_at: "2026-12-07T10:00:00Z", replied_at: "2026-12-07T11:30:00Z" }),
      // Friday 17:00 to Monday 10:00 is 2 working hours: on time.
      enquiry({ id: "weekend", arrived_at: "2026-12-11T17:00:00Z", replied_at: "2026-12-14T10:00:00Z" }),
      enquiry({ id: "slow", arrived_at: "2026-12-08T10:00:00Z", replied_at: "2026-12-08T12:30:00Z" }),
      enquiry({ id: "never", arrived_at: "2026-12-09T10:00:00Z" }),
      enquiry({ id: "not_lead", arrived_at: "2026-12-09T10:00:00Z", card_status: "dismissed" }),
      enquiry({ id: "sunday", arrived_at: "2026-12-06T23:59:00Z", replied_at: "2026-12-07T09:30:00Z" }),
      enquiry({ id: "monday", arrived_at: "2026-12-14T00:00:00Z" }),
    ] });
    expect(replyMeasure(f, P.week, NOW)).toMatchObject({ value: 50, numerator: 2, denominator: 4, shown: "50% (2 of 4)", met: false, target: "80%" });
    expect(replyMeasure(f, P.previous, NOW)).toMatchObject({ numerator: 1, denominator: 1 });
    // Friday 17:30 with no reply, seen Monday 09:30: one working hour gone, so it is not counted yet.
    const pending = facts({ enquiries: [enquiry({ arrived_at: "2026-12-11T17:30:00Z" })] });
    expect(replyMeasure(pending, P.week, new Date("2026-12-14T09:30:00Z")).shown).toBe("no data yet");
    expect(replyMeasure(pending, P.week, new Date("2026-12-14T11:00:00Z")).shown).toBe("0% (0 of 1)");
  });
});

describe("measure 2: bulk leads routed and decided within 2 working days", () => {
  it("counts a deal opened, another route sent, or Not a lead by working day 2, bulk and recycling cards only", () => {
    const f = facts({ enquiries: [
      enquiry({ id: "deal", deal_id: "bt_1", deal_created_at: "2026-12-09T15:00:00Z" }),
      enquiry({ id: "late_deal", deal_id: "bt_2", deal_created_at: "2026-12-10T09:00:00Z" }),
      enquiry({ id: "elsewhere", route: "recycling", sent: { route: { route: "jules" }, at: "2026-12-08T10:00:00Z" } }),
      enquiry({ id: "dismissed", card_status: "dismissed", dismissed_at: "2026-12-07T12:00:00Z" }),
      enquiry({ id: "undecided", sent: { route: { route: "bulk" }, at: "2026-12-07T11:00:00Z" } }),
      enquiry({ id: "small", route: "marketplace" }),
      enquiry({ id: "no_card", route: null, card_status: null }),
      enquiry({ id: "relay_said_no", card_status: "not_lead" }),
      // Linked to a deal that existed before the email: decided when the reply went with the link.
      enquiry({ id: "existing", deal_id: "bt_old", deal_created_at: "2026-10-01T10:00:00Z", sent: { route: { route: "bulk" }, deal_id: "bt_old", at: "2026-12-07T15:00:00Z" } }),
    ] });
    expect(decideMeasure(f, P.week, NOW)).toMatchObject({ numerator: 4, denominator: 6, shown: "67% (4 of 6)", met: false });
    // Arrived Friday, nothing decided yet, seen on Monday: one working day, still open, not counted.
    const pending = facts({ enquiries: [enquiry({ arrived_at: "2026-12-11T10:00:00Z" })] });
    expect(decideMeasure(pending, P.week, new Date("2026-12-14T12:00:00Z")).shown).toBe("no data yet");
  });
});

describe("measures 3 and 4: active deals and Stuck in New", () => {
  const sheet = [
    row({ id: "a", owner: "Alex", value_eur: 50_000, likelihood: 40, next_action: "Call", next_due: "2026-12-16" }),
    row({ id: "b", owner: "Sean", value_eur: 20_000, likelihood: 60, next_action: "Send terms", next_due: "2026-12-17" }),
    row({ id: "c", owner: "Alex", value_eur: null, likelihood: 40, next_action: "Chase", next_due: "2026-12-16" }),
    row({ id: "new_old", progress: "New", stage_since: "2026-12-01T09:00:00Z" }),
    row({ id: "new_fresh", progress: "New", stage_since: "2026-12-12T09:00:00Z" }),
    row({ id: "gone", progress: "Sold", closed: true }),
  ];
  it("counts active deals now and how many have owner, ticket size, chance and a dated next step; no history for earlier weeks", () => {
    const card = computeScorecard(facts({ sheet }), NOW);
    expect(card.week.find((m) => m.key === "active")).toMatchObject({ value: 3, numerator: 2, denominator: 3, shown: "3 active, 2 complete", met: false });
    expect(card.previous.find((m) => m.key === "active")?.shown).toBe("no data yet");
  });
  it("counts Stuck in New from the sheet now, and from the stage history at an earlier week's end", () => {
    expect(stuckMeasure(facts({ sheet }), true, NOW)).toMatchObject({ value: 1, met: false });
    const events = [
      { listing_id: "x", to_stage: "New", at: "2026-11-12T13:00:00Z", starting: true, created_at: "2026-11-10T09:00:00Z" },
      { listing_id: "y", to_stage: "New", at: "2026-11-21T09:00:00Z", starting: false, created_at: "2026-11-21T09:00:00Z" },
      { listing_id: "y", to_stage: "Qualified", at: "2026-12-08T09:00:00Z", starting: false, created_at: "2026-11-21T09:00:00Z" },
      { listing_id: "z", to_stage: "New", at: "2026-12-05T09:00:00Z", starting: false, created_at: "2026-12-05T09:00:00Z" },
    ];
    // At 7 Dec: x since it was made (26 days), y since 21 Nov (15 days); z only 1 day.
    expect(stuckMeasure(facts({ events }), false, new Date(P.previous.to))).toMatchObject({ value: 2 });
    expect(stuckMeasure(facts({}), false, new Date(P.previous.to)).shown).toBe("no data yet");
  });
});

describe("measure 5: match runs judged within 3 working days", () => {
  it("needs five verdicts, or all candidates when fewer, by working day 3; open runs wait", () => {
    const run = (deal: string, at: string, count: number, verdicts: string[]) => ({ deal_id: deal, at, count, verdicts });
    const f = facts({ runs: [
      run("five", "2026-12-07T10:00:00Z", 5, ["2026-12-08T10:00:00Z", "2026-12-08T11:00:00Z", "2026-12-09T10:00:00Z", "2026-12-10T10:00:00Z", "2026-12-10T17:00:00Z"]),
      run("three", "2026-12-08T10:00:00Z", 3, ["2026-12-09T10:00:00Z", "2026-12-10T10:00:00Z", "2026-12-11T10:00:00Z"]),
      run("short", "2026-12-07T10:00:00Z", 5, ["2026-12-08T10:00:00Z", "2026-12-15T08:00:00Z"]),
      run("late_five", "2026-12-07T10:00:00Z", 5, Array(5).fill("2026-12-11T10:00:00Z")),
    ] });
    expect(judgedMeasure(f, P.week, NOW)).toMatchObject({ numerator: 2, denominator: 4, shown: "50% (2 of 4)" });
    const open = facts({ runs: [run("open", "2026-12-11T10:00:00Z", 5, [])] });
    expect(judgedMeasure(open, P.week, NOW).shown).toBe("no data yet");
    expect(judgedMeasure(open, P.week, new Date("2026-12-17T09:00:00Z")).shown).toBe("0% (0 of 1)");
  });
});

describe("measure 6: quiet offers", () => {
  it("counts offered and negotiating offers with no touch for 21 days, now and at an earlier week's end", () => {
    const f = facts({ offers: [
      offer({ id: "quiet", created_at: "2026-11-01T10:00:00Z", events: [{ to: "offered", at: "2026-11-02T10:00:00Z", starting: false }] }),
      offer({ id: "mailed", created_at: "2026-11-01T10:00:00Z", events: [{ to: "offered", at: "2026-11-02T10:00:00Z", starting: false }], mail_at: ["2026-12-01T10:00:00Z"] }),
      offer({ id: "talking", stage: "negotiating", created_at: "2026-11-01T10:00:00Z", last_touch_on: "2026-12-10" }),
      offer({ id: "done", stage: "declined", created_at: "2026-10-01T10:00:00Z" }),
    ] });
    expect(quietMeasure(f, true, NOW)).toMatchObject({ value: 1, met: false });
    // At 7 Dec: "talking" has no stage history then, so only offers with history count; "quiet" is 35 days quiet.
    expect(quietMeasure(f, false, new Date(P.previous.to))).toMatchObject({ value: 1 });
    expect(quietMeasure(facts({}), true, NOW).shown).toBe("no data yet");
  });
});

describe("measures 7 to 11: offers to close", () => {
  const offeredOn = (at: string) => [{ to: "offered", at, starting: false }];
  it("7: a buyer price and a gate-passing seller quote on the day it was offered", () => {
    const f = facts({ offers: [
      offer({ id: "good", events: offeredOn("2026-12-08T10:00:00Z"), quote: inDate }),
      offer({ id: "unpriced", amount: null, events: offeredOn("2026-12-08T10:00:00Z"), quote: inDate }),
      offer({ id: "lapsed", events: offeredOn("2026-12-08T10:00:00Z"), quote: { ...inDate, validUntil: "2026-12-05" } }),
      offer({ id: "unconfirmed", events: offeredOn("2026-12-08T10:00:00Z"), quote: { ...inDate, status: "unverified" } }),
      offer({ id: "match_lapsed", events: offeredOn("2026-12-08T10:00:00Z"), quote: inDate, match: { created_at: "2026-12-01T10:00:00Z", verdict: "yes", quote_valid_until: "2026-12-04" } }),
      offer({ id: "to_seller", side: "seller", events: offeredOn("2026-12-08T10:00:00Z") }),
      offer({ id: "starting_row", events: [{ to: "offered", at: "2026-12-08T10:00:00Z", starting: true }], quote: inDate }),
    ] });
    expect(quotedMeasure(f, P.week)).toMatchObject({ numerator: 1, denominator: 5, shown: "20% (1 of 5)", met: false });
  });

  it("8: median calendar days from the stored match to the first Agreed stage", () => {
    const agreed = (id: string, match: string, at: string) => offer({ id, match: { created_at: match, verdict: "yes", quote_valid_until: null },
      events: [{ to: "offered", at: match, starting: false }, { to: "contract_out", at, starting: false }, { to: "signed", at: "2026-12-12T10:00:00Z", starting: false }] });
    const f = facts({ offers: [agreed("a", "2026-12-01T10:00:00Z", "2026-12-08T10:00:00Z"), agreed("b", "2026-11-20T10:00:00Z", "2026-12-09T10:00:00Z"),
      agreed("c", "2026-11-28T10:00:00Z", "2026-12-10T10:00:00Z"), offer({ id: "no_match", events: [{ to: "contract_out", at: "2026-12-08T10:00:00Z", starting: false }] })] });
    expect(speedMeasure(f, P.week)).toMatchObject({ value: 12, numerator: 3, shown: "12 days (3 deals)", met: true });
    expect(speedMeasure(f, P.previous).shown).toBe("no data yet");
  });

  it("9: won of offered offers that reached a final state in the period", () => {
    const final = (id: string, path: [string, string][]) => offer({ id, events: path.map(([to, at]) => ({ to, at, starting: false })) });
    const f = facts({ offers: [
      final("won", [["offered", "2026-11-20T10:00:00Z"], ["paid", "2026-12-08T10:00:00Z"], ["complete", "2026-12-20T10:00:00Z"]]),
      final("lost", [["offered", "2026-11-20T10:00:00Z"], ["lost", "2026-12-09T10:00:00Z"]]),
      final("declined", [["negotiating", "2026-11-20T10:00:00Z"], ["declined", "2026-12-10T10:00:00Z"]]),
      final("never_offered", [["candidate", "2026-11-20T10:00:00Z"], ["declined", "2026-12-10T10:00:00Z"]]),
      offer({ id: "old_final", events: [{ to: "lost", at: "2026-12-08T10:00:00Z", starting: true }] }),
    ] });
    expect(wonMeasure(f, P.week)).toMatchObject({ numerator: 1, denominator: 3, shown: "33% (1 of 3)", met: true });
  });

  it("10: take by paid_on, a week against its share of £15,000, the quarter against the floor; no data before any paid record", () => {
    const f = facts({ offers: [offer({ id: "p1", paid_on: "2026-12-08", take_gbp: 900 }), offer({ id: "p2", paid_on: "2026-12-13", take_gbp: 600 }),
      offer({ id: "p3", paid_on: "2026-12-14", take_gbp: 5000 }), offer({ id: "p4", paid_on: "2026-12-02", take_gbp: 1000 })] });
    expect(takeMeasure(f, P.week)).toMatchObject({ value: 1500, shown: "£1,500", met: true, target: "£1,154 a week (£15,000 Dec to Feb)" });
    expect(takeMeasure(f, P.quarter)).toMatchObject({ value: 7500, met: false, target: "£15,000 Dec to Feb" });
    expect(takeMeasure(facts({ offers: [offer({ paid_on: "2026-12-14", take_gbp: 10 })] }), P.week).shown).toBe("no data yet");
    // Paid records exist before the week but none in it: a real £0.
    expect(takeMeasure(facts({ offers: [offer({ paid_on: "2026-12-02", take_gbp: 10 })] }), P.week).shown).toBe("£0");
  });

  it("11: first email to paid with every step on record", () => {
    const full = offer({
      id: "full", from_card: true, match: { created_at: "2026-11-25T10:00:00Z", verdict: "yes", quote_valid_until: null },
      events: [{ to: "offered", at: "2026-12-01T10:00:00Z", starting: false }, { to: "paid", at: "2026-12-09T10:00:00Z", starting: false }],
      quote: inDate, sheet_sent: true, quantity: 10, paid_on: "2026-12-09", paid_amount: 1000, paid_currency: "GBP", take_gbp: 120,
    });
    expect(fullyPrepared(full)).toBe(true);
    for (const gap of [{ from_card: false }, { match: null }, { sheet_sent: false }, { take_gbp: null }, { quantity: null }, { quote: { ...inDate, status: "unverified" } }]) {
      expect(fullyPrepared({ ...full, ...gap })).toBe(false);
    }
    const f = facts({ offers: [full, { ...full, id: "by_hand", from_card: false }] });
    expect(preparedMeasure(f, P.week)).toMatchObject({ value: 1, numerator: 1, denominator: 2, shown: "1 of 2 paid", met: true });
    expect(preparedMeasure(f, P.quarter)).toMatchObject({ value: 1, met: true });
    expect(preparedMeasure(facts({}), P.week).shown).toBe("no data yet");
    // The target is for the quarter: a week without one is not counted as a miss; the quarter is.
    const none = facts({ offers: [{ ...full, id: "by_hand", from_card: false }] });
    expect(preparedMeasure(none, P.week)).toMatchObject({ value: 0, met: null, gap: 0 });
    expect(preparedMeasure(none, P.quarter)).toMatchObject({ value: 0, met: false, gap: 1 });
  });
});

describe("the Monday message", () => {
  it("has the eleven lines with target and an arrow, then the three furthest from target", () => {
    const f = facts({
      enquiries: [enquiry({ arrived_at: "2026-12-07T10:00:00Z", replied_at: "2026-12-07T10:30:00Z", route: null }), enquiry({ arrived_at: "2026-12-01T10:00:00Z", replied_at: "2026-12-03T10:00:00Z", route: null })],
      offers: [offer({ id: "q", created_at: "2026-10-01T10:00:00Z", events: [{ to: "offered", at: "2026-10-02T10:00:00Z", starting: false }] })],
      sheet: [row({ id: "n", progress: "New", stage_since: "2026-11-01T09:00:00Z" })],
    });
    const card = computeScorecard(f, NOW);
    const text = mondayMessage(card);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Bulk scorecard, week of 7 Dec 2026");
    expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(11);
    expect(text).toContain("1. Enquiries answered within 2 working hours: 100% (1 of 1), target 80% ↑");
    expect(text).toContain("6. Offers quiet for 21+ days: 1, target 0 =");
    expect(text).toContain("2. Bulk leads routed and decided within 2 working days: no data yet");
    expect(worstThree(card.week).map((m) => m.key)).toEqual(["stuck", "quiet"]);
    expect(text).toMatch(/Furthest from target:\n- Deals in New for over 7 days: 1, target 0\n/);
    expect(text).not.toMatch(/—/);
    expect(scorecardText(card)).toContain("How counted: New enquiries that arrived in the period");
  });
});
