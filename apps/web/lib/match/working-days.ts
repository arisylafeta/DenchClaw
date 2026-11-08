// Working days for the chase rule: Monday to Friday, in London, with no column and no timers.
// The day an email was sent does not count; the first full working day after it is day one.

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

const DAY = 86_400_000;
const at = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** Whole Monday to Friday days from `from` (exclusive) to `to` (inclusive). Never negative. */
export function workingDaysBetween(from: Date | string, to: Date | string): number {
  const start = at(londonDate(from));
  const end = at(londonDate(to));
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

/** No reply after three working days means a chase. The plan's loop says "no reply 3 working days". */
export const CHASE_AFTER_WORKING_DAYS = 3;

/** True when an email sent at `sentAt` has gone unanswered for long enough to chase at `now`. */
export function chaseDue(sentAt: Date | string, now: Date | string = new Date()): boolean {
  return workingDaysBetween(sentAt, now) >= CHASE_AFTER_WORKING_DAYS;
}
