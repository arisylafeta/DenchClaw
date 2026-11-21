/**
 * Send-later times for Relay, in London time. Alex often clears mail late at night and wants replies to land the next
 * morning: the quick picks are 8:00, 9:00 and 10:00 on the next working-hours day, plus Monday 8:00 when that day is a weekend.
 */

/** How long Send holds an email so Alex can undo it. */
export const UNDO_SEND_SECONDS = 30;

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
 * Quick send-later picks: the next morning at 8am, 11am and 2pm, and the morning after at 8am. The next morning is today
 * if it is still before 7:30 in London (replying after midnight), else tomorrow.
 */
export function sendSlots(now = new Date()): SendSlot[] {
  const p = londonParts(now);
  const ahead = p.hour * 60 + p.minute < 7 * 60 + 30 ? 0 : 1;
  const day = londonDate(now, ahead);
  const after = londonDate(now, ahead + 1);
  return [[day, "08:00"], [day, "11:00"], [day, "14:00"], [after, "08:00"]]
    .map(([d, t]) => londonWallToUtc(d, t))
    .map((at) => ({ at: at.toISOString(), label: hourLabel(sendLabel(at, now)) }));
}

/** "Tomorrow 14:00" as people say it: "Tomorrow 2pm". Other minutes stay as they are. */
const hourLabel = (label: string) => label.replace(/\b(\d{1,2}):00$/, (_, h: string) => {
  const hour = Number(h);
  return hour === 0 ? "midnight" : hour === 12 ? "noon" : hour < 12 ? `${hour}am` : `${hour - 12}pm`;
});

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

/** Whole seconds left of a Send hold, never more than the hold itself (the browser's clock can differ from the server's). */
export function undoSecondsLeft(at: Date | string, now = new Date()): number {
  return Math.min(UNDO_SEND_SECONDS, Math.max(0, Math.ceil((new Date(at).getTime() - now.getTime()) / 1000)));
}

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

export type SnoozeSlot = { key: string; label: string; at: string; when: string };

/**
 * Snooze picks, in London time: later today (three hours on, while that's still the working day), tomorrow morning,
 * Monday morning when tomorrow isn't Monday, and a week today. Each says when, like "Tomorrow 8:00".
 */
export function snoozeSlots(now = new Date()): SnoozeSlot[] {
  const p = londonParts(now);
  const slots: { key: string; label: string; at: Date }[] = [];
  const later = new Date(Math.ceil((now.getTime() + 3 * 3_600_000) / 1_800_000) * 1_800_000);
  if (londonParts(later).hour < 19 && londonDate(later) === londonDate(now)) slots.push({ key: "later", label: "Later today", at: later });
  slots.push({ key: "tomorrow", label: "Tomorrow morning", at: londonWallToUtc(londonDate(now, 1), "08:00") });
  const toMonday = ((8 - p.weekday) % 7) || 7;
  if (toMonday !== 1) slots.push({ key: "monday", label: p.weekday === 5 || p.weekday === 6 ? "Monday morning" : "Next Monday", at: londonWallToUtc(londonDate(now, toMonday), "08:00") });
  slots.push({ key: "week", label: "In a week", at: londonWallToUtc(londonDate(now, 7), "08:00") });
  return slots.map((s) => ({ key: s.key, label: s.label, at: s.at.toISOString(), when: sendLabel(s.at, now) }));
}
