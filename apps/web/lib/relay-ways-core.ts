import { numbersKnown } from "./relay-lead-core";

/**
 * Review, the pure part: the gaps in a draft and the other ways to answer an email.
 *
 * A gap is a place where the reply needs something only Alex knows (a price, a quantity, a day). Relay never writes
 * that for him: the draft carries a marker, the page shows it as a field to fill, and nothing with a gap can be sent.
 * A way is a whole reply that handles the email differently. One with a number the emails do not back is dropped.
 */

export type Way = { title: string; body: string };
/** original: the way as Relay wrote it, kept so a later edit by Alex is learned against the right text. */
export type StoredWay = Way & { original: string | null };
export type WaysState<W extends Way = Way> = { status: "preparing" | "ready" | "failed"; picked: number; ways: W[]; at?: string };

/**
 * [BLANK: what is needed], a bare [BLANK], and the older all-capitals kind such as [PRICE]. Read loosely on purpose
 * ([BLANK - price], [BLANK price], [ PRICE ], a label with brackets of its own): a marker the page misses would show
 * as plain text and could be sent.
 */
const GAP = /\[\s*(?:(?:BLANK|Blank|blank)\b[ \t]*[:\-\u2013\u2014]?[ \t]*((?:[^\[\]]|\[[^\[\]]{0,40}\]){0,300})|([A-Z][A-Z ]{2,}))\s*\]/g;

export type Segment = { text: string } | { gap: string; index: number };

/** The draft as text and gaps, in order. A gap's label names what is missing; a bare marker has none. */
export function segments(body: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  let index = 0;
  for (const m of body.matchAll(GAP)) {
    if (m.index > at) out.push({ text: body.slice(at, m.index) });
    out.push({ gap: (m[1] ?? m[2]?.toLowerCase() ?? "").replace(/\s+/g, " ").trim(), index: index++ });
    at = m.index + m[0].length;
  }
  if (at < body.length) out.push({ text: body.slice(at) });
  return out;
}

export const gapCount = (body: string) => [...body.matchAll(GAP)].length;
export const hasGap = (body: string) => gapCount(body) > 0;

/** The draft with each gap that has a value filled in. A gap with no value keeps its marker. */
export function fillGaps(body: string, values: readonly (string | undefined)[]): string {
  let index = 0;
  return body.replace(GAP, (marker) => values[index++]?.trim() || marker);
}

const MAX_OTHERS = 2;
const line = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");
const copy = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "");
const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
const title = (v: unknown) => line(v).replace(/[.:]+$/, "");
const goodTitle = (t: string) => t.length >= 2 && t.length <= 40 && !/[\d£€$]/.test(t);

/**
 * What the writer returned, with everything unusable dropped: the name for the draft Alex already has, and up to two
 * other ways. `current` is that draft; `known` is everything the writer was given, and a way with a number that is not
 * in it is dropped whole, never patched.
 */
export function verifyWays(raw: unknown, current: string, known: string): { current: string; others: Way[] } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const named = title(o.current);
  const others: Way[] = [];
  for (const w of Array.isArray(o.ways) ? o.ways : []) {
    if (others.length >= MAX_OTHERS) break;
    if (!w || typeof w !== "object") continue;
    const t = title((w as Record<string, unknown>).title);
    const body = copy((w as Record<string, unknown>).body);
    if (!goodTitle(t) || body.length < 20 || body.length > 4000) continue;
    if (same(body, current) || others.some((x) => same(x.body, body) || same(x.title, t))) continue;
    if (!numbersKnown(body, `${known}\n${current}`)) continue;
    others.push({ title: t, body });
  }
  return { current: goodTitle(named) && !others.some((x) => same(x.title, named)) ? named : "First draft", others };
}

/** The first words of a way, for its tab. Gaps read as an ellipsis. */
export function preview(body: string, max = 90): string {
  const flat = body.replace(GAP, "…").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).replace(/\s+\S*$/, "")}…` : flat;
}
