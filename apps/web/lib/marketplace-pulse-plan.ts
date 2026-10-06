// The Marketplace Pulse growth plan: today's funnel rates, the fixes planned for each step, what the
// plan adds up to, and where we should be on the way to the target. Pure functions, no I/O.
import { CHANNELS, sumBy, weeksWith, type Breakdown, type PulseWeek } from "./marketplace-pulse";

export const STEPS = [
  { key: "visitors", label: "Visitors", unit: "per month (weekly people added up)" },
  { key: "viewed", label: "Viewed a listing", unit: "of visitors" },
  { key: "started", label: "Started", unit: "of viewers" },
  { key: "sent", label: "Sent", unit: "of starters" },
  { key: "deal", label: "Deal agreed", unit: "of sends" },
  { key: "paid", label: "Paid", unit: "of deals" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export type Rates = Record<StepKey, number>;

export const LEVER_STATUSES = ["Planned", "Doing", "Done"] as const;
export type LeverStatus = (typeof LEVER_STATUSES)[number];
export type Lever = { id: string; name: string; owner: string; status: LeverStatus; steps: Partial<Rates> };
export type ChannelGoal = { channel: string; goal: number; owner: string; action: string };
export type Plan = {
  target_paid: number;
  target_date: string;
  /** Where the plan path starts: the date and paid deals a month when the plan was made. */
  start: { date: string; paid: number };
  levers: Lever[];
  channels: ChannelGoal[];
};
export type PlanVersion = { id: string; plan: Plan; created_at: string; created_by_name: string | null };

/** Days in an average month over the days in four weeks: turns a 4-week count into a monthly one. */
const MONTH_PER_WEEK = 30.44 / 7;

export type Measured = {
  rates: Partial<Rates>;
  /** How many full weeks the rates come from (at most 4), and which. */
  weeks: number;
  weekIds: string[];
  /** Steps measured above 100%: tracking misses some of the step before (ad blockers), so treat with care. */
  over: StepKey[];
  fill: number | null;
  reply: { within24h: number | null; asked: number; unanswered: number; medianHours: number | null };
};

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : undefined);

/** Today's rates from the last four full weeks that have funnel rows. */
export function measure(weeks: PulseWeek[], breakdowns: Breakdown[]): Measured {
  const ids = weeksWith(breakdowns, "funnel_reached", weeks.map((w) => w.week_start)).slice(-4);
  const chosen = weeks.filter((w) => ids.includes(w.week_start));
  const funnel = (metric: string) => sumBy(breakdowns, metric, ids).get("All") ?? 0;
  const total = (key: string) => chosen.reduce((sum, w) => sum + (w.values[key as keyof typeof w.values] ?? 0), 0);
  const reached = funnel("funnel_reached");
  const viewed = funnel("funnel_viewed");
  const started = funnel("funnel_started");
  const sent = funnel("funnel_sent");
  const deals = total("deals_created");
  const paid = total("deals_paid");
  const rates: Partial<Rates> = {};
  if (ids.length) rates.visitors = (reached * MONTH_PER_WEEK) / ids.length;
  const set = (key: StepKey, value: number | undefined) => { if (value !== undefined) rates[key] = value; };
  set("viewed", ratio(viewed, reached));
  set("started", ratio(started, viewed));
  set("sent", ratio(sent, started));
  set("deal", ratio(deals, sent));
  set("paid", ratio(paid, deals));
  const medians = chosen.map((w) => w.values.reply_median_hours).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const middle = Math.floor(medians.length / 2);
  return {
    rates,
    weeks: ids.length,
    weekIds: ids,
    over: STEPS.filter(({ key }) => key !== "visitors" && (rates[key] ?? 0) > 1).map(({ key }) => key),
    fill: ratio(paid, sent) ?? null,
    reply: {
      within24h: ratio(total("reply_24h"), total("reply_intents")) ?? null,
      asked: total("reply_intents"),
      unanswered: total("reply_none"),
      // Weekly medians are all that is stored, so this is the typical week's median.
      medianHours: medians.length ? (medians.length % 2 ? medians[middle] : (medians[middle - 1] + medians[middle]) / 2) : null,
    },
  };
}

export const paidPerMonth = (r: Rates) => r.visitors * r.viewed * r.started * r.sent * r.deal * r.paid;
export const sendsPerMonth = (r: Rates) => r.visitors * r.viewed * r.started * r.sent;

export type Baseline = {
  rates: Rates;
  /** Steps with no data, filled from the first fix that sets them, so Today is partly assumed. */
  assumed: StepKey[];
  /** Steps with no data and no fix: Today cannot be worked out. */
  missing: StepKey[];
};

/** Today's rates. A step with no data takes the first fix's value, and says so. */
export function baseline(measured: Partial<Rates>, levers: Lever[]): Baseline {
  const rates = {} as Rates;
  const assumed: StepKey[] = [];
  const missing: StepKey[] = [];
  for (const { key } of STEPS) {
    if (measured[key] !== undefined) {
      rates[key] = measured[key]!;
      continue;
    }
    const fromFix = levers.find((l) => l.steps[key] !== undefined)?.steps[key];
    if (fromFix === undefined) missing.push(key);
    else assumed.push(key);
    rates[key] = fromFix ?? 0;
  }
  return { rates, assumed, missing };
}

export type WaterfallStep = { lever: Lever; before: number; after: number; delta: number; rates: Rates };

/**
 * Applies each fix in order; each one's contribution is the paid deals it adds on top of the ones
 * before. A fix raises a step to its target; one already at or above the target adds nothing.
 */
export function waterfall(start: Rates, levers: Lever[]): { steps: WaterfallStep[]; final: Rates } {
  let rates = { ...start };
  const steps: WaterfallStep[] = [];
  for (const lever of levers) {
    const before = paidPerMonth(rates);
    const raised = { ...rates };
    for (const [key, target] of Object.entries(lever.steps) as [StepKey, number][]) raised[key] = Math.max(rates[key], target);
    rates = raised;
    const after = paidPerMonth(rates);
    steps.push({ lever, before, after, delta: after - before, rates });
  }
  return { steps, final: rates };
}

/** Extra paid deals a month from one more percentage point on each rate, or 10% more visitors. */
export function sensitivity(rates: Rates): Record<StepKey, number> {
  const base = paidPerMonth(rates);
  const out = {} as Record<StepKey, number>;
  for (const { key } of STEPS) {
    const bumped = { ...rates, [key]: key === "visitors" ? rates.visitors * 1.1 : Math.min(1, rates[key] + 0.01) };
    out[key] = paidPerMonth(bumped) - base;
  }
  return out;
}

const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** Paid deals a month the plan expects on a date: a straight line from the start to the target. */
export function planPath(plan: Plan, isoDate: string): number {
  const from = day(plan.start.date);
  const to = day(plan.target_date);
  const at = Math.min(Math.max(day(isoDate), from), to);
  if (to <= from) return plan.target_paid;
  return plan.start.paid + ((plan.target_paid - plan.start.paid) * (at - from)) / (to - from);
}

export type Standing = "On track" | "Slightly behind" | "Off track" | "Not enough weeks yet";
/** Needs a real rolling 4-week figure; with none, it says so rather than guess. */
export function standing(actual: number | null, expected: number): Standing {
  if (actual === null) return "Not enough weeks yet";
  if (actual >= expected * 0.9) return "On track";
  return actual >= expected * 0.6 ? "Slightly behind" : "Off track";
}

const WEEK_MS = 7 * 86_400_000;

/**
 * Paid deals over each rolling four calendar weeks, as a monthly rate, ending on each week. A window
 * with a missing week is skipped rather than divided as if it were whole.
 */
export function actualSeries(weeks: PulseWeek[]): { week_start: string; paid: number }[] {
  const byWeek = new Map(weeks.map((w) => [w.week_start, w]));
  const out: { week_start: string; paid: number }[] = [];
  for (const w of weeks) {
    const window = [0, 1, 2, 3].map((back) => new Date(day(w.week_start) - back * WEEK_MS).toISOString().slice(0, 10));
    if (!window.every((id) => byWeek.has(id))) continue;
    const paid = window.reduce((sum, id) => sum + (byWeek.get(id)!.values.deals_paid ?? 0), 0);
    out.push({ week_start: w.week_start, paid: (paid * MONTH_PER_WEEK) / 4 });
  }
  return out;
}

/** Sends a month by channel over the given weeks (the model's), or the last four with breakdowns. */
export function channelSends(weeks: PulseWeek[], breakdowns: Breakdown[], weekIds?: string[]): Map<string, number> {
  const ids = weekIds?.length ? weekIds : weeksWith(breakdowns, "channel_sent", weeks.map((w) => w.week_start)).slice(-4);
  const sums = sumBy(breakdowns, "channel_sent", ids);
  return new Map([...sums].map(([channel, sent]) => [channel, ids.length ? (sent * MONTH_PER_WEEK) / ids.length : 0]));
}

/** Checks a plan from the browser before it is saved. Returns the cleaned plan or an error. */
export function parsePlan(input: unknown): { plan: Plan } | { error: string } {
  const p = input as Partial<Plan> | null;
  if (!p || typeof p !== "object") return { error: "The plan must be an object." };
  // A real calendar date: 2026-02-31 does not round-trip, so it is refused.
  const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && !Number.isNaN(day(v)) && new Date(day(v)).toISOString().slice(0, 10) === v;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!num(p.target_paid) || (p.target_paid as number) <= 0) return { error: "The target must be more than 0 paid deals a month." };
  if (!isDate(p.target_date)) return { error: "The target date must be a date." };
  if (!p.start || !isDate(p.start.date) || !num(p.start.paid)) return { error: "The plan needs a start date and starting paid deals." };
  if (day(p.target_date as string) <= day(p.start.date)) return { error: "The target date must be after the start." };
  if (day(p.target_date as string) - day(p.start.date) > 3 * 366 * 86_400_000) return { error: "Keep the target date within three years of the start." };
  if (!Array.isArray(p.levers) || p.levers.length > 12) return { error: "A plan has up to 12 fixes." };
  if (!Array.isArray(p.channels) || p.channels.length > CHANNELS.length) return { error: "Too many channel goals." };
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const keys = new Set<string>(STEPS.map((s) => s.key));
  const levers: Lever[] = [];
  for (const [i, raw] of p.levers.entries()) {
    const l = raw as Partial<Lever>;
    const name = text(l?.name, 80);
    if (!name) return { error: `Fix ${i + 1} needs a name.` };
    if (!LEVER_STATUSES.includes(l.status as LeverStatus)) return { error: `Fix ${i + 1} needs a status.` };
    const steps: Partial<Rates> = {};
    for (const [key, value] of Object.entries(l.steps ?? {})) {
      if (!keys.has(key)) return { error: `Fix ${i + 1} changes an unknown step.` };
      if (!num(value) || (key !== "visitors" && (value as number) > 1)) return { error: `Fix ${i + 1}: ${key} must be ${key === "visitors" ? "0 or more" : "between 0% and 100%"}.` };
      steps[key as StepKey] = value as number;
    }
    if (!Object.keys(steps).length) return { error: `Fix ${i + 1} must change at least one step.` };
    // Ids key the editor's rows, so a missing or repeated one gets a fresh one.
    let id = text(l.id, 40);
    if (!id || levers.some((x) => x.id === id)) id = `fix-${i + 1}-${levers.length}`;
    levers.push({ id, name, owner: text(l.owner, 40), status: l.status as LeverStatus, steps });
  }
  const channels: ChannelGoal[] = [];
  for (const raw of p.channels) {
    const c = raw as Partial<ChannelGoal>;
    if (!CHANNELS.includes(c?.channel as (typeof CHANNELS)[number])) return { error: "Unknown channel in the channel plan." };
    if (!num(c.goal)) return { error: `${c.channel}: the goal must be 0 or more.` };
    if (channels.some((x) => x.channel === c.channel)) return { error: `${c.channel} appears twice.` };
    channels.push({ channel: c.channel!, goal: c.goal!, owner: text(c.owner, 40), action: text(c.action, 160) });
  }
  return { plan: { target_paid: p.target_paid!, target_date: p.target_date!, start: { date: p.start.date, paid: p.start.paid }, levers, channels } };
}
