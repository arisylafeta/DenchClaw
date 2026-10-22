// Home: marketplace numbers counted live from ReBattery platform rows (Supabase). Pure functions over
// rows read by lib/home-platform-read.ts, so every rule here is unit tested.
//
// Test and staff accounts are left out with Marketplace Pulse's rules (marketplace-pulse-exclusions.json):
// a buyer is out when it is a listed test account or has a member with a staff or test email; a deal is
// out when its buyer is out or its seller is a listed test account.
import exclusions from "./marketplace-pulse-exclusions.json";
import { staffEmail } from "./marketplace-pulse-follow-ups";
import { DAY_MS, MIN_PAID_AMOUNT, OVERVIEW_WEEKS, REPLY_WINDOW_HOURS, monthOf, toGbp, weekOf, weekRange } from "./home-metrics";

const TEST_IDS = new Set(Object.keys(exclusions.test_account_ids));

export type PlatformRows = {
  deals: { id: string; created_at: string; supplier_account_id: string | null; counterparty_account_id: string | null }[];
  /** Captured payment intents of every purpose. */
  payments: {
    deal_id: string;
    status: string;
    payment_purpose: string | null;
    amount: number | string | null;
    currency: string | null;
    platform_fee_amount: number | string | null;
    captured_at: string | null;
    created_at: string;
  }[];
  offers: { buyer_account_id: string | null; created_at: string }[];
  /** Purchase and buy-now conversations. */
  conversations: { id: string; created_at: string; counterparty_account_id: string | null }[];
  /** Messages in the conversations above opened since REPLY_SINCE, with the sender's account. */
  messages: { conversation_id: string; created_at: string; is_system_seeded: boolean | null; sender_account_id: string | null }[];
  /** Lower-cased member emails per buyer account. */
  accountEmails: Map<string, string[]>;
  /** Account names, for the deal most fees came from. */
  accountNames: Map<string, string>;
};

const num = (value: number | string | null | undefined) => (value === null || value === undefined || value === "" ? null : Number(value));

/** A buyer account that is a listed test account, or has a staff or test member. */
export function internalBuyer(accountId: string | null, accountEmails: Map<string, string[]>): boolean {
  if (!accountId) {return true;}
  return TEST_IDS.has(accountId) || (accountEmails.get(accountId) ?? []).some(staffEmail);
}

/** Deals between real buyers and real sellers. */
export function realDeals(rows: Pick<PlatformRows, "deals" | "accountEmails">): PlatformRows["deals"] {
  return rows.deals.filter((d) => !TEST_IDS.has(d.supplier_account_id ?? "") && !internalBuyer(d.counterparty_account_id, rows.accountEmails));
}

// ---------------------------------------------------------------------------
// Enquiries
// ---------------------------------------------------------------------------

export type Enquiry = { account_id: string; at: string };

/** Every buyer signal: an offer, or a purchase or buy-now conversation, from a real buyer. */
export function enquiries(rows: Pick<PlatformRows, "offers" | "conversations" | "accountEmails">): Enquiry[] {
  const all = [
    ...rows.offers.map((o) => ({ account_id: o.buyer_account_id, at: o.created_at })),
    ...rows.conversations.map((c) => ({ account_id: c.counterparty_account_id, at: c.created_at })),
  ];
  return all.filter((e): e is Enquiry => !internalBuyer(e.account_id, rows.accountEmails));
}

/** Distinct buyers per Monday-start UTC week: a buyer who sends an offer and a message counts once. */
export function enquiriesByWeek(list: Enquiry[], weekStarts: string[]): number[] {
  const buyers = new Map(weekStarts.map((w) => [w, new Set<string>()]));
  for (const e of list) {buyers.get(weekOf(e.at))?.add(e.account_id);}
  return weekStarts.map((w) => buyers.get(w)!.size);
}

/** Distinct buyers with a signal in [from, to). */
export function distinctBuyers(list: Enquiry[], from: number, to: number): number {
  return new Set(list.filter((e) => { const t = Date.parse(e.at); return t >= from && t < to; }).map((e) => e.account_id)).size;
}

/** Counts per 30-day block ending now, oldest first: [60-90 days ago, 30-60, last 30]. */
export function thirtyDayBlocks(count: (from: number, to: number) => number, now: Date, blocks = 3): number[] {
  const end = now.getTime() + 1;
  return Array.from({ length: blocks }, (_, i) => {
    const to = end - (blocks - 1 - i) * 30 * DAY_MS;
    return count(to - 30 * DAY_MS, to);
  });
}

// ---------------------------------------------------------------------------
// Deals opened
// ---------------------------------------------------------------------------

export function dealsByWeek(deals: PlatformRows["deals"], weekStarts: string[]): number[] {
  const counts = new Map(weekStarts.map((w) => [w, 0]));
  for (const d of deals) {
    const week = weekOf(d.created_at);
    if (counts.has(week)) {counts.set(week, counts.get(week)! + 1);}
  }
  return weekStarts.map((w) => counts.get(w)!);
}

export const dealsBetween = (deals: PlatformRows["deals"], from: number, to: number) =>
  deals.filter((d) => { const t = Date.parse(d.created_at); return t >= from && t < to; }).length;

export type SinceDeal = { last_at: string; days: number; enquiries_since: number };

/** Days since the newest deal was opened, and distinct buyers who enquired after it. */
export function sinceLastDeal(deals: PlatformRows["deals"], list: Enquiry[], now: Date): SinceDeal | null {
  const last = deals.map((d) => d.created_at).toSorted().at(-1);
  if (!last) {return null;}
  const after = Date.parse(last);
  return {
    last_at: last,
    days: Math.floor((now.getTime() - after) / DAY_MS),
    enquiries_since: new Set(list.filter((e) => Date.parse(e.at) > after).map((e) => e.account_id)).size,
  };
}

// ---------------------------------------------------------------------------
// Paid deals and fees
// ---------------------------------------------------------------------------

export type PaidDeal = { deal_id: string; paid_at: string };

/**
 * A deal is paid when its first initial payment of at least MIN_PAID_AMOUNT is captured. It counts on
 * the day it was paid (captured_at, else created_at), so a deal opened in September and paid on
 * 2 October is an October deal. Marketplace Pulse counts by snapshot week instead.
 */
export function paidDeals(payments: PlatformRows["payments"], dealIds: Set<string>): PaidDeal[] {
  const first = new Map<string, string>();
  for (const p of payments) {
    if (p.status !== "captured" || p.payment_purpose !== "initial" || !dealIds.has(p.deal_id)) {continue;}
    if ((num(p.amount) ?? 0) < MIN_PAID_AMOUNT) {continue;}
    const at = p.captured_at ?? p.created_at;
    const seen = first.get(p.deal_id);
    if (!seen || at < seen) {first.set(p.deal_id, at);}
  }
  return [...first].map(([deal_id, paid_at]) => ({ deal_id, paid_at })).toSorted((a, b) => a.paid_at.localeCompare(b.paid_at));
}

export const paidInMonth = (paid: PaidDeal[], month: string) => paid.filter((p) => monthOf(p.paid_at) === month).length;

export function paidByWeek(paid: PaidDeal[], weekStarts: string[]): number[] {
  const counts = new Map(weekStarts.map((w) => [w, 0]));
  for (const p of paid) {
    const week = weekOf(p.paid_at);
    if (counts.has(week)) {counts.set(week, counts.get(week)! + 1);}
  }
  return weekStarts.map((w) => counts.get(w)!);
}

export type Fees = {
  ytd_gbp: number;
  month_gbp: number;
  /** Share of this year's fees from the single deal that brought the most, 0 to 1; null without fees. */
  top_share: number | null;
  top_deal_id: string | null;
  /** Captured fees left out because their currency has no configured rate. */
  skipped: number;
};

/**
 * Platform fees on captured payments of every purpose (initial and reconciliation), by the day they were
 * captured, in pounds. Euro fees use EUR_GBP.
 */
export function fees(payments: PlatformRows["payments"], dealIds: Set<string>, now: Date): Fees {
  const year = String(now.getUTCFullYear());
  const month = monthOf(now);
  const byDeal = new Map<string, number>();
  let ytd = 0;
  let monthTotal = 0;
  let skipped = 0;
  for (const p of payments) {
    if (p.status !== "captured" || !dealIds.has(p.deal_id)) {continue;}
    const at = p.captured_at ?? p.created_at;
    if (!at.startsWith(year)) {continue;}
    const fee = num(p.platform_fee_amount);
    if (fee === null) {continue;}
    const gbp = toGbp(fee, p.currency);
    if (gbp === null) { skipped += 1; continue; }
    ytd += gbp;
    if (monthOf(at) === month) {monthTotal += gbp;}
    byDeal.set(p.deal_id, (byDeal.get(p.deal_id) ?? 0) + gbp);
  }
  const top = [...byDeal].toSorted((a, b) => b[1] - a[1])[0];
  return {
    ytd_gbp: ytd,
    month_gbp: monthTotal,
    top_share: ytd > 0 && top ? top[1] / ytd : null,
    top_deal_id: top?.[0] ?? null,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Seller replies
// ---------------------------------------------------------------------------

export type ReplyBuckets = { within: number; later: number; never: number; open: number };

/**
 * For each buyer conversation opened since REPLY_SINCE: the buyer asks with their first message that is
 * not system-seeded; the reply is the first later message, not system-seeded, from anyone outside the
 * buyer's account (the seller or ReBattery). Unanswered questions under 24 hours old are open, not never.
 */
export function replyBuckets(
  rows: Pick<PlatformRows, "conversations" | "messages" | "accountEmails">,
  since: string,
  now: Date,
): ReplyBuckets {
  const windowMs = REPLY_WINDOW_HOURS * 3_600_000;
  const byConversation = new Map<string, PlatformRows["messages"]>();
  for (const m of rows.messages) {byConversation.set(m.conversation_id, [...(byConversation.get(m.conversation_id) ?? []), m]);}
  const out: ReplyBuckets = { within: 0, later: 0, never: 0, open: 0 };
  for (const c of rows.conversations) {
    if (c.created_at < since || internalBuyer(c.counterparty_account_id, rows.accountEmails)) {continue;}
    const messages = (byConversation.get(c.id) ?? []).filter((m) => !m.is_system_seeded).toSorted((a, b) => a.created_at.localeCompare(b.created_at));
    const asked = messages.find((m) => m.sender_account_id === c.counterparty_account_id);
    if (!asked) {continue;}
    const askedAt = Date.parse(asked.created_at);
    const reply = messages.find((m) => Date.parse(m.created_at) > askedAt && m.sender_account_id !== c.counterparty_account_id);
    if (reply) {
      if (Date.parse(reply.created_at) - askedAt <= windowMs) {out.within += 1;}
      else {out.later += 1;}
    } else if (now.getTime() - askedAt < windowMs) {out.open += 1;}
    else {out.never += 1;}
  }
  return out;
}

// ---------------------------------------------------------------------------
// The marketplace part of Home
// ---------------------------------------------------------------------------

export type OverviewWeek = { week_start: string; enquiries: number; opened: number; paid: number; partial: boolean };

export type PlatformHome = {
  paid_this_month: number;
  last_paid_at: string | null;
  fees: Fees & { top_label: string | null; paid_deals_ytd: number };
  reply: ReplyBuckets;
  since_deal: SinceDeal | null;
  overview: {
    weeks: OverviewWeek[];
    enquiries_30d: number;
    opened_30d: number;
    /** Three 30-day blocks, oldest first. */
    enquiry_blocks: number[];
    opened_blocks: number[];
  };
};

export function platformHome(rows: PlatformRows, now: Date, replySince: string): PlatformHome {
  const deals = realDeals(rows);
  const dealIds = new Set(deals.map((d) => d.id));
  const signals = enquiries(rows);
  const paid = paidDeals(rows.payments, dealIds);
  const feeTotals = fees(rows.payments, dealIds, now);
  const topDeal = deals.find((d) => d.id === feeTotals.top_deal_id);
  const year = String(now.getUTCFullYear());

  const thisWeek = weekOf(now.toISOString());
  const weekStarts = weekRange(thisWeek, OVERVIEW_WEEKS);
  const enquiryWeeks = enquiriesByWeek(signals, weekStarts);
  const openedWeeks = dealsByWeek(deals, weekStarts);
  const paidWeeks = paidByWeek(paid, weekStarts);
  const end = now.getTime() + 1;

  return {
    paid_this_month: paidInMonth(paid, monthOf(now)),
    last_paid_at: paid.at(-1)?.paid_at ?? null,
    fees: {
      ...feeTotals,
      // The seller's name: that is how the founders refer to the deal.
      top_label: topDeal?.supplier_account_id ? rows.accountNames.get(topDeal.supplier_account_id) ?? null : null,
      paid_deals_ytd: paid.filter((p) => p.paid_at.startsWith(year)).length,
    },
    reply: replyBuckets(rows, replySince, now),
    since_deal: sinceLastDeal(deals, signals, now),
    overview: {
      weeks: weekStarts.map((week_start, i) => ({
        week_start, enquiries: enquiryWeeks[i], opened: openedWeeks[i], paid: paidWeeks[i], partial: week_start === thisWeek,
      })),
      enquiries_30d: distinctBuyers(signals, end - 30 * DAY_MS, end),
      opened_30d: dealsBetween(deals, end - 30 * DAY_MS, end),
      enquiry_blocks: thirtyDayBlocks((from, to) => distinctBuyers(signals, from, to), now),
      opened_blocks: thirtyDayBlocks((from, to) => dealsBetween(deals, from, to), now),
    },
  };
}
