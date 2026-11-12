// The scorecard (slice 6, docs/bulk-relay-system/scorecard.md): eleven measures that say each Monday whether the bulk
// process is working, for one week and for the quarter to date. The pure part: periods, the rules for each measure, and
// the plain-text and WhatsApp-ready wording. Facts come from lib/crm-postgres/bulk-scorecard.ts (read-only). Safe for
// client and server: no database, no model, nothing sent.
//
// A measure that has nothing to count in a period says "no data yet", never zero. Items still inside their allowance
// (an enquiry under two working hours old, a lead under two working days) are left out until they are on time or late.
import { addWorkingDays, leadLate, londonAt, londonDate, workingDaysBetween, workingMinutesBetween, LEAD_GOAL_WORKING_MINUTES } from "./chase-clock";
import { isActive, stuckInNew, STUCK_NEW_DAYS } from "./bulk-today";
import { quoteGate, type SupplyQuote } from "./bulk-offer-close";
import { TARGETS } from "./home-metrics";
import { QUIET_OFFER_DAYS } from "./okr";
import { USD_PER } from "./relay-front-door";
import type { SheetRow } from "./bulk-sheet";

const DAY = 86_400_000;

/** The target period agreed with Alex: Dec 2026 to Feb 2027, London dates, end exclusive. */
export const QUARTER = { from: "2026-12-01", to: "2027-03-01", label: "Dec to Feb" } as const;
/** Weeks in the quarter, for the weekly share of the take floor. */
const QUARTER_WEEKS = 13;
/** Measure 5: five candidates, each judged within this many working days of the match run. */
export const JUDGE_WORKING_DAYS = 3;
export const JUDGE_CANDIDATES = 5;
/** Measure 2: a bulk lead needs its route and a decision within this many working days. */
export const DECIDE_WORKING_DAYS = 2;
const OFFERED_ON = ["offered", "negotiating", "contract_out", "signed", "invoiced", "paid", "complete"];
const AGREED = ["contract_out", "signed", "invoiced", "paid", "complete"];
const WON = ["paid", "complete"];
const LOST = ["declined", "lost"];

// ---------- periods ----------

export type Period = { key: "week" | "previous" | "quarter"; label: string; from: string; to: string; started: boolean };

/** The Monday (London date) of the week holding `at`. */
export function mondayOf(at: Date | string): string {
  const date = londonDate(at);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return new Date(Date.parse(`${date}T00:00:00Z`) - ((weekday + 6) % 7) * DAY).toISOString().slice(0, 10);
}

const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const midnight = (date: string) => new Date(londonAt(date, 0)).toISOString();
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The week to report (Monday to Monday, London), the week before it, and the quarter to date. By default the week
 * reported is the last full week before `now`; `week` may name any date inside another one. */
export function periods(now: Date, week?: string | null): { week: Period; previous: Period; quarter: Period } {
  const monday = week ? mondayOf(`${week.slice(0, 10)}T12:00:00Z`) : plusDays(mondayOf(now), -7);
  const before = plusDays(monday, -7);
  const end = Math.min(now.getTime(), Date.parse(midnight(QUARTER.to)));
  const started = now.getTime() >= Date.parse(midnight(QUARTER.from));
  return {
    week: { key: "week", label: `Week of ${dayLabel(monday)}`, from: midnight(monday), to: midnight(plusDays(monday, 7)), started: true },
    previous: { key: "previous", label: `Week of ${dayLabel(before)}`, from: midnight(before), to: midnight(monday), started: true },
    quarter: { key: "quarter", label: `Quarter to date (${QUARTER.label})`, from: midnight(QUARTER.from), to: new Date(started ? end : Date.parse(midnight(QUARTER.from))).toISOString(), started },
  };
}

const inPeriod = (at: string | null | undefined, period: Period) => !!at && Date.parse(at) >= Date.parse(period.from) && Date.parse(at) < Date.parse(period.to);
/** A paid_on date (London) inside the period. */
const dateInPeriod = (date: string | null | undefined, period: Period) => !!date && date.slice(0, 10) >= londonDate(period.from) && date.slice(0, 10) < londonDate(period.to);

// ---------- facts (what the read-only loader returns) ----------

/** A new enquiry: a Relay thread from a seller or buyer whose first message is theirs, to someone we had not written to before. */
export type EnquiryFact = {
  id: string;
  arrived_at: string;
  /** Our first sent (accepted, not marketing) message on the thread after it. */
  replied_at: string | null;
  card_status: string | null;
  /** Relay's suggested route on the lead card; null when no card was prepared. */
  route: string | null;
  /** The card's record of the sent reply (relay-deal settleSentCards). */
  sent: { route?: { route?: string } | null; deal_id?: string | null; opened?: boolean; at?: string } | null;
  dismissed_at: string | null;
  /** The deal the lead is linked to (opened from the card, or linked to the Relay thread) and when it was made. */
  deal_id: string | null;
  deal_created_at: string | null;
};
export type ListingFact = { id: string; kind: string; source_kind: string | null; created_at: string };
export type ListingEventFact = { listing_id: string; to_stage: string | null; at: string; starting: boolean; created_at: string };
export type MatchRunFact = { deal_id: string; at: string; count: number; verdicts: string[] };
export type OfferEventFact = { to: string | null; at: string; starting: boolean };
export type OfferFact = {
  id: string;
  /** buyer: an offer on a supply listing (it quotes our price to a buyer); seller: an offer on a request. */
  side: "buyer" | "seller";
  stage: string | null;
  amount: number | null;
  quantity: number | null;
  paid_on: string | null;
  paid_amount: number | null;
  paid_currency: string | null;
  take_gbp: number | null;
  created_at: string;
  last_touch_on: string | null;
  events: OfferEventFact[];
  /** Messages on the email threads linked to this offer. */
  mail_at: string[];
  quote: SupplyQuote | null;
  match: { created_at: string; verdict: string | null; quote_valid_until: string | null } | null;
  /** A price sheet (doc_type Quote) went with an offer email (state sent). */
  sheet_sent: boolean;
  /** One of its listings was opened by Relay from a sent lead card. */
  from_card: boolean;
};
export type ScorecardFacts = {
  enquiries: EnquiryFact[];
  listings: ListingFact[];
  /** The Bulk Trades sheet as it is now, research rows left out. */
  sheet: SheetRow[];
  events: ListingEventFact[];
  runs: MatchRunFact[];
  offers: OfferFact[];
};

// ---------- measures ----------

export type MeasureKey = "reply" | "decide" | "active" | "stuck" | "judged" | "quiet" | "quoted" | "speed" | "won" | "take" | "prepared";

export type Measure = {
  n: number;
  key: MeasureKey;
  name: string;
  /** null: no data yet. */
  value: number | null;
  /** The value as shown: "75% (6 of 8)", "£2,400", "no data yet". */
  shown: string;
  numerator: number | null;
  denominator: number | null;
  target: string;
  baseline: string;
  /** Met the target in this period; null with no data. */
  met: boolean | null;
  /** How far from the target, 0 when met: only used to name the worst three. */
  gap: number | null;
  better: "higher" | "lower";
  how: string;
};

type Def = Pick<Measure, "n" | "key" | "name" | "target" | "baseline" | "better" | "how">;

export const MEASURES: Record<MeasureKey, Def> = {
  reply: { n: 1, key: "reply", name: "Enquiries answered within 2 working hours", target: "80%", baseline: "under 11%", better: "higher",
    how: "New enquiries that arrived in the period: Relay threads from a seller or buyer whose first message is theirs, to an address we had not written to, less cards marked Not a lead. Answered on time: our first sent email on the thread within 2 working hours (Mon to Fri, 09:00 to 18:00 London). Ones still inside the 2 hours are left out." },
  decide: { n: 2, key: "decide", name: "Bulk leads routed and decided within 2 working days", target: "100%", baseline: "about 25%", better: "higher",
    how: "Enquiries whose lead card Relay routed to a bulk deal or recycling. Decided: a deal opened (or the lead linked to one), the reply sent on another route Alex picked, or the card dismissed as Not a lead, by working day 2 after the email came in. Leads with no card cannot be routed and are not counted." },
  active: { n: 3, key: "active", name: "Active deals, and how many are complete", target: "20 or fewer, all complete", baseline: "40 active", better: "lower",
    how: "Open deals past New and not finished (the Today tab's active rule), research rows left out, as they stand now. Complete: an owner, a ticket size, a chance and a next step with a due date. Past weeks were not recorded." },
  stuck: { n: 4, key: "stuck", name: `Deals in New for over ${STUCK_NEW_DAYS} days`, target: "0", baseline: "11 in New", better: "lower",
    how: `Open deals in New for more than ${STUCK_NEW_DAYS} days (the Today tab's Stuck in New), research rows left out. Now from the sheet; for an earlier week, from the stage history as it stood at that week's end.` },
  judged: { n: 5, key: "judged", name: `Match runs with ${JUDGE_CANDIDATES} candidates judged within ${JUDGE_WORKING_DAYS} working days`, target: "90%", baseline: "0", better: "higher",
    how: `Deals whose first match run that found candidates was in the period. Judged: a yes or a no recorded on ${JUDGE_CANDIDATES} of its stored candidates (or all of them when the run found fewer) by working day ${JUDGE_WORKING_DAYS} after the run. Runs still inside the ${JUDGE_WORKING_DAYS} days are left out.` },
  quiet: { n: 6, key: "quiet", name: `Offers quiet for ${QUIET_OFFER_DAYS}+ days`, target: "0", baseline: "49", better: "lower",
    how: `Offers to a counterparty in Offered or Negotiating whose last touch (a stage change, a message on its email threads, its last touch date, else when it was made) is ${QUIET_OFFER_DAYS} or more days old. Now, and for an earlier week as it stood at that week's end.` },
  quoted: { n: 7, key: "quoted", name: "Offers to buyers carrying a confirmed, in-date, priced quote", target: "80%", baseline: "9 of 76", better: "higher",
    how: "Offers on supply listings first offered in the period. Counted: the offer has a buyer price and the seller's quote passed the quote gate on the day it was offered (price confirmed, in date, and the match's own quote date when it has one). The quote is read as stored now." },
  speed: { n: 8, key: "speed", name: "Match to agreed, median days", target: "14 days or less", baseline: "not recorded", better: "lower",
    how: "Offers that came from a stored match and first reached Agreed (contract out or further) in the period: calendar days from the match being stored to that stage change, the median." },
  won: { n: 9, key: "won", name: "Offered deals won", target: "30%", baseline: "not recorded", better: "higher",
    how: "Offers that had been offered and reached a final state in the period: won is Paid or Complete, lost is Declined or Lost. Won as a share of both. Starting rows from migration 116 do not count as a change." },
  take: { n: 10, key: "take", name: "Take recorded", target: "£15,000 Dec to Feb", baseline: "not recorded", better: "higher",
    how: `Sum of take_gbp on offers paid in the period, by paid_on. The floor is £${TARGETS.bulk_take.value.toLocaleString("en-GB")} for Dec to Feb (a week's share is a ${QUARTER_WEEKS}th of it); comfortable is USD 10,000 a month (about £${Math.round(10_000 / USD_PER.GBP).toLocaleString("en-GB")} at the fixed 1.34).` },
  prepared: { n: 11, key: "prepared", name: "Deals from first email to paid, every step prepared", target: "1 by end of February", baseline: "none", better: "higher",
    how: "Offers paid in the period where every step is on record: the deal was opened by Relay from a sent lead card; a stored match on it got a yes; the offer had a buyer price, passed the quote gate on the day it was offered and a price sheet went with the email; and all five paid facts are recorded (quantity, paid on, amount, currency, take)." },
};

const NO_DATA = "no data yet";
const pct = (part: number, whole: number) => Math.round((part / whole) * 100);
const money = (gbp: number) => `£${Math.round(gbp).toLocaleString("en-GB")}`;

function make(key: MeasureKey, value: number | null, shown: string, numerator: number | null, denominator: number | null, met: boolean | null, gap: number | null, how?: string): Measure {
  return { ...MEASURES[key], value, shown: value === null ? NO_DATA : shown, numerator, denominator, met: value === null ? null : met, gap: value === null ? null : Math.max(0, gap ?? 0), ...(how ? { how } : {}) };
}

/** A share against a target share (0 to 1). */
function share(key: MeasureKey, yes: number, of: number, target: number): Measure {
  if (!of) return make(key, null, NO_DATA, yes, of, null, null);
  const value = pct(yes, of);
  return make(key, value, `${value}% (${yes} of ${of})`, yes, of, yes / of >= target, (target - yes / of) / target);
}

// 1. Enquiries answered within 2 working hours.
export function replyMeasure(facts: ScorecardFacts, period: Period, now: Date): Measure {
  let yes = 0, of = 0;
  for (const e of facts.enquiries) {
    if (!inPeriod(e.arrived_at, period) || e.card_status === "not_lead" || e.card_status === "dismissed") continue;
    const onTime = !!e.replied_at && workingMinutesBetween(e.arrived_at, e.replied_at) <= LEAD_GOAL_WORKING_MINUTES;
    if (onTime) { yes++; of++; } else if (e.replied_at || leadLate(e.arrived_at, now)) of++;
  }
  return share("reply", yes, of, 0.8);
}

/** When a bulk lead got its route and decision: deal opened or linked, sent on another route, or dismissed. */
export function decidedAt(e: EnquiryFact): string | null {
  const times: string[] = [];
  if (e.deal_id) {
    // A deal made for this lead counts when it was made; one that already existed counts when the lead was linked to
    // it, known only from the sent card (else from the email: it was linked before anyone could decide).
    times.push(e.deal_created_at && Date.parse(e.deal_created_at) >= Date.parse(e.arrived_at) ? e.deal_created_at : e.sent?.at ?? e.arrived_at);
  }
  const sentRoute = e.sent?.route?.route;
  if (e.sent?.at && sentRoute && sentRoute !== "bulk" && sentRoute !== "recycling") times.push(e.sent.at);
  if (e.card_status === "dismissed" && e.dismissed_at) times.push(e.dismissed_at);
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

// 2. Bulk leads with a route and a decision within 2 working days.
export function decideMeasure(facts: ScorecardFacts, period: Period, now: Date): Measure {
  let yes = 0, of = 0;
  for (const e of facts.enquiries) {
    if (!inPeriod(e.arrived_at, period) || e.card_status === "not_lead" || (e.route !== "bulk" && e.route !== "recycling")) continue;
    const at = decidedAt(e);
    if (at && workingDaysBetween(e.arrived_at, at) <= DECIDE_WORKING_DAYS) { yes++; of++; }
    else if (at || workingDaysBetween(e.arrived_at, now) > DECIDE_WORKING_DAYS) of++;
  }
  return share("decide", yes, of, 1);
}

/** A deal is complete with an owner, a ticket size, a chance and a next step with a due date. */
export const dealComplete = (row: SheetRow) => !!row.owner && row.value_eur != null && row.likelihood != null && !!row.next_action?.trim() && !!row.next_due;

// 3. Active deals, and how many are complete. Now only.
export function activeMeasure(facts: ScorecardFacts, current: boolean): Measure {
  if (!current || !facts.sheet.length) return make("active", null, NO_DATA, null, null, null, null);
  const active = facts.sheet.filter(isActive);
  const complete = active.filter(dealComplete).length;
  const n = active.length;
  const gap = Math.max((n - 20) / 20, n ? (n - complete) / n : 0);
  return make("active", n, `${n} active, ${complete} complete`, complete, n, n <= 20 && complete === n, gap);
}

/** Deals in New for more than STUCK_NEW_DAYS days as they stood at `at`, from the stage history (daysInNew's rule). */
export function stuckAt(events: ListingEventFact[], at: Date): number | null {
  const last = new Map<string, ListingEventFact>();
  for (const e of events) {
    if (Date.parse(e.at) >= at.getTime()) continue;
    const seen = last.get(e.listing_id);
    if (!seen || Date.parse(e.at) >= Date.parse(seen.at)) last.set(e.listing_id, e);
  }
  if (!last.size) return null;
  let n = 0;
  for (const e of last.values()) {
    if (e.to_stage !== "New") continue;
    const since = e.starting ? e.created_at : e.at;
    if (Math.floor((at.getTime() - Date.parse(since)) / DAY) > STUCK_NEW_DAYS) n++;
  }
  return n;
}

const countMeasure = (key: MeasureKey, n: number | null, baseline: number, unit = "") =>
  n === null ? make(key, null, NO_DATA, null, null, null, null) : make(key, n, `${n}${unit}`, n, null, n === 0, n / baseline);

// 4. Deals in New for over 7 days. Now from the sheet (stuckInNew); an earlier week from the stage history.
export function stuckMeasure(facts: ScorecardFacts, current: boolean, at: Date): Measure {
  return countMeasure("stuck", !current ? stuckAt(facts.events, at) : facts.sheet.length ? stuckInNew(facts.sheet, at).length : null, 11);
}

// 5. Match runs with five candidates judged within 3 working days.
export function judgedMeasure(facts: ScorecardFacts, period: Period, now: Date): Measure {
  let yes = 0, of = 0;
  for (const run of facts.runs) {
    if (!inPeriod(run.at, period) || run.count < 1) continue;
    const by = addWorkingDays(run.at, JUDGE_WORKING_DAYS);
    const judged = run.verdicts.filter((v) => londonDate(v) <= by).length;
    if (judged >= Math.min(JUDGE_CANDIDATES, run.count)) { yes++; of++; } else if (londonDate(now) > by) of++;
  }
  return share("judged", yes, of, 0.9);
}

/** The stage an offer had at `at`: its last stage event before then, or null when the history does not reach back. */
function offerStageAt(offer: OfferFact, at: Date): string | null | undefined {
  const before = offer.events.filter((e) => Date.parse(e.at) < at.getTime());
  return before.length ? before[before.length - 1].to : undefined;
}

/** Quiet offers as they stood at `at` (now: the offer's current stage). Null when no offer's history reaches back. */
export function quietAt(offers: OfferFact[], at: Date, current: boolean): number | null {
  let n = 0, known = false;
  for (const o of offers) {
    if (Date.parse(o.created_at) >= at.getTime()) continue;
    const stage = current ? o.stage : offerStageAt(o, at);
    if (stage === undefined) continue;
    known = true;
    if (stage !== "offered" && stage !== "negotiating") continue;
    const touches = [o.created_at, ...o.events.filter((e) => !e.starting).map((e) => e.at), ...o.mail_at,
      ...(o.last_touch_on ? [`${o.last_touch_on.slice(0, 10)}T12:00:00Z`] : [])].map(Date.parse).filter((t) => t < at.getTime());
    if (Math.max(...touches) <= at.getTime() - QUIET_OFFER_DAYS * DAY) n++;
  }
  return known ? n : null;
}

// 6. Offers quiet for 21+ days.
export function quietMeasure(facts: ScorecardFacts, current: boolean, at: Date): Measure {
  return countMeasure("quiet", quietAt(facts.offers, at, current), 49);
}

/** When an offer first went out (first stage change to Offered or further, not a migration starting row). */
export const firstOfferedAt = (o: OfferFact) => o.events.find((e) => !e.starting && e.to && OFFERED_ON.includes(e.to))?.at ?? null;
const firstAt = (o: OfferFact, stages: string[]) => o.events.find((e) => !e.starting && e.to && stages.includes(e.to))?.at ?? null;

/** A buyer price, and the seller's quote passed the gate on the day the offer went out. */
export function carriedQuote(o: OfferFact): boolean {
  const at = firstOfferedAt(o);
  return !!at && o.side === "buyer" && o.amount != null && o.amount > 0 && quoteGate(o.quote, londonDate(at), o.match?.quote_valid_until).ok;
}

// 7. Offers to buyers carrying a seller-confirmed, in-date, priced quote.
export function quotedMeasure(facts: ScorecardFacts, period: Period): Measure {
  const offered = facts.offers.filter((o) => o.side === "buyer" && inPeriod(firstOfferedAt(o), period));
  return share("quoted", offered.filter(carriedQuote).length, offered.length, 0.8);
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// 8. Match to agreed, median days.
export function speedMeasure(facts: ScorecardFacts, period: Period): Measure {
  const days = facts.offers.flatMap((o) => {
    const agreed = firstAt(o, AGREED);
    if (!o.match || !inPeriod(agreed, period) || Date.parse(o.match.created_at) > Date.parse(agreed!)) return [];
    return [(Date.parse(agreed!) - Date.parse(o.match.created_at)) / DAY];
  });
  if (!days.length) return make("speed", null, NO_DATA, 0, 0, null, null);
  const value = Math.round(median(days) * 10) / 10;
  return make("speed", value, `${value} days (${days.length} ${days.length === 1 ? "deal" : "deals"})`, days.length, days.length, value <= 14, (value - 14) / 14);
}

// 9. Offered deals won.
export function wonMeasure(facts: ScorecardFacts, period: Period): Measure {
  let won = 0, of = 0;
  for (const o of facts.offers) {
    const final = o.events.find((e) => !e.starting && e.to && (WON.includes(e.to) || LOST.includes(e.to)));
    if (!final || !inPeriod(final.at, period)) continue;
    const wasOffered = WON.includes(final.to!) || o.events.some((e) => e.to && OFFERED_ON.includes(e.to) && Date.parse(e.at) <= Date.parse(final.at));
    if (!wasOffered) continue;
    of++;
    if (WON.includes(final.to!)) won++;
  }
  return share("won", won, of, 0.3);
}

const paidBy = (facts: ScorecardFacts, period: Period) => facts.offers.some((o) => !!o.paid_on && o.paid_on.slice(0, 10) < londonDate(period.to));

// 10. Take recorded in the period, by paid_on.
export function takeMeasure(facts: ScorecardFacts, period: Period): Measure {
  if (!period.started || !paidBy(facts, period)) return make("take", null, NO_DATA, null, null, null, null);
  const paid = facts.offers.filter((o) => dateInPeriod(o.paid_on, period));
  const take = paid.reduce((sum, o) => sum + (o.take_gbp ?? 0), 0);
  const target = period.key === "quarter" ? TARGETS.bulk_take.value : TARGETS.bulk_take.value / QUARTER_WEEKS;
  const m = make("take", take, money(take), paid.length, null, take >= target, (target - take) / target);
  return period.key === "quarter" ? m : { ...m, target: `${money(target)} a week (£15,000 Dec to Feb)` };
}

/** Measure 11's rule: every step from the first email to paid is on record. */
export const fullyPrepared = (o: OfferFact) => o.from_card && o.match?.verdict === "yes" && carriedQuote(o) && o.sheet_sent
  && !!o.paid_on && o.paid_amount != null && !!o.paid_currency && o.take_gbp != null && o.quantity != null;

// 11. Deals taken from first email to paid with every step prepared by the system.
export function preparedMeasure(facts: ScorecardFacts, period: Period): Measure {
  if (!period.started || !paidBy(facts, period)) return make("prepared", null, NO_DATA, null, null, null, null);
  const paid = facts.offers.filter((o) => dateInPeriod(o.paid_on, period));
  const n = paid.filter(fullyPrepared).length;
  // The target is for the quarter: a week without one is not a miss, so only the quarter is judged and ranked.
  const quarter = period.key === "quarter";
  return make("prepared", n, `${n} of ${paid.length} paid`, n, paid.length, n >= 1 ? true : quarter ? false : null, n >= 1 || !quarter ? 0 : 1);
}

export type Intake = { listings: number; jules: number; research_left_out: number };

/** New bulk listings in the period: research rows left out, Jules rows counted on their own. */
export function intake(facts: ScorecardFacts, period: Period): Intake {
  const rows = facts.listings.filter((l) => inPeriod(l.created_at, period));
  return {
    listings: rows.filter((l) => l.source_kind !== "research" && l.source_kind !== "jules").length,
    jules: rows.filter((l) => l.source_kind === "jules").length,
    research_left_out: rows.filter((l) => l.source_kind === "research").length,
  };
}

export type Scorecard = {
  now: string;
  periods: { week: Period; previous: Period; quarter: Period };
  week: Measure[];
  previous: Measure[];
  quarter: Measure[];
  intake: { week: Intake; quarter: Intake };
};

/**
 * All eleven for the week, the week before (for the arrows) and the quarter to date. Snapshot measures (3, 4, 6) are
 * as they stand now in the week and quarter columns; the week before reads 4 and 6 from the history, and 3 has none.
 */
export function computeScorecard(facts: ScorecardFacts, now: Date, week?: string | null): Scorecard {
  const p = periods(now, week);
  const flow = (period: Period) => period.started
    ? [replyMeasure(facts, period, now), decideMeasure(facts, period, now), judgedMeasure(facts, period, now), quotedMeasure(facts, period),
      speedMeasure(facts, period), wonMeasure(facts, period), takeMeasure(facts, period), preparedMeasure(facts, period)]
    : (["reply", "decide", "judged", "quoted", "speed", "won", "take", "prepared"] as MeasureKey[]).map((key) => make(key, null, NO_DATA, null, null, null, null));
  // The week reported is "now" for snapshots when it is the last full week or the current one; an older week is read
  // from the history at its end.
  const recent = Date.parse(p.week.to) >= now.getTime() - 7 * DAY;
  const snapAt = recent ? now : new Date(p.week.to);
  const snaps = (current: boolean, at: Date) => [activeMeasure(facts, current), stuckMeasure(facts, current, at), quietMeasure(facts, current, at)];
  const order = (list: Measure[]) => list.sort((a, b) => a.n - b.n);
  return {
    now: now.toISOString(),
    periods: p,
    week: order([...flow(p.week), ...snaps(recent, snapAt)]),
    previous: order([...flow(p.previous), ...snaps(false, new Date(p.previous.to))]),
    quarter: order([...flow(p.quarter), ...(p.quarter.started ? snaps(true, now) : snaps(false, new Date(0)).map((m) => make(m.key, null, NO_DATA, null, null, null, null)))]),
    intake: { week: intake(facts, p.week), quarter: intake(facts, p.quarter) },
  };
}

// ---------- wording ----------

/** Up, down or level against last week; nothing when either week has no data. */
export function arrow(now: Measure, before: Measure | undefined): string {
  if (now.value === null || !before || before.value === null) return "";
  return now.value > before.value ? "↑" : now.value < before.value ? "↓" : "=";
}

/** The three furthest from target in the week, named plainly. Measures with no data are left out. */
export function worstThree(measures: Measure[]): Measure[] {
  return measures.filter((m) => m.gap !== null && m.gap > 0).sort((a, b) => b.gap! - a.gap! || a.n - b.n).slice(0, 3);
}

const line = (m: Measure, before?: Measure) => {
  const a = arrow(m, before);
  return `${m.n}. ${m.name}: ${m.shown}${m.value === null ? "" : `, target ${m.target}`}${a ? ` ${a}` : ""}`;
};

/** The Monday message: short, WhatsApp-ready plain text. */
export function mondayMessage(card: Scorecard): string {
  const before = new Map(card.previous.map((m) => [m.key, m]));
  const worst = worstThree(card.week);
  return [
    `Bulk scorecard, ${card.periods.week.label.replace(/^Week/, "week")}`,
    "",
    ...card.week.map((m) => line(m, before.get(m.key))),
    "",
    worst.length ? "Furthest from target:" : "Nothing measured is off target this week.",
    ...worst.map((m) => `- ${m.name}: ${m.shown}, target ${m.target}`),
    "",
    `Take ${card.periods.quarter.started ? `so far (${QUARTER.label}): ${card.quarter.find((m) => m.key === "take")?.shown}` : `target period starts ${dayLabel(QUARTER.from)}`}.`,
    "Arrows compare with the week before.",
  ].join("\n");
}

/** The full scorecard as plain text, with how each measure is counted. */
export function scorecardText(card: Scorecard): string {
  const before = new Map(card.previous.map((m) => [m.key, m]));
  const quarter = new Map(card.quarter.map((m) => [m.key, m]));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const intakeLine = (label: string, i: Intake) =>
    `${label}: ${plural(i.listings, "new bulk listing", "new bulk listings")}; ${plural(i.jules, "Jules lot", "Jules lots")} counted separately; ${plural(i.research_left_out, "research row", "research rows")} left out.`;
  return [
    `Bulk scorecard · ${card.periods.week.label} · run ${card.now.slice(0, 16).replace("T", " ")} UTC`,
    `Compared with: ${card.periods.previous.label}. ${card.periods.quarter.label}: ${card.periods.quarter.started ? `from ${dayLabel(QUARTER.from)}` : `starts ${dayLabel(QUARTER.from)}`}.`,
    "",
    ...card.week.flatMap((m) => [
      line(m, before.get(m.key)),
      `   Last week: ${before.get(m.key)?.shown ?? NO_DATA}. Quarter: ${quarter.get(m.key)?.shown ?? NO_DATA}. Baseline 12 Nov 2026: ${m.baseline}.`,
      `   How counted: ${m.how}`,
    ]),
    "",
    intakeLine("Intake this week", card.intake.week),
    card.periods.quarter.started ? intakeLine("Intake this quarter", card.intake.quarter) : "",
  ].filter((text, i, all) => text !== "" || all[i - 1] !== "").join("\n");
}
