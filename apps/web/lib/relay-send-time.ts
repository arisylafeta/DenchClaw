/**
 * Send-later times for Relay, in London time. Alex often clears mail late at night and wants replies to land the next
 * morning: the quick picks are 8:00 and 10:00 on the next working-hours day, plus Monday 8:00 when that day is a weekend.
 */

const ZONE = "Europe/London";
const pad = (n: number) => String(n).padStart(2, "0");

/** The London wall-clock parts of an instant. */
function londonParts(at: Date): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { year: +get("year"), month: +get("month"), day: +get("day"), hour: +get("hour") % 24, minute: +get("minute"), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}

/** The instant a London wall-clock time happens ("2026-11-09", "08:00"). Handles the BST/GMT switch. */
export function londonWallToUtc(date: string, time: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let k = 0; k < 3; k++) {
    const p = londonParts(new Date(guess));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wall - shown;
  }
  return new Date(guess);
}

/** "YYYY-MM-DD" of the London day `days` after the day of `at`. */
function londonDate(at: Date, days = 0): string {
  const p = londonParts(at);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export type SendSlot = { at: string; label: string };

/**
 * Quick send-later picks. The day is the next morning: today if it is still before 7:30 in London (replying after
 * midnight), else tomorrow. If that morning is a Saturday or Sunday, Monday 8:00 is offered as well.
 */
export function sendSlots(now = new Date()): SendSlot[] {
  const p = londonParts(now);
  const day = londonDate(now, p.hour * 60 + p.minute < 7 * 60 + 30 ? 0 : 1);
  const slots = ["08:00", "10:00"].map((t) => londonWallToUtc(day, t));
  const weekday = londonParts(slots[0]).weekday;
  if (weekday === 6 || weekday === 0) slots.push(londonWallToUtc(londonDate(slots[0], weekday === 6 ? 2 : 1), "08:00"));
  return slots.map((at) => ({ at: at.toISOString(), label: sendLabel(at, now) }));
}

/** Short label: "Today 8:00", "Tomorrow 10:00", "Mon 8:00", or "Mon 16 Nov, 8:00" beyond a week. */
export function sendLabel(at: Date | string, now = new Date()): string {
  const when = new Date(at);
  const p = londonParts(when);
  const time = `${p.hour}:${pad(p.minute)}`;
  const day = londonDate(when);
  if (day === londonDate(now)) return `Today ${time}`;
  if (day === londonDate(now, 1)) return `Tomorrow ${time}`;
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, weekday: "short" }).format(when);
  if (when.getTime() - now.getTime() < 6 * 86_400_000) return `${weekday} ${time}`;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, day: "numeric", month: "short" }).format(when);
  return `${weekday} ${date}, ${time}`;
}

export const MAX_SCHEDULE_DAYS = 60;

/** Why a send-later time can't be used, or null when it can: at least 2 minutes ahead and within 60 days. */
export function sendAtProblem(at: Date, now = new Date()): string | null {
  if (!Number.isFinite(at.getTime())) return "Pick a valid time.";
  if (at.getTime() < now.getTime() + 2 * 60_000) return "Pick a time in the future.";
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) return `Pick a time within ${MAX_SCHEDULE_DAYS} days.`;
  return null;
}

/** London "YYYY-MM-DDTHH:MM" for a datetime-local input. */
export function londonInputValue(at: Date): string {
  const p = londonParts(at);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
