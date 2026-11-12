import { numbersKnown } from "./relay-lead-core";

/**
 * The Relay inbox as lanes, the pure part: which lane an email sits in, the numbers on the tiles, and what is kept of
 * the answers the reader suggests for an email that needs a reply.
 *
 * A suggested answer is a choice for Alex to pick, never a fact of its own: one with a number that is not in the
 * emails is dropped, and one that needs something only Alex knows says what he has to add.
 */

export type SuggestAnswer = { label: string; note: string; fill: string | null };
/** quiet: the reader said the email needs no reply, which is not the same as no answer surviving the checks. */
export type Suggestion = { ask: string | null; answers: SuggestAnswer[]; quiet: boolean };
export type SuggestView = Suggestion & { status: "preparing" | "ready" | "none" | "failed"; message_id: string };

const MAX_ANSWERS = 4;
const tidy = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");
/** A price or a sum of money, which no suggested answer may carry: Alex types those himself. */
const MONEY = /[£€$]|\b(?:gbp|eur|usd|pounds?|euros?|dollars?|quid|pence)\b|\bper\s+(?:kwh|mwh|kg|tonne|unit|pack|module|cell)\b|\/\s?(?:kwh|mwh|kg)\b/i;

/** What the reader returned, with everything the emails do not back dropped. `text` is what the reader was given. */
export function verifySuggest(raw: unknown, text: string): Suggestion {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ask = tidy(o.ask);
  const seen = new Set<string>();
  const answers: SuggestAnswer[] = [];
  for (const a of Array.isArray(o.answers) ? o.answers : []) {
    if (!a || typeof a !== "object") continue;
    const { label: l, note: n, fill: f } = a as Record<string, unknown>;
    const label = tidy(l).replace(/[.]+$/, "");
    const note = tidy(n);
    const fill = tidy(f).replace(/[.]+$/, "");
    if (label.length < 2 || label.length > 48 || note.length < 8 || note.length > 280 || fill.length > 48) continue;
    if (MONEY.test(`${label} ${note}`) || !numbersKnown(`${label} ${note}`, text)) continue;
    // What Alex has to add is named, never given: a fill with a figure in it would put that figure in the note.
    if (MONEY.test(fill) || /\d/.test(fill)) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    answers.push({ label, note, fill: fill && !/^(null|none|n\/a)$/i.test(fill) ? fill : null });
    if (answers.length === MAX_ANSWERS) break;
  }
  return { ask: ask && ask.length <= 140 && !/^(null|none)$/i.test(ask) ? ask : null, answers, quiet: Array.isArray(o.answers) && !o.answers.length };
}

type LaneItem = { id: string; bulk_listing_id: string | null };
type LaneCard = { item_id: string; status: string; who: { at: string } };
export type Lanes<I, C> = { leads: C[]; deals: I[]; replies: I[] };

/** New leads (a card being read, ready or failed) oldest first; then emails on a deal; then everything else that needs a
 * reply. Deals and replies keep the order they came in: most pressing first, then longest waiting. */
export function sortLanes<I extends LaneItem, C extends LaneCard>(items: I[], cards: C[]): Lanes<I, C> {
  const open = new Set(items.map((i) => i.id));
  const leads = cards.filter((c) => open.has(c.item_id) && ["preparing", "ready", "failed"].includes(c.status))
    .sort((a, b) => (Date.parse(a.who.at) || 0) - (Date.parse(b.who.at) || 0));
  const taken = new Set(leads.map((c) => c.item_id));
  const rest = items.filter((i) => !taken.has(i.id));
  return { leads, deals: rest.filter((i) => i.bulk_listing_id), replies: rest.filter((i) => !i.bulk_listing_id) };
}

/** A lead's row title as the inbox writes it, "what · how many · where", and the facts left for the chips. With fewer
 * than two of the three known, the title stays the one-line summary and every fact is left for the chips. */
export function leadTitle<F extends { key: string; value: string }>(facts: F[], summary: string): { title: string; rest: F[] } {
  const parts = ["what", "how_many", "where"].map((key) => facts.find((f) => f.key === key && f.value.trim())).filter((f): f is F => !!f);
  if (parts.length < 2) return { title: summary, rest: facts };
  return { title: parts.map((f) => f.value.trim()).join(" · "), rest: facts.filter((f) => !parts.includes(f)) };
}

/** How long something has waited, as the tiles and rows write it: "45 min", "22 h", "3 d". */
export function waited(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
}

/** A new lead should have its reply within two working hours. */
export const LEAD_GOAL_MINUTES = 120;

/** The lead that has waited longest, for the fourth tile. */
export function oldestLead(cards: LaneCard[], now = Date.now()): { waited: string; late: boolean } | null {
  const times = cards.map((c) => Date.parse(c.who.at)).filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  const oldest = Math.min(...times);
  return { waited: waited(new Date(oldest).toISOString(), now), late: now - oldest > LEAD_GOAL_MINUTES * 60_000 };
}

const GREETING = /^(?:hi|hello|hey|dear|morning|afternoon|good (?:morning|afternoon|evening)|greetings)\b[^.!?\n]{0,40}[,!:]?$/i;
const QUOTED = /^(?:>|on .{4,120} wrote:\s*$|-{2,}\s*original message|from:\s)/i;
const SIGN_OFF = /^(?:best|regards|kind regards|best regards|warm regards|many thanks|thanks|thank you|cheers|sincerely|br|all the best)\b[^.!?]{0,30}$/i;

/**
 * A few of their own words for an inbox row: the first question in their email, or else its opening. The greeting, the
 * sign-off and anything quoted from an earlier email are skipped; the words are theirs, cut at a word, never reworded.
 */
export function theirWords(text: string | null | undefined, max = 220): string | null {
  const lines: string[] = [];
  for (const raw of (text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (QUOTED.test(line) || (lines.length && SIGN_OFF.test(line))) break;
    if (line && !(lines.length === 0 && GREETING.test(line))) lines.push(line);
  }
  const flat = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const sentences = flat.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [flat];
  const asked = sentences.slice(0, 8).find((x) => x.endsWith("?") && x.length >= 12);
  let words = asked ?? "";
  if (!words) for (const x of sentences) { if (words && (words + " " + x).length > max) break; words = words ? `${words} ${x}` : x; }
  return words.length > max ? `${words.slice(0, max).replace(/\s+\S*$/, "")}…` : words;
}
