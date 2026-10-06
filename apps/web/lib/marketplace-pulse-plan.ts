// The Marketplace Pulse growth plan: today's funnel rates, the fixes planned for each step, what the
// plan adds up to, and where we should be on the way to the target. Pure functions, no I/O.
import { CHANNELS, sumBy, weeksWith, type Breakdown, type PulseWeek } from "./marketplace-pulse";

export const STEPS = [
  { key: "visitors", label: "Visitors", unit: "per month" },
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
  /** How many full weeks the rates come from (at most 4). */
  weeks: number;
  fill: number | null;
  reply: { within24h: number | null; asked: number; unanswered: number; medianHours: number | null };
};

const ratio = (part: number, whole: number) => (whole > 0 ? Math.min(1, part / whole) : undefined);

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
  const medians = chosen.map((w) => w.values.reply_median_hours).filter((v): v is number => typeof v === "number");
  return {
    rates,
    weeks: ids.length,
    fill: ratio(paid, sent) ?? null,
    reply: {
      within24h: ratio(total("reply_24h"), total("reply_intents")) ?? null,
      asked: total("reply_intents"),
      unanswered: total("reply_none"),
      medianHours: medians.length ? medians.sort((a, b) => a - b)[Math.floor(medians.length / 2)] : null,
    },
  };
}

export const paidPerMonth = (r: Rates) => r.visitors * r.viewed * r.started * r.sent * r.deal * r.paid;
export const sendsPerMonth = (r: Rates) => r.visitors * r.viewed * r.started * r.sent;

/** Today's rates, filling a step with no data from the first fix that sets it, else 0. */
export function baseline(measured: Partial<Rates>, levers: Lever[]): Rates {
  const out = {} as Rates;
  for (const { key } of STEPS) out[key] = measured[key] ?? levers.find((l) => l.steps[key] !== undefined)?.steps[key] ?? 0;
  return out;
}

export type WaterfallStep = { lever: Lever; before: number; after: number; delta: number; rates: Rates };

/** Applies each fix in order; each one's contribution is the paid deals it adds on top of the ones before. */
export function waterfall(start: Rates, levers: Lever[]): { steps: WaterfallStep[]; final: Rates } {
  let rates = { ...start };
  const steps: WaterfallStep[] = [];
  for (const lever of levers) {
    const before = paidPerMonth(rates);
    rates = { ...rates, ...lever.steps };
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

export type Standing = "On track" | "Slightly behind" | "Off track";
export function standing(actual: number, expected: number): Standing {
  if (expected <= 0 || actual >= expected * 0.9) return "On track";
  return actual >= expected * 0.6 ? "Slightly behind" : "Off track";
}

/** Paid deals over each rolling four full weeks, as a monthly rate, ending on each week. */
export function actualSeries(weeks: PulseWeek[]): { week_start: string; paid: number }[] {
  return weeks.slice(3).map((w, i) => ({
    week_start: w.week_start,
    paid: weeks.slice(i, i + 4).reduce((sum, x) => sum + (x.values.deals_paid ?? 0), 0) * MONTH_PER_WEEK / 4,
  }));
}

/** Sends a month by channel over the last four full weeks with breakdowns. */
export function channelSends(weeks: PulseWeek[], breakdowns: Breakdown[]): Map<string, number> {
  const ids = weeksWith(breakdowns, "channel_sent", weeks.map((w) => w.week_start)).slice(-4);
  const sums = sumBy(breakdowns, "channel_sent", ids);
  return new Map([...sums].map(([channel, sent]) => [channel, ids.length ? (sent * MONTH_PER_WEEK) / ids.length : 0]));
}

/** Checks a plan from the browser before it is saved. Returns the cleaned plan or an error. */
export function parsePlan(input: unknown): { plan: Plan } | { error: string } {
  const p = input as Partial<Plan> | null;
  if (!p || typeof p !== "object") return { error: "The plan must be an object." };
  const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(day(v));
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!num(p.target_paid)) return { error: "The target must be a number of 0 or more." };
  if (!isDate(p.target_date)) return { error: "The target date must be a date." };
  if (!p.start || !isDate(p.start.date) || !num(p.start.paid)) return { error: "The plan needs a start date and starting paid deals." };
  if (day(p.target_date as string) <= day(p.start.date)) return { error: "The target date must be after the start." };
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
    levers.push({ id: text(l.id, 40) || `fix-${i + 1}`, name, owner: text(l.owner, 40), status: l.status as LeverStatus, steps });
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
