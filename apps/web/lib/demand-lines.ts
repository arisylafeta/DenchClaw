import { MAKE_WORDS, PLATFORMS } from "./demand-match";

/**
 * A request's pack types ("lines"): what a buyer who wants several kinds of pack asks for, each with how many. R3's
 * "92–102 mixed packs" is five lines: Ioniq 5 77.4 kWh × 8, Zoe 41 kWh × 4, and so on. Kept in the request's
 * `context.lines` (the Details editor rebuilds `spec`, so they would not survive there). Matcha writes them from the
 * buyer's ask; a person edits them on Details. Pure: shared by the server, the route and the page.
 */
export type DemandLine = {
  id: string;
  /** "VW MEB 82 kWh": how the page names it. */
  label: string;
  /** The words a seller writes for it: makes, models or platform names ("meb", "ioniq 5", "zoe", "stellantis"). */
  products: string[];
  /** The capacities that count, in kWh; empty takes any. A stated pack within 5% of one counts. */
  kwh: number[];
  qty_min: number;
  /** A ranged need ("10–20"); null when one number. */
  qty_max: number | null;
};

export const MAX_LINES = 12;
/** A stated capacity within this share of a line's counts as that line. */
export const KWH_TOLERANCE = 0.05;

const ID = /^[a-z0-9]{4,24}$/;
const newId = () => Math.random().toString(36).slice(2, 10);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : null);

/** Checks the lines a person or Matcha sends: a name each, sensible numbers, at most twelve. Ids are kept or made. */
export function parseLines(raw: unknown): { value: DemandLine[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "lines must be a list." };
  if (raw.length > MAX_LINES) return { error: `At most ${MAX_LINES} pack types.` };
  const out: DemandLine[] = [];
  const ids = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const at = `Pack type ${i + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `${at} must be an object.` };
    const o = item as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.replace(/\s+/g, " ").trim() : "";
    if (!label || label.length > 80) return { error: `${at} needs a name of up to 80 characters.` };
    const products = Array.isArray(o.products) ? o.products : o.products == null ? [] : null;
    if (!products || products.length > 10 || products.some((p) => typeof p !== "string" || !p.trim() || p.trim().length > 40)) {
      return { error: `${at}: up to 10 words a seller writes, each up to 40 characters.` };
    }
    const kwh = Array.isArray(o.kwh) ? o.kwh.map(num) : o.kwh == null ? [] : [null];
    if (kwh.length > 6 || kwh.some((k) => k == null || k <= 0 || k > 300)) return { error: `${at}: up to 6 capacities, each between 0 and 300 kWh.` };
    const min = int(o.qty_min);
    const max = o.qty_max == null || o.qty_max === "" ? null : int(o.qty_max);
    if (min == null || min < 1 || min > 100_000) return { error: `${at}: how many must be a whole number from 1.` };
    if (o.qty_max != null && o.qty_max !== "" && (max == null || max < min || max > 100_000)) return { error: `${at}: the most must be a whole number, at least the fewest.` };
    let id = typeof o.id === "string" && ID.test(o.id) ? o.id : newId();
    while (ids.has(id)) id = newId();
    ids.add(id);
    out.push({ id, label, products: [...new Set((products as string[]).map((p) => p.trim().toLowerCase()))], kwh: [...new Set(kwh as number[])], qty_min: min, qty_max: max === min ? null : max });
  }
  return { value: out };
}

/** "10–20" or "8". */
export const needText = (line: Pick<DemandLine, "qty_min" | "qty_max">) =>
  line.qty_max ? `${line.qty_min.toLocaleString("en-GB")}–${line.qty_max.toLocaleString("en-GB")}` : line.qty_min.toLocaleString("en-GB");

/** The most of a line that counts towards the need: the top of a range, else the number. */
export const lineCap = (line: Pick<DemandLine, "qty_min" | "qty_max">) => line.qty_max ?? line.qty_min;

const norm = (text: string) => ` ${text.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9.\- ]+/g, " ").replace(/\s+/g, " ").trim()} `;
const MAKE_GROUPS = new Map(Object.entries(MAKE_WORDS).map(([key, words]) => [key.toLowerCase(), words]));
const MAKES = new Set(Object.values(MAKE_WORDS).flat());

/** A product word and what it covers: a platform's models, a make group's makes, or the word itself. 2 is a model, 1 a make. */
function expand(word: string): { words: string[]; specific: number } {
  const platform = PLATFORMS[word];
  if (platform) return { words: [word, ...platform.models], specific: 2 };
  const group = MAKE_GROUPS.get(word);
  if (group) return { words: group, specific: 1 };
  return { words: [word], specific: MAKES.has(word) ? 1 : 2 };
}

/** What a line needs to know about a stock line. */
export type LineCandidate = { make: string | null; model: string | null; title: string; kwh: number | null; kwhEstimated?: boolean };
export type LineFit = { line: DemandLine; state: "fits" | "close"; why: string | null };

/**
 * Which of the buyer's pack types a stock line is, if any. The words must name it (a model or platform beats a make);
 * a stated capacity must be within 5% of one the line counts. A line with no stated (or only an estimated) capacity is
 * "close": kWh not stated. Ties go to the more specific words, then the nearer capacity, then the first line.
 */
export function lineFor(c: LineCandidate, lines: DemandLine[]): LineFit | null {
  const text = norm(`${c.make ?? ""} ${c.model ?? ""} ${c.title}`);
  const statedKwh = c.kwh != null && !c.kwhEstimated ? c.kwh : null;
  let best: { fit: LineFit; specific: number; gap: number } | null = null;
  for (const line of lines) {
    let specific = 0;
    if (line.products.length) {
      for (const product of line.products) {
        const { words, specific: s } = expand(product);
        if (words.some((w) => text.includes(norm(w)))) specific = Math.max(specific, s);
      }
      if (!specific) continue;
    }
    let state: LineFit["state"] = "fits";
    let why: string | null = null;
    let gap = 0;
    if (line.kwh.length) {
      if (statedKwh == null) { state = "close"; why = "kWh not stated"; gap = 1; }
      else {
        gap = Math.min(...line.kwh.map((k) => Math.abs(statedKwh - k) / k));
        if (gap > KWH_TOLERANCE) continue;
      }
    }
    const better = !best || specific > best.specific || (specific === best.specific && (state === "fits" && best.fit.state === "close" || (state === best.fit.state && gap < best.gap)));
    if (better) best = { fit: { line, state, why }, specific, gap };
  }
  return best?.fit ?? null;
}
