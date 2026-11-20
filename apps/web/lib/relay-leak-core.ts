import { isPersonalDomain } from "./relay-identity";

/**
 * The leak guard, the pure part. Alex brokers: a buyer must never learn who the supplier is or what the supplier
 * charges, and a supplier must never learn who the buyer is or what the buyer pays. Every Relay email is checked
 * against what Relay knows about both sides before it is saved, scheduled, sent or copied to Gmail.
 *
 * Names are matched case-insensitively on word boundaries. A name made only of everyday words ("Green Energy") is
 * matched only as written, with its capitals, so "we back green energy" passes. Money is matched only where it is
 * written as money (a currency sign or code beside it), so "4,500 cells" never passes for £4,500.
 */

export type LeakDraft = { toKind: "buyer" | "supplier" | "other"; body: string };
export type LeakSupplier = { name: string | null; email: string | null; costs: number[] };
export type LeakBuyer = { name: string | null; company: string | null; email: string | null; prices: number[] };
export type LeakFacts = { suppliers: LeakSupplier[]; buyer: LeakBuyer | null };
export type LeakKind = "supplier_name" | "supplier_email" | "cost" | "buyer_name" | "buyer_company" | "buyer_email" | "buyer_price";
/** found: the words or figure as the email has them. text: one line for Alex. */
export type Leak = { kind: LeakKind; found: string; text: string };

// Words too ordinary to mean a company on their own: trade words, car makes, chemistries and big places.
const COMMON = new Set(`a an and the of for to in on at by with from our your their my we you they it is are be this that
  battery batteries cell cells module modules pack packs energy power green eco electric electrical ev evs auto autos automotive car cars motor motors
  vehicle vehicles parts part spares recycling recycle recyclers recovery reuse second life storage solar solutions solution systems system services service
  group global international trading trade trader traders supply supplies supplier logistics transport freight shipping company holdings industries industrial
  technology technologies tech engineering materials metals metal circular renewable renewables network partners partner direct online uk eu europe european
  british england english scotland wales ireland germany german france french poland polish netherlands dutch italy italian spain spanish china chinese
  london manchester birmingham bristol leeds glasgow bath north south east west new best first one top prime premier smart future clean
  great good surplus used quality express united general standard digital advanced master expert trusted rapid quick central national
  regional local county city royal golden silver blue red black white star sun wind earth planet apex summit peak core pro plus max ultra mega super
  garage garages hybrid autorecycling autohandel recyclage recycling recyclers breakers salvage scrap dismantling dismantlers spare
  lithium ion li lfp nmc nca lto tesla nissan leaf renault zoe volkswagen vw skoda audi cupra seat bmw mini mercedes benz hyundai kia ioniq jaguar porsche mg byd
  stellantis peugeot citroen fiat toyota lexus volvo polestar ford catl lg samsung sdi panasonic sk on
  sheffield liverpool newcastle nottingham leicester coventry bolton cardiff edinburgh belfast oxford cambridge reading swindon somerset kent essex yorkshire
  paris berlin munich hamburg amsterdam rotterdam warsaw prague milan madrid barcelona lyon brussels antwerp vienna dublin`.split(/\s+/).filter(Boolean));
// First names: a company called "James Bolton Ltd" is not named by every James.
const FIRST_NAMES = new Set(`james john david michael robert william richard thomas charles christopher daniel matthew anthony mark paul steven andrew
  peter george edward henry jack harry oliver alexander alexandre alessandro sam samuel ben benjamin tom chris dan matt mike rob bob joe joseph luke
  adam simon stephen martin jonathan nicholas nick ian gary kevin brian scott jason ryan sean patrick tim timothy philip phil carl karl hans jan piotr
  marco roberto luca giovanni francesco antonio pierre jean michel francois juan carlos jose miguel ahmed mohammed ali sarah emma laura anna maria
  claire kate jane lucy sophie julia elena charlotte rachel rebecca helen victoria`.split(/\s+/).filter(Boolean));

// Legal and filler endings dropped before a company name is matched: "Parts Roberto S.r.l." is "Parts Roberto".
const SUFFIX = /(?:[\s,]+(?:ltd|limited|plc|llc|llp|inc|incorporated|corp|corporation|co|gmbh|ag|kg|ug|bv|nv|sa|sas|sarl|srl|spa|sro|oy|ab|as|aps|kft|zrt|doo|sp\.?\s*z\s*oo|sl|slu|pty|bvba|vof|ohg|eurl)\.?)+\s*$/i;
/** "B.V." and "S.r.l." as "BV." and "Srl.", so the endings above find them. */
const undot = (name: string) => name.replace(/(\p{L})\.(?=\p{L}(?:\.|$|\s))/gu, "$1");
const LEGAL = new Set(["ltd", "limited", "plc", "llc", "inc", "corp", "gmbh", "ag", "bv", "nv", "sa", "srl", "spa", "sro", "oy", "ab", "kft", "co", "company", "group"]);
// Our own side: Alex signs every email, so his name is never a leak.
const OWN = new Set(["alex", "polglase", "rebattery"]);

/** Lower case, no accents, punctuation as spaces: "Brökhuis B.V." reads "brokhuis b v". */
const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9@.]+/g, " ").replace(/\s+/g, " ").trim();
const words = (text: string) => plain(text).replace(/\./g, " ").split(" ").filter(Boolean);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A phrase on word boundaries, the words separated by any spaces or punctuation. */
function phrase(tokens: string[], flags: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${tokens.map(escape).join("[\\s\\p{P}]+")}(?![\\p{L}\\p{N}])`, flags);
}

/** Where a name shows in the text, or null. "Surplus Autos (Groupe Surplus Recyclage)" is either name on its own. */
function findName(text: string, name: string, kind: "company" | "person"): string | null {
  for (const part of name.split(/[()]/).map((p) => p.trim()).filter(Boolean)) {
    const hit = findOneName(text, part, kind);
    if (hit) return hit;
  }
  return null;
}

/** Where one name shows in the text, or null. Text is matched without accents, like the name. */
function findOneName(text: string, name: string, kind: "company" | "person"): string | null {
  const raw = name.trim();
  if (!raw) return null;
  const core = kind === "company" ? undot(raw).replace(SUFFIX, "").trim() || raw : raw;
  const tokens = words(core);
  // Nothing to go on: our own name, a legal ending on its own ("Ltd"), or too short to tell from a word ("QA").
  if (!tokens.length || tokens.every((t) => OWN.has(t)) || tokens.every((t) => LEGAL.has(t)) || tokens.join("").length < 4) return null;
  const folded = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const asWritten = core.normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[\s\p{P}]+/u).filter(Boolean);
  const ordinary = tokens.every((t) => COMMON.has(t) || t.length < 3);
  // proper: the hit must be a proper noun, capitalised and not just opening a sentence ("Great to hear from you").
  const tries: { re: RegExp; proper: boolean }[] = [];
  if (ordinary) {
    // Everyday words only: the name as written, capitals and all ("Green Energy"), never "green energy".
    if (asWritten.some((w) => /\p{Lu}/u.test(w))) tries.push({ re: phrase(asWritten, "gu"), proper: asWritten.length === 1 });
  } else {
    tries.push({ re: phrase(tokens, "giu"), proper: false });
    // One telling word can name them on its own: the company's lead word ("Broekhuis"), a person's surname ("Bament").
    const index = kind === "company" ? 0 : tokens.length > 1 ? tokens.length - 1 : -1;
    const lone = tokens[index];
    const written = asWritten.find((w) => w.toLowerCase() === lone);
    if (lone && written && lone.length >= (kind === "company" ? 5 : 4) && !COMMON.has(lone) && !FIRST_NAMES.has(lone) && !OWN.has(lone) && !/^\d+$/.test(lone)) {
      tries.push({ re: phrase([written[0].toUpperCase() + written.slice(1)], "gu"), proper: true });
    }
  }
  for (const { re, proper } of tries) {
    for (const hit of folded.matchAll(re)) {
      if (proper && /(?:^|[.!?:;]\s*|\n\s*)$/.test(folded.slice(0, hit.index))) continue;
      return hit[0];
    }
  }
  return null;
}

/** An address, or its company domain (never a free-mail one), anywhere in the text. */
function findEmail(text: string, email: string): string | null {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return null;
  const lower = text.toLowerCase();
  if (lower.includes(address)) return address;
  const domain = address.split("@")[1];
  if (isPersonalDomain(domain) || domain.endsWith("rebattery.io")) return null;
  const hit = lower.match(new RegExp(`(?<![a-z0-9-])${escape(domain)}(?![a-z0-9-])`));
  return hit ? hit[0] : null;
}

const CURRENCY = "(?:£|€|\\$|gbp|eur|usd|euros?|pounds?|quid)";
// Grouped thousands ("4,500", "4.500,00", "4 500") or plain digits; never two numbers run together ("£4,500 2 packs").
const NUMBER = "\\d{1,3}(?:[,.\\u00a0 ]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
const MONEY_RES = [
  new RegExp(`(${CURRENCY})\\s?(${NUMBER})\\s?(k|m)?(?![\\p{L}\\p{N}])`, "giu"),
  new RegExp(`(?<![\\p{L}\\p{N}.,])(${NUMBER})\\s?(k|m)?\\s?(${CURRENCY})(?![\\p{L}])`, "giu"),
];

/** "4,500", "4.500,00", "4 500" and "4500.5" as numbers. A lone separator before exactly three digits groups thousands. */
export function readNumber(raw: string): number | null {
  const text = raw.replace(/\s/g, "");
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let normal: string;
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    normal = text.split(decimal === "," ? "." : ",").join("").replace(decimal, ".");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const parts = text.split(sep);
    const grouped = parts.length > 2 || parts[parts.length - 1].length === 3;
    normal = grouped ? parts.join("") : parts.join(".");
  } else normal = text;
  const value = Number(normal);
  return Number.isFinite(value) ? value : null;
}

/** Every amount written as money in the text, with how it was written. "€30k" is 30000. */
export function moneyMentions(text: string): { value: number; found: string }[] {
  const out: { value: number; found: string }[] = [];
  for (const [index, re] of MONEY_RES.entries()) {
    for (const m of text.matchAll(re)) {
      const [num, scale] = index === 0 ? [m[2], m[3]] : [m[1], m[2]];
      const value = readNumber(num);
      if (value === null) continue;
      const times = scale?.toLowerCase() === "k" ? 1000 : scale?.toLowerCase() === "m" ? 1_000_000 : 1;
      out.push({ value: Math.round(value * times * 100) / 100, found: m[0].trim() });
    }
  }
  return out;
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.01;

/** The problems in one email: supplier details in a buyer's email, buyer details in a supplier's. Empty when it's clean. */
export function leaks(draft: LeakDraft, facts: LeakFacts): Leak[] {
  const found: Leak[] = [];
  const add = (leak: Leak) => { if (!found.some((f) => f.kind === leak.kind && f.found.toLowerCase() === leak.found.toLowerCase())) found.push(leak); };
  const body = draft.body ?? "";
  const money = moneyMentions(body);
  if (draft.toKind === "buyer") {
    const buyerEmail = facts.buyer?.email?.trim().toLowerCase() ?? "";
    for (const s of facts.suppliers) {
      if (s.email && s.email.trim().toLowerCase() === buyerEmail) continue;  // the same person on both sides: nothing to hide
      const name = s.name ? findName(body, s.name, "company") : null;
      if (name) add({ kind: "supplier_name", found: name, text: `Names the supplier (${name}).` });
      const email = s.email ? findEmail(body, s.email) : null;
      if (email) add({ kind: "supplier_email", found: email, text: `Shows the supplier's address (${email}).` });
      for (const cost of s.costs.filter((c) => Number.isFinite(c) && c > 0)) {
        const hit = money.find((m) => sameAmount(m.value, cost));
        if (hit) add({ kind: "cost", found: hit.found, text: `Shows what the supplier charges (${hit.found}).` });
      }
    }
  } else if (draft.toKind === "supplier" && facts.buyer) {
    const b = facts.buyer;
    const name = b.name ? findName(body, b.name, "person") : null;
    if (name) add({ kind: "buyer_name", found: name, text: `Names the buyer (${name}).` });
    const company = b.company && b.company.trim().toLowerCase() !== (b.name ?? "").trim().toLowerCase() ? findName(body, b.company, "company") : null;
    if (company) add({ kind: "buyer_company", found: company, text: `Names the buyer's company (${company}).` });
    const email = b.email ? findEmail(body, b.email) : null;
    if (email) add({ kind: "buyer_email", found: email, text: `Shows the buyer's address (${email}).` });
    for (const price of b.prices.filter((p) => Number.isFinite(p) && p > 0)) {
      const hit = money.find((m) => sameAmount(m.value, price));
      if (hit) add({ kind: "buyer_price", found: hit.found, text: `Shows what the buyer pays (${hit.found}).` });
    }
  }
  return found;
}

/** One sentence for a refusal or the chat: "The email to Parts Roberto names the buyer (Ben Bament)." */
export function leakSentence(to: string, problems: Leak[]): string {
  const parts = problems.slice(0, 3).map((p) => p.text.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase()));
  return `The email to ${to} ${parts.join(", and ")}.${problems.length > 3 ? ` And ${problems.length - 3} more.` : ""}`;
}

// ---------- the facts ----------

export type Side = "buyer" | "supplier" | "other";
export type Party = { name: string | null; company: string | null; email: string | null };
export type FactsInput = {
  /** Whose thread this is: a buyer's (buy@ or a buyer contact), a supplier's, or neither. */
  side: Side;
  counterpart: Party;
  /** The buyer on the linked deal when the thread is a supplier's answer to a buyer's request. */
  dealBuyer: Party | null;
  /** The stock that fits, as its suppliers and what each wants. */
  stock: { name: string | null; email: string | null; cost: number | null }[];
  /** Every Relay email on the thread, with who it's to. */
  drafts: { toKind: Side; to: string[]; body: string }[];
  /** Amounts in the counterpart's own emails: a supplier's asking price is a cost. */
  theirAmounts: number[];
};

const lower = (email: string | null | undefined) => (email ?? "").trim().toLowerCase() || null;

/** Who an email goes to: what it was saved as, else the reply follows the thread's side, else its address decides. */
export function draftSide(d: { toKind: Side | null; role: "primary" | "follow"; to: string[] }, side: Side, known: { suppliers: string[]; buyer: string | null }): Side {
  if (d.toKind) return d.toKind;
  if (d.role === "primary") return side;
  const to = d.to.map((a) => a.trim().toLowerCase());
  if (to.some((a) => known.suppliers.includes(a))) return "supplier";
  if (known.buyer && to.includes(known.buyer)) return "buyer";
  return "other";
}

/** What the guard checks against: each supplier with their costs, and the buyer with what we quote them. */
export function leakFacts(input: FactsInput): LeakFacts {
  const suppliers: LeakSupplier[] = [];
  const supplier = (name: string | null, email: string | null, costs: number[]) => {
    const key = lower(email) ?? (name ?? "").trim().toLowerCase();
    if (!key) return;
    const same = suppliers.find((s) => (lower(s.email) ?? (s.name ?? "").trim().toLowerCase()) === key);
    if (same) same.costs.push(...costs.filter((c) => !same.costs.includes(c)));
    else suppliers.push({ name, email: lower(email), costs: [...new Set(costs)] });
  };
  for (const s of input.stock) supplier(s.name, s.email, s.cost != null ? [s.cost] : []);
  if (input.side === "supplier") {
    const c = input.counterpart;
    supplier(c.company ?? c.name, c.email, input.theirAmounts);
    if (c.company && c.name) supplier(c.name, null, []);
  }
  for (const d of input.drafts) if (d.toKind === "supplier") for (const to of d.to) supplier(null, to, []);

  const party = input.side === "buyer" ? input.counterpart : input.dealBuyer
    ?? (() => { const d = input.drafts.find((x) => x.toKind === "buyer" && x.to.length); return d ? { name: null, company: null, email: d.to[0] } : null; })();
  if (!party) return { suppliers, buyer: null };
  const costs = new Set(suppliers.flatMap((s) => s.costs));
  const prices = [...new Set(input.drafts.filter((d) => d.toKind === "buyer").flatMap((d) => moneyMentions(d.body).map((m) => m.value)))]
    .filter((p) => ![...costs].some((c) => sameAmount(c, p)));
  return { suppliers, buyer: { name: party.name, company: party.company, email: lower(party.email), prices } };
}
