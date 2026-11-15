/** Day maths for next actions. Days are "YYYY-MM-DD" strings in UTC, like `next_due`. */

const toDate = (day: string) => new Date(`${day}T12:00:00Z`);
const toDay = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(day: string, days: number): string {
  const date = toDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return toDay(date);
}

/** The Monday after `day` (never `day` itself). */
export function nextMonday(day: string): string {
  const weekday = toDate(day).getUTCDay();
  return addDays(day, ((8 - weekday) % 7) || 7);
}

/** "Wed 18" */
export const weekdayDay = (day: string) => {
  const date = toDate(day);
  return `${date.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${date.getUTCDate()}`;
};

/** "2 Nov" */
export const dayMonth = (day: string) => toDate(day).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export type QuickDay = { label: string; day: string };

/** Today, Tomorrow, in 3 days and next Monday, named the same way everywhere. Duplicate days are dropped. */
export function quickDays(today: string): QuickDay[] {
  const days = [today, addDays(today, 1), addDays(today, 3), nextMonday(today)];
  const seen = new Set<string>();
  return days.filter((day) => (seen.has(day) ? false : (seen.add(day), true))).map((day) => ({ day, label: shortDue(day, today) }));
}

/** "Today", "Tomorrow", "Wed 18" within a week, else "18 Nov". */
export function shortDue(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  if (day > today && day < addDays(today, 7)) return weekdayDay(day);
  return dayMonth(day);
}

export type DueTone = "overdue" | "today" | "later";

/** The due pill: "Overdue 2 Nov", "Today", "Tomorrow", "Wed 18", "No date". */
export function dueLabel(due: string | null | undefined, today: string): { text: string; tone: DueTone | null } {
  const day = due?.slice(0, 10);
  if (!day) return { text: "No date", tone: null };
  if (day < today) return { text: `Overdue ${dayMonth(day)}`, tone: "overdue" };
  if (day === today) return { text: "Today", tone: "today" };
  return { text: shortDue(day, today), tone: "later" };
}
