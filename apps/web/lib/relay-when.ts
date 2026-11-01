/** Turns "call Lubomir next wed at 3pm" into a title and a day. Plain rules, no guessing; the UI shows the resolved day. */
export type When = { title: string; date: string; time: string | null; matched: string };

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_RE = "(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const dayIndex = (word: string) => DAYS.indexOf(word.slice(0, 3).toLowerCase());
const monthIndex = (word: string) => MONTHS.indexOf(word.slice(0, 3).toLowerCase());

/** Today's calendar day in London, as a UTC-midnight Date so arithmetic is exact. */
export function londonToday(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

function timeOf(text: string): { time: string; matched: string } | null {
  const m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text) ?? /\bat\s+(\d{1,2})(?::(\d{2}))?\b/i.exec(text) ?? /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  if (!m) return null;
  let hour = Number(m[1]); const minute = Number(m[2] ?? 0); const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { time: `${pad(hour)}:${pad(minute)}`, matched: m[0] };
}

/**
 * Finds a day in the text. Rules:
 * - today, tomorrow, "in N days/weeks"
 * - a weekday ("wed") is its next occurrence after today; "next wed" is that weekday in next week (Mon to Sun)
 * - "next week" is next Monday; "next month" is the 1st of next month
 * - "12 Nov", "Nov 12", "12/11" (day first), "2026-11-12"; a date already past this year means next year
 */
export function parseWhen(input: string, now = new Date()): When | null {
  const today = londonToday(now);
  let text = input;
  const t = timeOf(text);
  let date: Date | null = null;
  let matched = "";
  const take = (m: RegExpExecArray | null, value: Date | null) => { if (m && value) { date = value; matched = m[0]; } return !!(m && value); };

  let m: RegExpExecArray | null;
  const rest = t ? text.replace(t.matched, " ") : text;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(rest)) && take(m, new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])))) { /* ISO */ }
  else if ((m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})(?:\\s+(\\d{4}))?\\b`, "i").exec(rest))) take(m, fromMonthDay(today, monthIndex(m[2]), +m[1], m[3] ? +m[3] : null));
  else if ((m = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(rest))) take(m, fromMonthDay(today, monthIndex(m[1]), +m[2], m[3] ? +m[3] : null));
  else if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(rest))) take(m, fromMonthDay(today, +m[2] - 1, +m[1], m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null));
  else if ((m = /\bday after tomorrow\b/i.exec(rest))) take(m, addDays(today, 2));
  else if ((m = /\b(?:tomorrow|tmrw|tmw)\b/i.exec(rest))) take(m, addDays(today, 1));
  else if ((m = /\b(?:today|tonight)\b/i.exec(rest))) take(m, today);
  else if ((m = /\bin\s+(\d{1,3})\s*(day|days|week|weeks)\b/i.exec(rest))) take(m, addDays(today, +m[1] * (m[2].startsWith("w") ? 7 : 1)));
  else if ((m = /\bnext\s+week\b/i.exec(rest))) take(m, addDays(today, 7 - ((today.getUTCDay() + 6) % 7)));
  else if ((m = /\bnext\s+month\b/i.exec(rest))) take(m, new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)));
  else if ((m = new RegExp(`\\b(next\\s+)?(${DAY_RE})\\b`, "i").exec(rest))) {
    const target = dayIndex(m[2]);
    let ahead = (target - today.getUTCDay() + 7) % 7 || 7;
    if (m[1]) { const mondayNext = 7 - ((today.getUTCDay() + 6) % 7); ahead = mondayNext + ((target + 6) % 7); }
    take(m, addDays(today, ahead));
  }
  if (!date) return null;
  const chosen: Date = date;
  if (chosen.getTime() < today.getTime()) return null;
  let title = text;
  for (const piece of [matched, t?.matched]) if (piece) title = title.replace(piece, " ");
  title = title.replace(/\b(?:on|for|by|at|remind me to|remind me|reminder to|reminder)\b\s*$/i, " ").replace(/^\s*(?:remind me to|remind me|add a to-?do to|add a to-?do)\s+/i, "").replace(/\s{2,}/g, " ").replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "");
  return { title, date: iso(chosen), time: t?.time ?? null, matched: [matched, t?.matched].filter(Boolean).join(" ") };
}

function fromMonthDay(today: Date, month: number, day: number, year: number | null): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  let candidate = new Date(Date.UTC(year ?? today.getUTCFullYear(), month, day));
  if (candidate.getUTCMonth() !== month) return null;
  if (!year && candidate.getTime() < today.getTime()) candidate = new Date(Date.UTC(today.getUTCFullYear() + 1, month, day));
  return candidate;
}

/** "Wed 11 Nov" (plus the time when one was given). */
export function describeWhen(date: string, time: string | null): string {
  const d = new Date(`${date}T00:00:00Z`);
  const label = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(d);
  return `${label} ${time ?? "08:00"}`;
}
