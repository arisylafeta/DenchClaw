import { MAX_CHASES } from "./chase-clock";
import { numbersKnown } from "./relay-lead-core";

/**
 * A chase draft, the pure part. When the chase clock (chase-clock.ts) says a chase is due on a thread Alex wrote last
 * on, Relay prepares a draft into Review for a person to send. Like the lead card's reply, no sentence in it is a
 * model's: a greeting by first name (from the thread, never guessed), one fixed line per chase, and Alex's sign-off.
 * `verifyChase` is the last gate before the draft is saved: it refuses any number, day, month or money the thread and
 * the deal do not have, a greeting name the thread does not have, and any name of the other side of the deal.
 */

export type ChaseDraft = { subject: string; body: string };

/** One line per chase: short, no figure, no price, nothing about the other side. */
export const CHASE_LINES: Record<number, string> = {
  1: "Just checking my last email reached you. Could you let me know when you have a moment?",
  2: "Following up on my email below. Is this still of interest?",
  3: "One last nudge on my email below. If now is not the right time, just say and I will close this off for now.",
};

/** "Re: <their subject>", without stacking Re: or Fwd:. */
export function chaseSubject(subject: string | null | undefined): string {
  const bare = (subject ?? "").replace(/^\s*((re|aw|fw|fwd)\s*:\s*)+/i, "").trim();
  return bare ? `Re: ${bare}`.slice(0, 300) : "Re:";
}

export function chaseDraft(chase: number, firstName: string | null, subject: string | null | undefined): ChaseDraft {
  const line = CHASE_LINES[Math.min(Math.max(1, Math.floor(chase)), MAX_CHASES)];
  return { subject: chaseSubject(subject), body: `${firstName ? `Hi ${firstName},` : "Hello,"}\n\n${line}\n\nBest,\nAlex` };
}

const MONEY = /[€£$]|\b(?:eur|gbp|usd|euros?|pounds?|dollars?|pence|quid)\b|\bper\s+(?:kwh|mwh|kg|tonne|unit|pack|module|cell)\b/i;
/** Days and months in words are figures too: a chase may only name one the thread already has. */
const DATE_WORD = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b(?:january|february|march|april|june|july|august|september|october|november|december|tomorrow|tonight)\b/gi;
const NAME_IN_GREETING = /^(?:hi|hello|dear)\s+([^,\n]+),/i;

export type ChaseCheck = { ok: true } | { ok: false; reason: string };

/**
 * `known` is everything the thread and the deal say (messages, subject, deal summary); `others` are the names of the
 * deal's other side (the matched buyers or sellers, the paired listing's party), which must never reach this thread.
 */
export function verifyChase(body: string, known: string, others: string[]): ChaseCheck {
  if (!body.trim()) return { ok: false, reason: "empty" };
  if (!numbersKnown(body, known)) return { ok: false, reason: "a number that is not in the thread or the deal" };
  const words = new Set(known.toLowerCase().match(/\p{L}+/gu) ?? []);
  const dates = (body.match(DATE_WORD) ?? []).filter((word) => !words.has(word.toLowerCase()));
  if (dates.length) return { ok: false, reason: `a day or month that is not in the thread: ${dates[0]}` };
  if (MONEY.test(body)) return { ok: false, reason: "a price or a sum of money" };
  const greeted = body.match(NAME_IN_GREETING)?.[1]?.trim();
  if (greeted && !known.toLowerCase().includes(greeted.toLowerCase())) return { ok: false, reason: `a name that is not in the thread: ${greeted}` };
  const lower = body.toLowerCase();
  const named = others.map((name) => name.trim()).filter((name) => name.length >= 3).find((name) => lower.includes(name.toLowerCase()));
  if (named) return { ok: false, reason: `names the other side: ${named}` };
  return { ok: true };
}

/** The key that makes a chase prepared once: the same chase on the same unanswered message is never drafted twice,
 * even after a person skipped it. */
export const chaseKey = (chase: number, since: string) => `[chase:${chase} since ${since}]`;
