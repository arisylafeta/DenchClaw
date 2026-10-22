// Home: the CRM landing page. One registry of the marketplace targets and watch numbers, and the pure
// calculations the page, the bottleneck line, the freshness alert and the tests all share.
//
// The numbers are Marketplace Pulse's weekly snapshots (crm_metric_snapshots, dimension ''), written by
// scripts/rebattery/marketplace_pulse_collect.py. Weeks start on Monday, UTC. There are no daily values,
// so monthly figures add up whole weeks: a week counts towards the month its Monday falls in.
import { mondayOf, type FollowUp, type MetricKey, type PulseWeek, type WaitingItem } from "./marketplace-pulse";

export type Aggregate = "sum" | "ratio" | "last";
export type Unit = "count" | "percent" | "gbp";
export type Owner = "Ari" | "Alex";

type MetricBase = {
  label: string;
  unit: Unit;
  /** Where the number comes from, shown on the card. */
  source: string;
  /** Older data than this is Stale. */
  staleAfterHours: number;
};

/**
 * How a weekly value is read. `sum`: the week's stored value (minus another metric when `minus` is set);
 * over several weeks the values add up. `ratio`: numerator over denominator, no data when the denominator
 * is 0 or missing. `last`: a count at collection time, so only the latest observation matters.
 */
export type MetricSource =
  | { aggregate: "sum" | "last"; metric: MetricKey; minus?: MetricKey }
  | { aggregate: "ratio"; numerator: MetricKey; denominator: MetricKey };

export type HomeMetric = MetricBase & MetricSource;

export type TargetKey = "viewed" | "sent" | "reply" | "deals_created" | "deals_paid";
export type WatchKey = "started_not_sent" | "send_errors" | "search_no_exact" | "listings_live";

export type TargetDef = HomeMetric & {
  key: TargetKey;
  /** Weekly target; for a ratio, the share (1 = all). */
  target: number;
  owner: Owner;
  /** What is counted, shown under the chart. */
  definition: string;
  /** One plain step towards the target, shown in the bottleneck line. */
  nextStep: string;
};

export type WatchDef = HomeMetric & { key: WatchKey };

export const STALE_AFTER_HOURS = 36;
export const MONTHLY_PAID_TARGET = 4;

const POSTHOG = "PostHog";
const DEALS = "Platform deals";
const MESSAGES = "Platform messages";
const LISTINGS = "Platform listings";

/** The five weekly targets, in card order. */
export const TARGETS: TargetDef[] = [
  {
    key: "viewed", definition: "People on a listing page, test accounts left out.",
    label: "Viewed a listing", aggregate: "sum", metric: "viewed_listing", unit: "count",
    target: 100, owner: "Ari", source: POSTHOG, staleAfterHours: STALE_AFTER_HOURS,
    nextStep: "Bring more buyers to listing pages.",
  },
  {
    key: "sent", definition: "People whose message, offer or buy went through.",
    label: "Messages, offers or buys sent", aggregate: "sum", metric: "sent_contact", unit: "count",
    target: 5, owner: "Ari", source: POSTHOG, staleAfterHours: STALE_AFTER_HOURS,
    nextStep: "See where buyers stop between starting and sending in Marketplace Pulse.",
  },
  {
    key: "reply", definition: "Buyer questions and offers at least a day old, answered by us or the seller within 24 hours. Gaps are weeks with no questions.",
    label: "Buyers answered within 24 hours", aggregate: "ratio", numerator: "reply_24h", denominator: "reply_intents",
    unit: "percent", target: 1, owner: "Alex", source: MESSAGES, staleAfterHours: STALE_AFTER_HOURS,
    nextStep: "Answer open buyer questions and offers the same day.",
  },
  {
    key: "deals_created", definition: "Deals created, test buyers left out.",
    label: "Deals created", aggregate: "sum", metric: "deals_created", unit: "count",
    target: 2, owner: "Alex", source: DEALS, staleAfterHours: STALE_AFTER_HOURS,
    nextStep: "Follow up buyers who showed intent in Marketplace Pulse.",
  },
  {
    key: "deals_paid", definition: "Deals whose first payment was captured.",
    label: "Deals paid", aggregate: "sum", metric: "deals_paid", unit: "count",
    target: 1, owner: "Alex", source: DEALS, staleAfterHours: STALE_AFTER_HOURS,
    nextStep: "Chase accepted deals that are not paid yet.",
  },
];

/** When two targets are equally far behind, the earlier one here is named. */
export const BOTTLENECK_PRECEDENCE: TargetKey[] = ["reply", "sent", "viewed", "deals_created", "deals_paid"];

/** Numbers to keep an eye on, without targets. */
export const WATCH: WatchDef[] = [
  { key: "started_not_sent", label: "Started but not sent", aggregate: "sum", metric: "started_contact", minus: "sent_contact", unit: "count", source: POSTHOG, staleAfterHours: STALE_AFTER_HOURS },
  { key: "send_errors", label: "Send errors", aggregate: "sum", metric: "drop_contact_error", unit: "count", source: POSTHOG, staleAfterHours: STALE_AFTER_HOURS },
  { key: "search_no_exact", label: "Search found no exact match", aggregate: "sum", metric: "drop_search_no_exact", unit: "count", source: POSTHOG, staleAfterHours: STALE_AFTER_HOURS },
  { key: "listings_live", label: "Live listings", aggregate: "last", metric: "listings_live", unit: "count", source: LISTINGS, staleAfterHours: STALE_AFTER_HOURS },
];

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function shiftWeek(weekStart: string, by: number): string {
  return new Date(Date.parse(`${weekStart}T00:00:00Z`) + by * 7 * DAY_MS).toISOString().slice(0, 10);
}

/** A week is complete once its Monday plus seven days has passed (UTC). */
export function isWeekComplete(weekStart: string, now: Date): boolean {
  return Date.parse(`${weekStart}T00:00:00Z`) + 7 * DAY_MS <= now.getTime();
}

/** The Monday of the last complete week: the week before the one `now` falls in. */
export function lastCompleteWeek(now: Date): string {
  return shiftWeek(mondayOf(now), -1);
}

/** `count` consecutive week starts ending with `end`, oldest first. */
export function weekRange(end: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftWeek(end, i - count + 1));
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A metric's value for one week. `numerator`/`denominator` are set for ratios ("x of y"). */
export type MetricValue = { value: number; numerator?: number; denominator?: number };

/** One week's value, or null when there is no data. Never invents a 0. */
export function weekValue(def: MetricSource, week: PulseWeek | undefined): MetricValue | null {
  if (!week) return null;
  const v = week.values;
  if (def.aggregate === "ratio") {
    const numerator = v[def.numerator];
    const denominator = v[def.denominator];
    if (denominator === undefined || denominator <= 0) return null;
    const answered = numerator ?? 0;
    return { value: answered / denominator, numerator: answered, denominator };
  }
  const value = v[def.metric];
  if (value === undefined) return null;
  if (!def.minus) return { value };
  // "11 of 14": what is left of the base metric.
  const left = Math.max(0, value - (v[def.minus] ?? 0));
  return { value: left, numerator: left, denominator: value };
}

/** The latest week with a value for `def`, for `last` metrics like live listings. */
export function latestValue(def: MetricSource, weeks: PulseWeek[]): { week_start: string; value: MetricValue } | null {
  for (const week of weeks.toSorted((a, b) => b.week_start.localeCompare(a.week_start))) {
    const value = weekValue(def, week);
    if (value) return { week_start: week.week_start, value };
  }
  return null;
}

export type SeriesPoint = { week_start: string; value: MetricValue | null };

/** A value per calendar week in the range, with null gaps for weeks without data. */
export function series(def: MetricSource, weeks: PulseWeek[], end: string, count: number): SeriesPoint[] {
  const byWeek = new Map(weeks.map((w) => [w.week_start, w]));
  return weekRange(end, count).map((week_start) => ({ week_start, value: weekValue(def, byWeek.get(week_start)) }));
}

/** Weeks whose Monday falls in a month ("YYYY-MM"). */
export function weeksInMonth(weeks: PulseWeek[], month: string): PulseWeek[] {
  return weeks.filter((w) => w.week_start.slice(0, 7) === month);
}

/** Adds up a metric over the weeks attributed to a month, or null when none of them has it. */
export function monthTotal(weeks: PulseWeek[], metric: MetricKey, month: string): number | null {
  const values = weeksInMonth(weeks, month).map((w) => w.values[metric]).filter((v): v is number => v !== undefined);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

// ---------------------------------------------------------------------------
// Freshness and status
// ---------------------------------------------------------------------------

export type Freshness = { collected_at: string | null; hours_old: number | null; stale: boolean };

/** Stale when nothing was ever collected, or the last collection is older than the limit. */
export function freshness(collectedAt: string | null, now: Date, staleAfterHours = STALE_AFTER_HOURS): Freshness {
  if (!collectedAt) return { collected_at: null, hours_old: null, stale: true };
  const hours = (now.getTime() - Date.parse(collectedAt)) / 3_600_000;
  return { collected_at: collectedAt, hours_old: Math.round(hours * 10) / 10, stale: hours > staleAfterHours };
}

export type Status = "on-target" | "close" | "behind" | "stale" | "no-data";

export const STATUS_LABELS: Record<Status, string> = {
  "on-target": "On target",
  close: "Close",
  behind: "Behind",
  stale: "Stale",
  "no-data": "No data",
};

/** Share of target reached (1 = on target), or null without a value. */
export function progress(def: TargetDef, value: MetricValue | null): number | null {
  if (!value || def.target <= 0) return null;
  return value.value / def.target;
}

/** Stale data wins over everything; then no data; then 100% on target, 75% close, below that behind. */
export function statusFor(ratio: number | null, stale: boolean): Status {
  if (stale) return "stale";
  if (ratio === null) return "no-data";
  if (ratio >= 1) return "on-target";
  if (ratio >= 0.75) return "close";
  return "behind";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatValue(def: HomeMetric, value: MetricValue | null): string {
  if (!value) return "No data yet";
  if (value.numerator !== undefined && value.denominator !== undefined) return `${value.numerator} of ${value.denominator}`;
  if (def.unit === "percent") return `${Math.round(value.value * 100)}%`;
  if (def.unit === "gbp") return `£${Math.round(value.value).toLocaleString("en-GB")}`;
  return Math.round(value.value).toLocaleString("en-GB");
}

/** "all" for a full-share ratio, otherwise the weekly number. */
export function formatTarget(def: TargetDef): string {
  if (def.unit === "percent") return def.target >= 1 ? "all" : `${Math.round(def.target * 100)}%`;
  return def.target.toLocaleString("en-GB");
}

/** "about £0", "about £4.5k": the paid values are estimates (METRICS.paid_value_gbp). */
export function aboutPounds(value: number | null): string {
  if (value === null) return "No data yet";
  if (Math.abs(value) >= 1000) return `about £${Math.round(value / 100) / 10}k`;
  return `about £${Math.round(value).toLocaleString("en-GB")}`;
}

/** "12 Oct" */
export function dayLabel(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// Page sections
// ---------------------------------------------------------------------------

export type TargetCard = {
  key: TargetKey;
  label: string;
  definition: string;
  unit: Unit;
  owner: Owner;
  source: string;
  target: number;
  target_label: string;
  week_start: string;
  value: MetricValue | null;
  value_label: string;
  ratio: number | null;
  status: Status;
  /** Twelve weeks ending with the last complete week; the sparkline shows the last ten. */
  history: SeriesPoint[];
};

export function targetCards(weeks: PulseWeek[], now: Date, collectedAt: string | null): TargetCard[] {
  const end = lastCompleteWeek(now);
  const week = weeks.find((w) => w.week_start === end);
  return TARGETS.map((def) => {
    const value = weekValue(def, week);
    const ratio = progress(def, value);
    return {
      key: def.key, label: def.label, definition: def.definition, unit: def.unit, owner: def.owner, source: def.source,
      target: def.target, target_label: formatTarget(def), week_start: end,
      value, value_label: formatValue(def, value), ratio,
      status: statusFor(ratio, freshness(collectedAt, now, def.staleAfterHours).stale),
      history: series(def, weeks, end, 12),
    };
  });
}

export type Bottleneck =
  | { kind: "behind"; key: TargetKey; sentence: string; reason: string; next_step: string }
  | { kind: "on-target"; sentence: string }
  | { kind: "no-data"; sentence: string };

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/**
 * The target furthest behind last week (lowest share of target), ties broken by BOTTLENECK_PRECEDENCE.
 * `week` is last complete week's row, for the reply reason ("3 of 4 never answered").
 */
export function bottleneck(cards: TargetCard[], week?: PulseWeek): Bottleneck {
  const rank = (key: TargetKey) => BOTTLENECK_PRECEDENCE.indexOf(key);
  const measured = cards.filter((c) => c.ratio !== null);
  if (!measured.length) return { kind: "no-data", sentence: "No numbers for last week yet, so there is nothing to compare with the targets." };
  const worst = measured.toSorted((a, b) => a.ratio! - b.ratio! || rank(a.key) - rank(b.key))[0];
  if (worst.ratio! >= 1) return { kind: "on-target", sentence: "Every target with numbers was met last week." };
  const def = TARGETS.find((t) => t.key === worst.key)!;
  const unanswered = week?.values.reply_none;
  const reason = worst.key === "reply" && unanswered !== undefined && worst.value?.denominator
    ? `${unanswered} of last week's ${worst.value.denominator} buyer questions and offers ${unanswered === 1 ? "has" : "have"} had no reply at all.`
    : `Furthest behind of the ${WORDS[cards.length] ?? cards.length} targets, at ${Math.round(worst.ratio! * 100)}% of target.`;
  return {
    kind: "behind",
    key: worst.key,
    sentence: `${worst.label}: ${worst.value_label} last week (target: ${worst.target_label})`,
    reason,
    next_step: def.nextStep,
  };
}

export type Goal = {
  /** "YYYY-MM" */
  month: string;
  month_label: string;
  paid: number | null;
  target: number;
  /** Today's place in the month, 0 to 1, for the pace marker. */
  pace: number;
  paid_value_gbp: number | null;
  deals_created: number | null;
  last_month_label: string;
  last_month_paid: number | null;
  last_month_paid_value_gbp: number | null;
};

const monthKey = (date: Date) => date.toISOString().slice(0, 7);
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });

/** Month to date (UTC), counting each week in the month its Monday falls in. */
export function goal(weeks: PulseWeek[], now: Date): Goal {
  const month = monthKey(now);
  const lastMonth = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    month,
    month_label: monthName(month),
    paid: monthTotal(weeks, "deals_paid", month),
    target: MONTHLY_PAID_TARGET,
    pace: now.getUTCDate() / daysInMonth,
    paid_value_gbp: monthTotal(weeks, "paid_value_gbp", month),
    deals_created: monthTotal(weeks, "deals_created", month),
    last_month_label: monthName(lastMonth),
    last_month_paid: monthTotal(weeks, "deals_paid", lastMonth),
    last_month_paid_value_gbp: monthTotal(weeks, "paid_value_gbp", lastMonth),
  };
}

export type WatchItem = {
  key: WatchKey;
  label: string;
  week_start: string | null;
  value: MetricValue | null;
  value_label: string;
  /** "Up from 542", "Down from 2 of 6 the week before"; null with nothing to compare. */
  comparison: string | null;
  trend: SeriesPoint[];
};

function compare(def: HomeMetric, value: MetricValue | null, previous: MetricValue | null, suffix: string): string | null {
  if (!value || !previous) return null;
  if (value.value === previous.value) return `Same as ${suffix ? suffix.replace(/^ /, "") : "before"}`;
  return `${value.value > previous.value ? "Up" : "Down"} from ${formatValue(def, previous)}${suffix}`;
}

/** Last complete week for weekly numbers; the latest observation for `last` numbers. */
export function watchItems(weeks: PulseWeek[], now: Date): WatchItem[] {
  const end = lastCompleteWeek(now);
  const byWeek = new Map(weeks.map((w) => [w.week_start, w]));
  return WATCH.map((def) => {
    if (def.aggregate === "last") {
      const latest = latestValue(def, weeks);
      const before = latest ? latestValue(def, weeks.filter((w) => w.week_start < latest.week_start)) : null;
      return {
        key: def.key, label: def.label, week_start: latest?.week_start ?? null,
        value: latest?.value ?? null, value_label: formatValue(def, latest?.value ?? null),
        comparison: compare(def, latest?.value ?? null, before?.value ?? null, ""),
        trend: series(def, weeks, latest?.week_start ?? end, 8),
      };
    }
    const value = weekValue(def, byWeek.get(end));
    return {
      key: def.key, label: def.label, week_start: end,
      value, value_label: formatValue(def, value),
      comparison: compare(def, value, weekValue(def, byWeek.get(shiftWeek(end, -1))), " the week before"),
      trend: series(def, weeks, end, 8),
    };
  });
}

export type NeedsYouItem = {
  id: string;
  kind: "alert" | "waiting" | "follow-up";
  /** Short tag shown on the row. */
  tag: "DATA" | "ERROR" | "REPLY";
  severity: "high" | "normal";
  title: string;
  detail: string | null;
  owner: Owner;
  /** When it started waiting, for oldest-first order and the age. */
  at: string;
  person_id: string | null;
  url: string | null;
};

export const NEEDS_YOU_LIMIT = 7;
/** Owns the Marketplace Pulse collector, so stale numbers go to them. */
export const DATA_OWNER: Owner = "Ari";
const ownerOf = (key: TargetKey) => TARGETS.find((t) => t.key === key)!.owner;

/**
 * What needs someone today, from data only: system alerts (stale numbers, send errors last week),
 * offers and deals waiting on us, and buyers not contacted since they last showed intent.
 * High severity first, then oldest first.
 */
export function needsYou(input: {
  now: Date;
  collectedAt: string | null;
  weeks: PulseWeek[];
  waiting: WaitingItem[];
  followUps: FollowUp[];
}): { items: NeedsYouItem[]; total: number } {
  const items: NeedsYouItem[] = [];
  const fresh = freshness(input.collectedAt, input.now);
  if (fresh.stale && fresh.collected_at) {
    items.push({
      id: "alert:stale", kind: "alert", tag: "DATA", severity: "high",
      title: `Marketplace numbers are stale since ${dayLabel(fresh.collected_at)}`,
      detail: "The Marketplace Pulse collector has not run since then",
      owner: DATA_OWNER, at: fresh.collected_at, person_id: null, url: null,
    });
  }
  const end = lastCompleteWeek(input.now);
  const errors = input.weeks.find((w) => w.week_start === end)?.values.drop_contact_error;
  if (errors !== undefined && errors > 0) {
    items.push({
      id: "alert:contact-error", kind: "alert", tag: "ERROR", severity: "normal",
      title: `${errors} buyer${errors === 1 ? "" : "s"} hit an error sending a message, offer or buy`,
      detail: `Week of ${dayLabel(end)}`,
      owner: ownerOf("sent"), at: `${end}T00:00:00Z`, person_id: null, url: null,
    });
  }
  input.waiting.forEach((w, i) => {
    items.push({
      id: `waiting:${i}`, kind: "waiting", tag: "REPLY", severity: "normal",
      title: `${w.buyer}: ${w.kind === "offer" ? "offer not answered" : "deal not paid"}`,
      detail: [w.text, w.listing_title].filter(Boolean).join(" · ") || null,
      owner: ownerOf("reply"), at: w.at, person_id: null, url: w.listing_url,
    });
  });
  for (const f of input.followUps) {
    if (f.contacted_since) continue;
    items.push({
      id: `follow-up:${f.key}`, kind: "follow-up", tag: "REPLY", severity: "normal",
      title: `${f.name} is waiting to hear from us`,
      detail: [f.latest.text, f.latest.listing_title].filter(Boolean).join(" · ") || null,
      owner: ownerOf("reply"), at: f.latest.at, person_id: f.person_id, url: f.person_id ? null : f.latest.listing_url,
    });
  }
  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1) || a.at.localeCompare(b.at));
  return { items: items.slice(0, NEEDS_YOU_LIMIT), total: items.length };
}

/** "4d", "5h", "now": how long an item has waited. */
export function ageLabel(at: string, now: Date): string {
  const hours = (now.getTime() - Date.parse(at)) / 3_600_000;
  if (hours < 1) return "now";
  return hours < 24 ? `${Math.floor(hours)}h` : `${Math.floor(hours / 24)}d`;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export type HomeData = {
  now: string;
  freshness: Freshness;
  last_week: string;
  goal: Goal;
  bottleneck: Bottleneck;
  needs_you: NeedsYouItem[];
  needs_you_total: number;
  cards: TargetCard[];
  watch: WatchItem[];
  follow_up_error: string | null;
};

export function buildHome(input: {
  now: Date;
  weeks: PulseWeek[];
  collectedAt: string | null;
  waiting: WaitingItem[];
  followUps: FollowUp[];
  followUpError: string | null;
}): HomeData {
  const cards = targetCards(input.weeks, input.now, input.collectedAt);
  const needs = needsYou(input);
  return {
    now: input.now.toISOString(),
    freshness: freshness(input.collectedAt, input.now),
    last_week: lastCompleteWeek(input.now),
    goal: goal(input.weeks, input.now),
    bottleneck: bottleneck(cards, input.weeks.find((w) => w.week_start === lastCompleteWeek(input.now))),
    needs_you: needs.items,
    needs_you_total: needs.total,
    cards,
    watch: watchItems(input.weeks, input.now),
    follow_up_error: input.followUpError,
  };
}
