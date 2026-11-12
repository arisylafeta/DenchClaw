
/**
 * The one chase clock (slice 3, docs/bulk-relay-system/next-step.md). Pure, shared by Relay threads, stored matches
 * (supplier confirmations and seller re-confirms) and buyer offers; mirrored once in scripts/rebattery/relay_scan.py
 * (chase_clock), and chase-clock.cases.json pins both to the same answers.
 *
 * - Day 0 is the London day our message went. Chases fall due on working day 1, 3 and 5 after it (Monday to Friday, no
 *   bank holidays), counted from our first message that is still unanswered, not from the last chase.
 * - A reply from them stops the clock at once.
 * - After the third chase, once a working day has passed since it, parking is proposed: a suggestion with one click,
 *   never done by itself. Nothing on this clock sends: a due chase is a draft for a person to send.
 */

export const CHASE_DAYS = [1, 3, 5] as const;
export const MAX_CHASES = CHASE_DAYS.length;

export type ChaseState = "answered" | "waiting" | "due" | "park";
export type ChaseInput = {
  /** Our first message that is still unanswered (or when we asked, for a stored match). */
  since: Date | string | null;
  /** Our newest message on it (the last chase); `since` when unknown. */
  last?: Date | string | null;
  /** Chases already sent after `since`. */
  chases: number;
  /** They wrote after `since`. */
  answered?: boolean;
};
export type ChaseClock = {
  state: ChaseState;
  /** Working days since `since`. */
  waited: number;
  chases: number;
  /** The chase now due or next due (1 to 3); null once three have gone or they answered. */
  next: number | null;
  /** The London date the next chase falls due on; null when none is left. */
  due_on: string | null;
};

const DAY = 86_400_000;

/** The London calendar date of an instant, as YYYY-MM-DD. */
export function londonDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new Error("Not a date.");
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole Monday to Friday days from `from` (exclusive) to `to` (inclusive), by London date. Never negative. The day a
 * message was sent does not count; the first full working day after it is day one. */
export function workingDaysBetween(from: Date | string, to: Date | string): number {
  const start = Date.parse(`${londonDate(from)}T00:00:00Z`);
  const end = Date.parse(`${londonDate(to)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  let count = 0;
  for (let time = start + DAY; time <= end; time += DAY) {
    const weekday = new Date(time).getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      count += 1;
    }
  }
  return count;
}

/** The London date `days` working days after the London date of `from`. */
export function addWorkingDays(from: Date | string, days: number): string {
  let time = Date.parse(`${londonDate(from)}T00:00:00Z`);
  let left = Math.max(0, days);
  while (left > 0) {
    time += DAY;
    const weekday = new Date(time).getUTCDay();
    if (weekday >= 1 && weekday <= 5) left -= 1;
  }
  return new Date(time).toISOString().slice(0, 10);
}

export function chaseClock(input: ChaseInput, now: Date | string = new Date()): ChaseClock {
  const chases = Math.max(0, Math.floor(input.chases || 0));
  if (!input.since || input.answered) {
    return { state: "answered", waited: 0, chases, next: null, due_on: null };
  }
  const waited = workingDaysBetween(input.since, now);
  if (chases >= MAX_CHASES) {
    const quiet = workingDaysBetween(input.last ?? input.since, now);
    return { state: quiet >= 1 ? "park" : "waiting", waited, chases, next: null, due_on: null };
  }
  const day = CHASE_DAYS[chases];
  return { state: waited >= day ? "due" : "waiting", waited, chases, next: chases + 1, due_on: addWorkingDays(input.since, day) };
}

/** "Chase 2 of 3 due", "Waiting 2 working days", "3 chases unanswered: park it?" */
export function chaseLabel(clock: ChaseClock): string {
  const days = (n: number) => `${n} working ${n === 1 ? "day" : "days"}`;
  switch (clock.state) {
    case "answered": return "They answered";
    case "due": return `Chase ${clock.next} of ${MAX_CHASES} due (${days(clock.waited)} without an answer)`;
    case "park": return `${MAX_CHASES} chases unanswered: park it?`;
    default: return clock.waited === 0 ? "Sent today, no answer yet" : `Waiting ${days(clock.waited)}, no answer`;
  }
}

// ---------- working hours (the lead rule) ----------

/** A new lead should have its first reply within two working hours: Monday to Friday, 09:00 to 18:00 London. */
export const LEAD_GOAL_WORKING_MINUTES = 120;
const OPEN_HOUR = 9;
const CLOSE_HOUR = 18;

/** London's offset from UTC at an instant, in milliseconds (0 in winter, one hour in summer). */
function londonOffset(at: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000;
}

/** The instant of a London wall-clock hour on a London date. 09:00 and 18:00 are never inside a clock change. */
function londonAt(date: string, hour: number): number {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  return guess - londonOffset(guess);
}

/** Minutes between two instants that fall inside working hours (Monday to Friday, 09:00 to 18:00 London). */
export function workingMinutesBetween(from: Date | string, to: Date | string = new Date()): number {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  let total = 0;
  for (let day = Date.parse(`${londonDate(new Date(start))}T00:00:00Z`); day <= Date.parse(`${londonDate(new Date(end))}T00:00:00Z`); day += DAY) {
    const weekday = new Date(day).getUTCDay();
    if (weekday < 1 || weekday > 5) continue;
    const date = new Date(day).toISOString().slice(0, 10);
    const open = Math.max(start, londonAt(date, OPEN_HOUR));
    const close = Math.min(end, londonAt(date, CLOSE_HOUR));
    if (close > open) total += close - open;
  }
  return Math.floor(total / 60_000);
}

/** An enquiry still unanswered after two working hours. */
export const leadLate = (arrivedAt: Date | string | null | undefined, now: Date | string = new Date()) =>
  !!arrivedAt && workingMinutesBetween(arrivedAt, now) > LEAD_GOAL_WORKING_MINUTES;
