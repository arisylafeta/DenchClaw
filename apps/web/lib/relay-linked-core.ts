import { moneyMentions } from "./relay-leak-core";

/**
 * Emails to the other side of a deal, the pure part: which of someone's threads a question belongs on, which pack an email
 * is about, and whether the price we give a buyer is under what we recorded as the cost. The I/O is in relay-linked.ts.
 */

/** One address, dots in the name and capitals aside: Gmail search drops the dots (rickimayhew@ for ricki.mayhew@). */
export function mailbox(address: string): string {
  const [name, domain] = address.trim().toLowerCase().split("@");
  return domain ? `${name.replace(/\./g, "")}@${domain}` : name;
}
export const sameMailbox = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && mailbox(a) === mailbox(b);
/** The same reading in SQL, for a column or expression. */
export const mailboxSql = (x: string) => `(replace(split_part(lower(${x}), '@', 1), '.', '') || '@' || split_part(lower(${x}), '@', 2))`;

/** The marketplace listings an email links to: their slugs, in order. */
export function listingSlugs(text: string): string[] {
  return [...new Set([...text.matchAll(/rebattery\.io\/(?:[a-z]{2}\/)?marketplace\/([a-z0-9][a-z0-9-]{3,})/gi)].map((m) => m[1].toLowerCase()))].filter((s) => s !== "auctions");
}

/** Supplier stock tags an email names ("tag 13319144"). */
export const stockTags = (text: string) => [...new Set([...text.matchAll(/\btag\s*(?:no\.?|number|#)?\s*(\d{5,12})\b/gi)].map((m) => m[1]))];

/**
 * The listings in play: those in the newest email that links any. Older emails offer packs the buyer has since passed over.
 * `emails` newest first.
 */
export function newestSlugs(emails: readonly string[]): string[] {
  for (const text of emails) { const slugs = listingSlugs(text); if (slugs.length) return slugs; }
  return [];
}

const WORD = /[a-z0-9.]{3,}/g;
const STOP = new Set("the and for you your with from have has are was our this that not can could would please thanks hi hello best regards alex rebattery battery pack packs".split(" "));
const tokens = (text: string) => new Set((text.toLowerCase().match(WORD) ?? []).map((t) => t.replace(/^\.+|\.+$/g, "")).filter((t) => t.length > 2 && !STOP.has(t)));

/** How much a thread is about the same thing: words in common with what we asked, a number (a tag, a kWh) counting five times. */
export function threadScore(about: string, thread: string): number {
  const a = tokens(about);
  let score = 0;
  for (const t of tokens(thread)) if (a.has(t)) score += /\d{4,}/.test(t) ? 5 : 1;
  return score;
}

/** What we recorded as the cost of the pack an email is about. */
export type KnownCost = { label: string; supplier: string | null; amount: number; currency: "GBP" | "EUR" | "USD"; source: string | null; listed: number | null };

const SIGN = { GBP: "£", EUR: "€", USD: "$" } as const;
const currencyOf = (found: string): KnownCost["currency"] | null => (/£|gbp|pound|quid/i.test(found) ? "GBP" : /€|eur/i.test(found) ? "EUR" : /\$|usd/i.test(found) ? "USD" : null);
const money = (c: KnownCost["currency"], n: number) => `${SIGN[c]}${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;

/**
 * Prices in an email to a buyer that are under the cost we recorded, one line each for Alex. Amounts far below the cost
 * (under 40%) are something else: a delivery charge, a deposit. With several packs in play only a figure under the
 * cheapest one is certain. Never blocks: the recorded cost may be old.
 */
export function costClashes(body: string, costs: readonly KnownCost[]): string[] {
  const out: string[] = [];
  for (const m of moneyMentions(body)) {
    const currency = currencyOf(m.found);
    const same = costs.filter((c) => c.currency === currency && c.amount > 0);
    if (!currency || !same.length) continue;
    const cost = same.reduce((low, c) => (c.amount < low.amount ? c : low));
    if (m.value >= cost.amount || m.value < cost.amount * 0.4) continue;
    const line = `${money(currency, m.value)} is ${money(currency, Math.round((cost.amount - m.value) * 100) / 100)} under the cost on record for ${cost.label}: ${money(currency, cost.amount)}${cost.source ? ` (${cost.source})` : ""}.`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** The costs the leak guard keeps out of a buyer's email. One equal to the listed price is public already. */
export const secretCosts = (costs: readonly KnownCost[]) => costs.filter((c) => c.listed !== c.amount);
