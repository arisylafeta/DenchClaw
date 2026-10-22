// Home: the CRM landing page. The target registry, the shared week, month and money helpers, and the
// weekly funnel read from Marketplace Pulse's snapshots (crm_metric_snapshots, dimension '').
//
// Weeks start on Monday, UTC. Months are calendar months in UTC. Nothing here invents a 0: a number
// that could not be read is null, and the page shows "No data yet".
import { mondayOf, type MetricKey, type PulseWeek } from "./marketplace-pulse";

// ---------------------------------------------------------------------------
// Targets and configuration
// ---------------------------------------------------------------------------

export type TargetKey = "marketplace_paid" | "bulk_closed" | "fees_long_term" | "seller_reply";

export type TargetDef = {
  key: TargetKey;
  value: number;
  /** How the target reads on the page: "4 paid a month". */
  label: string;
  /** Where the target was agreed, shown next to it. */
  source: string;
  /** Shown in the header's target line. */
  header: boolean;
};

/** The only targets on Home. Add one here, with its source, before showing it anywhere. */
export const TARGETS: Record<TargetKey, TargetDef> = {
  marketplace_paid: { key: "marketplace_paid", value: 4, label: "4 paid a month", source: "Pulse", header: true },
  bulk_closed: { key: "bulk_closed", value: 2, label: "2 bulk a month", source: "19 Oct call", header: true },
  fees_long_term: { key: "fees_long_term", value: 10_000, label: "£10k a month", source: "7 Sep call", header: false },
  // A share: every buyer gets a seller reply within 24 hours.
  seller_reply: { key: "seller_reply", value: 1, label: "all", source: "Pulse", header: false },
};

/** One fixed rate for euro fees. Amounts converted with it are labelled "about". */
export const EUR_GBP = 0.86;
/** Smallest initial payment that counts as a paid deal; smaller ones are card tests. */
export const MIN_PAID_AMOUNT = 50;
/** Seller replies are measured on buyer conversations opened from this day. */
export const REPLY_SINCE = "2026-08-01";
/** A seller has a day to answer before a question counts as never answered. */
export const REPLY_WINDOW_HOURS = 24;
/** Weekly snapshots older than this are stale. */
export const STALE_AFTER_HOURS = 36;
/** Weeks on the overview chart, the current one included. */
export const OVERVIEW_WEEKS = 13;
/** Most weeks on a funnel step chart. */
export const FUNNEL_WEEKS = 13;
/** A funnel step needs this many people entering it in the last four weeks to be called the biggest drop. */
export const MIN_STEP_DENOMINATOR = 5;
/** Bulk lots with no touch for this many days are quiet. */
export const QUIET_DAYS = 7;
/** PostHog has seen about half of public visitors since the consent banner changed on this day. */
export const POSTHOG_UNDERCOUNT_SINCE = "2026-08-27";

// ---------------------------------------------------------------------------
// Days, weeks and months
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;

export { mondayOf };

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

/** The Monday-start UTC week a timestamp falls in. */
export function weekOf(iso: string): string {
  return mondayOf(new Date(iso));
}

/** "YYYY-MM" in UTC. */
export function monthOf(iso: string | Date): string {
  return (typeof iso === "string" ? new Date(iso) : iso).toISOString().slice(0, 7);
}

/** Whole days from `iso` to `now`, rounded down. */
export function daysBetween(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);
}

export type MonthPosition = { month: string; day: number; days_in_month: number; share: number };

/** Today's place in the month (UTC): day 22 of 31 is 0.71 of the way through. */
export function monthPosition(now: Date): MonthPosition {
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { month: monthOf(now), day: now.getUTCDate(), days_in_month: days, share: now.getUTCDate() / days };
}

export type Pace = { target: number; pace: number; to_go: number; share_of_month: number };

/** Where a monthly count should be by today if it ran evenly: 4 a month on day 22 of 31 is 2.8. */
export function pace(count: number, target: number, now: Date): Pace {
  const position = monthPosition(now);
  return {
    target,
    pace: Math.round(target * position.share * 10) / 10,
    to_go: Math.max(0, target - count),
    share_of_month: position.share,
  };
}

// ---------------------------------------------------------------------------
// Money and labels
// ---------------------------------------------------------------------------

/** Pounds for a platform amount, or null for a currency without a configured rate. */
export function toGbp(amount: number, currency: string | null | undefined): number | null {
  const code = (currency ?? "gbp").toLowerCase();
  if (code === "gbp") {return amount;}
  if (code === "eur") {return amount * EUR_GBP;}
  return null;
}

/** "£24.6k", "£155": short pounds for cards. */
export function shortPounds(value: number): string {
  if (Math.abs(value) >= 1000) {return `£${(Math.round(value / 100) / 10).toLocaleString("en-GB")}k`;}
  return `£${Math.round(value).toLocaleString("en-GB")}`;
}

/** "12 Oct" */
export function dayLabel(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** "Thursday 22 October" */
export function longDayLabel(now: Date): string {
  return now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

/** "October" */
export function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
}

export const percent = (share: number | null): string => (share === null ? "No data yet" : `${Math.round(share * 100)}%`);

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export type Freshness = { collected_at: string | null; hours_old: number | null; stale: boolean };

/** Stale when nothing was ever collected, or the last collection is older than the limit. */
export function freshness(collectedAt: string | null, now: Date, staleAfterHours = STALE_AFTER_HOURS): Freshness {
  if (!collectedAt) {return { collected_at: null, hours_old: null, stale: true };}
  const hours = (now.getTime() - Date.parse(collectedAt)) / 3_600_000;
  return { collected_at: collectedAt, hours_old: Math.round(hours * 10) / 10, stale: hours > staleAfterHours };
}

// ---------------------------------------------------------------------------
// Weekly funnel (snapshots)
// ---------------------------------------------------------------------------

export type FunnelStepKey = "visit_view" | "view_start" | "start_send" | "send_paid";

export type FunnelStepDef = {
  key: FunnelStepKey;
  label: string;
  den: MetricKey;
  num: MetricKey;
  den_label: string;
  num_label: string;
};

export const FUNNEL_STEPS: FunnelStepDef[] = [
  { key: "visit_view", label: "Visit to listing view", den: "visitors", num: "viewed_listing", den_label: "Visitors", num_label: "Viewed a listing" },
  { key: "view_start", label: "View to start", den: "viewed_listing", num: "started_contact", den_label: "Viewed a listing", num_label: "Started a message, offer or buy" },
  { key: "start_send", label: "Start to send", den: "started_contact", num: "sent_contact", den_label: "Started", num_label: "Sent" },
  { key: "send_paid", label: "Send to paid", den: "sent_contact", num: "deals_paid", den_label: "Sent", num_label: "Paid deals" },
];

const FUNNEL_METRICS = new Set<MetricKey>(FUNNEL_STEPS.flatMap((s) => [s.den, s.num]));
const hasFunnelData = (week: PulseWeek | undefined) =>
  !!week && Object.keys(week.values).some((k) => FUNNEL_METRICS.has(k as MetricKey));

/** The latest complete week with funnel numbers, or null before the first collection. */
export function funnelEnd(weeks: PulseWeek[], now: Date): string | null {
  const last = lastCompleteWeek(now);
  const ends = weeks.filter((w) => w.week_start <= last && hasFunnelData(w)).map((w) => w.week_start).toSorted();
  return ends.at(-1) ?? null;
}

/** Up to `max` calendar weeks ending with `end`, starting at the first week with funnel numbers. */
export function funnelWeeks(weeks: PulseWeek[], end: string, max = FUNNEL_WEEKS): string[] {
  const byWeek = new Map(weeks.map((w) => [w.week_start, w]));
  const range = weekRange(end, max);
  const first = range.findIndex((w) => hasFunnelData(byWeek.get(w)));
  return first < 0 ? [] : range.slice(first);
}

export type WindowRate = { num: number; den: number; rate: number | null };

/** Adds a step's numerator and denominator over calendar weeks. A missing week adds nothing. */
export function windowRate(step: FunnelStepDef, weeks: PulseWeek[], weekStarts: string[]): WindowRate {
  const byWeek = new Map(weeks.map((w) => [w.week_start, w]));
  let num = 0;
  let den = 0;
  for (const start of weekStarts) {
    const values = byWeek.get(start)?.values;
    num += values?.[step.num] ?? 0;
    den += values?.[step.den] ?? 0;
  }
  return { num, den, rate: den > 0 ? num / den : null };
}

export type FunnelStepStat = FunnelStepDef & {
  current: WindowRate;
  previous: WindowRate;
  /** Percentage points, current minus previous; null when either side has no rate. */
  delta_pts: number | null;
  /** Weekly entered and passed, for the step chart; null for a week without numbers. */
  weekly: { week_start: string; den: number | null; num: number | null }[];
};

/** Each step's last four weeks against the four before, ending with `end`. */
export function funnelSteps(weeks: PulseWeek[], end: string, chartWeeks: string[]): FunnelStepStat[] {
  const current = weekRange(end, 4);
  const previous = weekRange(shiftWeek(end, -4), 4);
  const byWeek = new Map(weeks.map((w) => [w.week_start, w]));
  return FUNNEL_STEPS.map((step) => {
    const cur = windowRate(step, weeks, current);
    const prev = windowRate(step, weeks, previous);
    return {
      ...step,
      current: cur,
      previous: prev,
      delta_pts: cur.rate === null || prev.rate === null ? null : (cur.rate - prev.rate) * 100,
      weekly: chartWeeks.map((week_start) => {
        const values = byWeek.get(week_start)?.values;
        return { week_start, den: values?.[step.den] ?? null, num: values?.[step.num] ?? null };
      }),
    };
  });
}

/**
 * The step whose conversion fell most against the four weeks before. Only steps that fell, and that at
 * least MIN_STEP_DENOMINATOR people entered in the last four weeks, can be named.
 */
export function biggestDrop(steps: FunnelStepStat[], minDen = MIN_STEP_DENOMINATOR): FunnelStepKey | null {
  let worst: FunnelStepStat | null = null;
  for (const step of steps) {
    if (step.delta_pts === null || step.delta_pts >= 0 || step.current.den < minDen) {continue;}
    if (!worst || step.delta_pts < worst.delta_pts!) {worst = step;}
  }
  return worst?.key ?? null;
}

/** Paid deals over sent intents across the chart weeks: "3 paid of 26 sent". */
export function fillRate(weeks: PulseWeek[], weekStarts: string[]): WindowRate {
  return windowRate(FUNNEL_STEPS[3], weeks, weekStarts);
}

/** Sum of a snapshot metric over the weeks from `fromWeek`, or null when no week has it. */
export function snapshotSum(weeks: PulseWeek[], metric: MetricKey, fromWeek: string): number | null {
  const values = weeks.filter((w) => w.week_start >= fromWeek).map((w) => w.values[metric]).filter((v): v is number => v !== undefined);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}
