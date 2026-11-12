// Working days for the chase rule: Monday to Friday, in London, with no column and no timers. The clock itself is
// lib/chase-clock.ts (one clock for Relay threads, stored matches and offers); this keeps the names offers use.
import { CHASE_DAYS, chaseClock } from "../chase-clock";

export { londonDate, workingDaysBetween } from "../chase-clock";

/** The first chase falls due on working day 1 (the clock's day 1, 3 and 5). It was 3 for offers until 12 Nov 2026. */
export const CHASE_AFTER_WORKING_DAYS = CHASE_DAYS[0];

/** True when an email sent at `sentAt`, with `chases` chases already sent after it, is due its next chase at `now`. */
export function chaseDue(sentAt: Date | string, now: Date | string = new Date(), chases = 0): boolean {
  return chaseClock({ since: sentAt, chases }, now).state === "due";
}
