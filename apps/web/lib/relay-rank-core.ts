import { londonToday } from "./relay-when";

/**
 * "Waiting on you", the pure part: one row per person, scored at read time from what is at stake, who they are to
 * ReBattery, how long they have waited and whether they chased, so the list moves as the day goes on instead of keeping
 * the priority the scan gave an email when it arrived.
 *
 * The weights sit in one table (WEIGHTS) and the bands are plain thresholds on the score (BANDS).
 */

export type RankBand = "now" | "today" | "week" | "later";

/** One open Relay email with what the server looked up about it and its sender. */
export type RankItem = {
  id: string;
  email: string | null;
  name: string | null;
  company: string | null;
  contactType: string | null;
  situation: string | null;
  tab: "action" | "follow" | "other";
  /** The scan's priority. Only "overdue" (a promise Alex made is past its day) and "urgent" are read. */
  priority: string;
  headline: string;
  waitingSince: string | null;
  /** When the newest message on the thread was sent; the newest item is the one a row opens. */
  lastAt: string | null;
  /** Their latest text, read for a large lot. */
  text: string;
  /** The CRM people behind the address: its own record and any record it was merged into. */
  personIds: string[];
  companyId: string | null;
  /** The address is on a personal or ISP domain, so it says nothing about a company. */
  personal: boolean;
  deal: { live: boolean; value: string | null; quantity: string | null } | null;
  /** When their messages arrived since Alex last wrote on the thread. */
  waitingInbound: string[];
  /** Nobody at ReBattery has ever written to this address or its company domain by hand. */
  firstContact: boolean;
  /** Closed deals with them that traded (bought from us, sold to us). */
  pastDeals: number;
  /** The CRM marks their company a customer. */
  customer: boolean;
  /** Every email they have sent us, and when the first came. */
  inboundEmails: number;
  firstInboundAt: string | null;
  /** An unsent Relay draft is waiting on this email. */
  hasDraft: boolean;
};

export type RankScore = { score: number; band: RankBand; tag: string | null; why: string[] };

/** Every weight in one place. Positive is more pressing. */
export const WEIGHTS = {
  // Promises
  promiseOverdue: 45,
  // Stake
  liveDeal: 18,
  /** Added to a live deal by its value in GBP, the largest step that fits. */
  dealValue: [[250_000, 18], [50_000, 12], [10_000, 6]] as [number, number][],
  largeLot: 14,
  newLead: 12,
  buyerAsk: 16,
  sellerOffer: 10,
  /** The scan saw a deadline within a day of the email ("urgent" with no lot and no new lead behind it). Counted only
   * while the email is that fresh: after that the day has passed and waiting time speaks for it. */
  deadline: 12,
  deadlineDays: 1,
  // Relationship: the larger of the two counts
  pastDeals: 28,
  longStanding: 12,
  // Waiting, by working day: steep for the first days, then gentle, then flat
  perDayFirst: 4,
  firstDays: 5,
  perDayAfter: 1,
  maxDaysAfter: 10,
  // Their chase: per later day they wrote again while waiting
  chase: 12,
  maxChases: 2,
  // A draft is ready: one click from done
  draftReady: 4,
  // Noise
  automated: -80,
  admin: -60,
  otherTab: -60,
  /** A partner, logistics or unknown contact with nothing at stake: needs an answer, rarely today. */
  noStake: -8,
  /** A thanks, a holding reply or a no: little to decide. */
  lowStake: -14,
} as const;

/** The lowest score in each band; anything below the last is "later". */
export const BANDS: [RankBand, number][] = [["now", 65], ["today", 45], ["week", 25]];

/** Who counts as the trading side, and the email kinds that mean money on the table. */
const LEAD_TYPES = new Set(["buyer", "supplier"]);
const BUYER_ASK = new Set(["buyer_price", "buyer_needs"]);
const SELLER_OFFER = new Set(["supplier_offer", "supplier_price"]);
const LOW_STAKE = new Set(["ack", "decline"]);
const NOISE_TYPES = new Set(["admin"]);
/** Long-standing: this many emails from them, the first at least this many days ago. */
const LONG_EMAILS = 5;
const LONG_DAYS = 60;

// Machine senders: no-reply and notification addresses, or a notifications subdomain (novabook@notifications.novabook.com).
const AUTOMATED_LOCAL = /^(?:no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer(?:-daemon)?|bounces?|newsletters?|postmaster|automated)(?:[+.-].*)?$/i;
const AUTOMATED_HOST = /^(?:notifications?|notify|mailer|bounces?|newsletters?)\./i;

/** True for mail a machine sent. */
export function isAutomated(email: string | null | undefined): boolean {
  const [local = "", host = ""] = (email ?? "").toLowerCase().trim().split("@");
  return AUTOMATED_LOCAL.test(local) || AUTOMATED_HOST.test(host);
}

// ---------- large lots (mirrors large_lot in scripts/rebattery/relay_scan.py) ----------

const LOT = /(?<![\w.,])(\d[\d.,]*)((?:\s+(?:[\w-]*[a-z][\w-]*|\d{4,5})){0,2}?)\s*-?\s*(mwh|kwh|tonnes?|tons?|pallets?|packs?|modules?|units?|batter(?:y|ies)|cells?)\b/gi;
const NOT_A_QUANTITY = new Set([14500, 18350, 18650, 21700, 26650, 26700, 32650, 32700, 4680, 46800, 46950, ...Array.from({ length: 40 }, (_, i) => 2000 + i)]);
const NOT_A_COUNT = /\b(?:kg|kgs|g|lbs?|per|each|eur|euros?|gbp|usd|pounds?|dollars?|v|volts?|ah|kw|km|miles|x)\b/i;
const LOT_MIN: Record<string, number> = { mwh: 1, kwh: 1000, tonne: 10, ton: 10, pallet: 10, pack: 50, module: 50, unit: 50, battery: 50, batterie: 50, cell: 10000 };

/** "1,000" and "1.000" are thousands, "8.44" and "8,44" decimals. */
function lotNumber(raw: string): number | null {
  const s = raw.replace(/^[.,]+|[.,]+$/g, "");
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ""));
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** The first quantity in the text big enough to be a bulk lot, as written ("1,000 modules"), else null. */
export function largeLot(text: string | null | undefined): string | null {
  const t = text ?? "";
  for (const m of t.matchAll(LOT)) {
    const [, num, between, unitRaw] = m;
    const unit = unitRaw.toLowerCase().replace(/s+$/, "");
    const n = lotNumber(num);
    const before = t.slice(Math.max(0, m.index - 12), m.index);
    if (n === null || (/^\d+$/.test(num) && NOT_A_QUANTITY.has(Number(num))) || num.startsWith("0")
      || NOT_A_COUNT.test(between) || /[€£$]|\b(?:eur|gbp|usd)\b/i.test(before)) continue;
    if (n >= (LOT_MIN[unit] ?? Infinity)) return `${num} ${unitRaw}`;
  }
  return null;
}

// ---------- deal value ----------

const TO_GBP: Record<string, number> = { "£": 1, "€": 0.87, $: 0.79 };
const MONEY = /([£€$])?\s?(\d[\d,]*(?:\.\d+)?)\s*([km])?\b(?:\s*(?:[–-]|to)\s*[£€$]?\s?(\d[\d,]*(?:\.\d+)?)\s*([km])?\b)?/i;

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}m` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

/** A deal's free-text value ("€40–60k", "$516,800", "80k (full batch)") as its lower bound in GBP and a short label. Null when it holds no amount. */
export function dealValue(text: string | null | undefined): { gbp: number; label: string } | null {
  const m = MONEY.exec(text ?? "");
  if (!m) return null;
  const [, sym = "£", a, unitA, b, unitB] = m;
  const scale = (u: string | undefined) => (u?.toLowerCase() === "m" ? 1e6 : u?.toLowerCase() === "k" ? 1e3 : 1);
  const low = Number(a.replace(/,/g, "")) * scale(unitA ?? unitB);
  const high = b ? Number(b.replace(/,/g, "")) * scale(unitB) : null;
  if (!Number.isFinite(low) || low < 100) return null;
  let label = `${sym}${compact(low)}`;
  if (high && high > low) {
    const [l, h] = [compact(low), compact(high)];
    // "€40–60k", not "€40k–60k"; mixed sizes keep both ("€800k–1.2m").
    label = `${sym}${l.slice(-1) === h.slice(-1) && /[km]$/.test(h) ? l.slice(0, -1) : l}–${h}`;
  }
  return { gbp: low * (TO_GBP[sym] ?? 1), label };
}

// ---------- days ----------

const DAY_MS = 86_400_000;

/** Calendar days in London from `since` to now, and the working days among them (weekends left out). */
export function waited(since: string | null, now = new Date()): { days: number; workingDays: number } {
  if (!since || Number.isNaN(Date.parse(since))) return { days: 0, workingDays: 0 };
  const start = londonToday(new Date(since)).getTime();
  const today = londonToday(now).getTime();
  const days = Math.max(0, Math.round((today - start) / DAY_MS));
  let workingDays = 0;
  for (let t = start + DAY_MS; t <= today; t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) workingDays += 1;
  }
  return { days, workingDays };
}

/** "today", "1 d", "7 d". */
export const waitedLabel = (days: number) => (days <= 0 ? "today" : `${days} d`);

// ---------- one row per person ----------

const ROLE_WORDS = new Set(["info", "sales", "admin", "office", "operations", "support", "team", "client", "clients", "services", "service", "accounts", "hello", "contact", "enquiries", "purchasing", "logistics"]);

/** A person's name fit for matching two addresses: two or more real words, no role mailbox, no name made from an address. */
export function matchName(name: string | null | undefined, email?: string | null): string | null {
  const words = (name ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 1);
  if (words.length < 2 || words.some((w) => ROLE_WORDS.has(w))) return null;
  const local = (email ?? "").toLowerCase().split("@")[0].replace(/[^a-z]/g, "");
  if (local && words.join("") === local) return null;
  return words.join(" ");
}

/**
 * Groups items that come from the same person. Sure links: the same address, or the same CRM person (including a record
 * merged into another). A weaker link, the same full name, joins two groups only when they hold at most one company
 * between them: so a gmail address and a work address with the same name join, while two people of the same name at
 * two companies stay apart. Different names never join on a shared company, so two colleagues stay two rows.
 * Groups keep the input order of their first item.
 */
export function mergeByPerson(items: RankItem[]): RankItem[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const companies = items.map((it) => new Set(it.companyId ? [it.companyId] : []));
  const union = (a: number, b: number, sure: boolean) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    const both = new Set([...companies[ra], ...companies[rb]]);
    if (!sure && both.size > 1) return;
    parent[rb] = ra;
    companies[ra] = both;
  };
  const byKey = new Map<string, number>();
  const link = (key: string, i: number, sure: boolean) => {
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, i); else union(seen, i, sure);
  };
  items.forEach((it, i) => {
    const email = (it.email ?? "").toLowerCase().trim();
    if (email) link(`email:${email}`, i, true);
    for (const p of it.personIds) link(`person:${p}`, i, true);
  });
  // Name links run after the sure ones, so each group's companies are known before a name may join it.
  items.forEach((it, i) => {
    const name = matchName(it.name, it.email);
    // A company address with nothing in the CRM still names its company by its domain.
    if (!it.companyId && !it.personal && it.email) companies[find(i)].add(`domain:${it.email.split("@")[1]}`);
    if (name) link(`name:${name}`, i, false);
  });
  const groups = new Map<number, RankItem[]>();
  items.forEach((it, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), it]);
  });
  return [...groups.values()];
}

// ---------- signals and score ----------

/** What a row's score is made from, combined over the person's emails. */
export type RankSignals = {
  promiseOverdue: boolean;
  deal: { gbp: number | null; label: string | null } | null;
  lot: string | null;
  newLead: boolean;
  contactType: string | null;
  buyerAsk: boolean;
  sellerOffer: boolean;
  deadline: boolean;
  pastDeals: number;
  customer: boolean;
  longStanding: boolean;
  waitingSince: string | null;
  chases: number;
  hasDraft: boolean;
  automated: boolean;
  admin: boolean;
  otherTab: boolean;
  lowStake: boolean;
};

const at = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0);
const londonDay = (s: string) => londonToday(new Date(s)).getTime();
/** The earliest of some timestamps, compared as times (not as text). */
const earliest = (list: (string | null)[]) => list.filter((s): s is string => !!at(s)).sort((a, b) => at(a) - at(b))[0] ?? null;

/** The newest email decides the kind of contact; the others add what they have at stake. */
export function signalsOf(group: RankItem[], now = new Date()): RankSignals {
  const newest = [...group].sort((a, b) => at(b.lastAt ?? b.waitingSince) - at(a.lastAt ?? a.waitingSince))[0];
  const type = newest.contactType;
  const trading = group.some((i) => LEAD_TYPES.has(i.contactType ?? ""));
  const live = group.filter((i) => i.deal?.live).map((i) => ({ value: dealValue(i.deal!.value), quantity: i.deal!.quantity }));
  const best = live.sort((a, b) => (b.value?.gbp ?? 0) - (a.value?.gbp ?? 0))[0];
  const lot = group.map((i) => largeLot(`${i.headline}\n${i.text}`) ?? (i.deal?.live ? largeLot(i.deal.quantity) : null)).find(Boolean) ?? null;
  const newLead = trading && group.every((i) => i.firstContact);
  const firstInbound = earliest(group.map((i) => i.firstInboundAt));
  const inbound = Math.max(...group.map((i) => i.inboundEmails));
  const sinceFirst = firstInbound ? (now.getTime() - Date.parse(firstInbound)) / DAY_MS : 0;
  const waitingSince = earliest(group.map((i) => i.waitingSince));
  // They chased: they wrote again on a later day than their first unanswered email, or the email itself is a chase.
  const days = new Set(group.flatMap((i) => i.waitingInbound).filter((s) => at(s)).map(londonDay));
  const chases = Math.max(days.size - 1, group.some((i) => i.situation === "chase") ? 1 : 0);
  const automated = group.every((i) => isAutomated(i.email));
  return {
    promiseOverdue: group.some((i) => i.priority === "overdue"),
    deal: best ? { gbp: best.value?.gbp ?? null, label: best.value?.label ?? null } : null,
    lot: trading ? lot : null,
    newLead,
    contactType: type,
    buyerAsk: group.some((i) => BUYER_ASK.has(i.situation ?? "")),
    sellerOffer: group.some((i) => i.contactType === "supplier" && SELLER_OFFER.has(i.situation ?? "")),
    deadline: group.some((i) => i.priority === "urgent") && !lot && !newLead,
    pastDeals: Math.max(...group.map((i) => i.pastDeals)),
    customer: group.some((i) => i.customer),
    longStanding: inbound >= LONG_EMAILS && sinceFirst >= LONG_DAYS,
    waitingSince,
    chases,
    hasDraft: group.some((i) => i.hasDraft),
    automated,
    admin: group.every((i) => NOISE_TYPES.has(i.contactType ?? "") || i.situation === "admin"),
    otherTab: group.every((i) => i.tab === "other"),
    lowStake: group.every((i) => LOW_STAKE.has(i.situation ?? "")),
  };
}

const side = (type: string | null) => (type === "buyer" ? "buyer" : type === "supplier" ? "seller" : "lead");

/** The score, its band, the one cue the row shows and the reasons behind it. */
export function scoreSignals(s: RankSignals, now = new Date()): RankScore {
  const W = WEIGHTS;
  const why: string[] = [];
  const tags: string[] = [];
  let score = 0;
  const add = (points: number, reason: string, tag?: string) => {
    if (!points) return;
    score += points;
    why.push(`${reason} ${points > 0 ? "+" : ""}${points}`);
    if (tag) tags.push(tag);
  };
  const noise = s.automated || s.admin || s.otherTab;

  if (s.promiseOverdue) add(W.promiseOverdue, "your promise is overdue", "Promise overdue");
  if (s.hasDraft) add(W.draftReady, "draft ready", "Draft ready");
  if (s.deal) {
    const step = s.deal.gbp ? W.dealValue.find(([min]) => s.deal!.gbp! >= min)?.[1] ?? 0 : 0;
    add(W.liveDeal + step, `live deal${s.deal.label ? ` ${s.deal.label}` : ""}`, `Live deal${s.deal.label ? ` ${s.deal.label}` : ""}`);
  }
  const relationship = s.pastDeals || s.customer ? W.pastDeals : s.longStanding ? W.longStanding : 0;
  if (relationship && !noise) add(relationship, s.pastDeals ? `returning: ${s.pastDeals} past ${s.pastDeals === 1 ? "deal" : "deals"}` : s.customer ? "returning: a customer" : "returning: emails over months", "Returning");
  if (s.newLead) add(W.newLead, `new ${side(s.contactType)}`, `New ${side(s.contactType)}`);
  if (s.lot) add(W.largeLot, `large lot: ${s.lot}`, `Lot ${s.lot}`);
  if (s.buyerAsk) add(W.buyerAsk, "buyer asks for stock or a price", "Price ask");
  if (s.sellerOffer) add(W.sellerOffer, "seller offer", "Seller offer");
  const { days, workingDays } = waited(s.waitingSince, now);
  if (s.deadline && workingDays <= W.deadlineDays) add(W.deadline, "deadline in the next day", "Deadline");

  const dayPoints = Math.min(workingDays, W.firstDays) * W.perDayFirst + Math.min(Math.max(workingDays - W.firstDays, 0), W.maxDaysAfter) * W.perDayAfter;
  if (dayPoints) add(dayPoints, `waiting ${workingDays} working ${workingDays === 1 ? "day" : "days"} (${days} d)`);
  const chases = Math.min(s.chases, W.maxChases);
  if (chases) add(chases * W.chase, chases === 1 ? "they chased" : `they chased ${chases} times`, "Chased");

  const stake = !!(s.deal || s.lot || s.buyerAsk || s.sellerOffer || s.newLead || s.promiseOverdue || s.deadline);
  if (s.automated) add(W.automated, "automated mail");
  else if (s.admin) add(W.admin, "admin");
  if (s.otherTab) add(W.otherTab, "no reply needed");
  if (!noise && s.lowStake) add(W.lowStake, "a thanks, holding reply or no");
  else if (!noise && !stake && !LEAD_TYPES.has(s.contactType ?? "")) add(W.noStake, `${s.contactType ?? "unknown"} contact, nothing at stake`);

  const band = BANDS.find(([, min]) => score >= min)?.[0] ?? "later";
  // Noise never shows a cue; a draft is the most useful one only once the money and the promise are shown.
  const order = ["Promise overdue", "Draft ready", "Live deal", "Returning", "New ", "Chased", "Lot ", "Seller offer", "Price ask", "Deadline"];
  const tag = noise ? null : order.map((p) => tags.find((t) => t.startsWith(p))).find(Boolean) ?? null;
  return { score, band, tag, why };
}

/** A row of "Waiting on you". */
export type WaitingRow = RankScore & {
  /** For lists: the person's oldest waiting email, which stays put while newer ones arrive. */
  key: string;
  name: string;
  company: string | null;
  /** The newest email's headline. */
  ask: string;
  waited: string;
  waitingSince: string | null;
  itemIds: string[];
  openId: string;
  /** Their emails waiting for an answer, over every thread. */
  emails: number;
  hasDraft: boolean;
  contactType: string | null;
};

/** The best display name of a group: a real name over one made from an address. */
function displayName(group: RankItem[]): string {
  const named = group.find((i) => matchName(i.name, i.email));
  return (named ?? group.find((i) => i.name) ?? group[0]).name ?? group[0].email ?? "Unknown";
}

/** Merges the items into one row per person, scores each and returns them best first. */
export function rankItems(items: RankItem[], now = new Date()): WaitingRow[] {
  return mergeByPerson(items).map((group) => {
    const newest = [...group].sort((a, b) => at(b.lastAt ?? b.waitingSince) - at(a.lastAt ?? a.waitingSince))[0];
    const signals = signalsOf(group, now);
    const score = scoreSignals(signals, now);
    const company = group.find((i) => i.company && !i.personal)?.company ?? null;
    return {
      ...score,
      key: [...group].sort((a, b) => at(a.waitingSince ?? a.lastAt) - at(b.waitingSince ?? b.lastAt))[0].id,
      name: displayName(group),
      company,
      ask: newest.headline,
      waited: waitedLabel(waited(signals.waitingSince, now).days),
      waitingSince: signals.waitingSince,
      itemIds: group.map((i) => i.id),
      openId: newest.id,
      emails: Math.max(group.length, group.reduce((n, i) => n + i.waitingInbound.length, 0)),
      hasDraft: signals.hasDraft,
      contactType: signals.contactType,
    };
  }).sort((a, b) => b.score - a.score || at(a.waitingSince) - at(b.waitingSince));
}
