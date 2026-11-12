// Stored matching (crm_bulk_matches, migration 113): the rules that need no database. Which candidate a Matches row is,
// what a reservation holds, the plain reason when the model step is not used, and the check every model answer must pass
// before it is stored: the five ids in some order, one or two sentences each, no counterparty named, no figure the
// inputs do not hold.
import type { FitMark, MatchRow } from "../matches-types";
import { firstLeak } from "./offer-email";
import { londonDate, workingDaysBetween } from "./working-days";

export const MATCH_STATES = ["proposed", "asked", "confirmed", "declined", "replaced", "offered", "expired"] as const;
export type MatchState = typeof MATCH_STATES[number];

/** In the five: everything not declined, replaced or expired. */
export const LIVE_STATES: readonly MatchState[] = ["proposed", "asked", "confirmed", "offered"];
/** Counted by bulk_listing_has_match() for the stage: a person has acted on it. Proposed alone does not count. */
export const ACTED_STATES: readonly MatchState[] = ["asked", "confirmed", "offered"];

export const TOP = 5;
/** A reservation's default length, unless the quote it rests on runs out sooner. */
export const RESERVE_WORKING_DAYS = 5;
export const SCORER_VERSION = "matches-v2";
export const NO_REASON_MAX = 200;

export type CandidateKind = "listing" | "marketplace" | "stock" | "company";

/** Which candidate a row is, and what a reservation on it holds: the candidate itself on a request, the deal on a supply deal. */
export type CandidateRef = { kind: CandidateKind; id: string; stockKind: "listing" | "marketplace" | "stock"; stockId: string };

/** The Matches row key without the grouping prefix: a group is one supplier, stored as its cheapest unit. */
export const unitKey = (key: string) => key.replace(/^group:/, "");

export function candidateRef(key: string, deal: { id: string; kind: "supply" | "demand" }): CandidateRef | null {
  const plain = unitKey(key);
  const at = plain.indexOf(":");
  if (at <= 0) {
    return null;
  }
  const prefix = plain.slice(0, at);
  const id = plain.slice(at + 1);
  if (!id) {
    return null;
  }
  const kind: CandidateKind | null = prefix === "demand" || prefix === "supply" || prefix === "trade" ? "listing"
    : prefix === "listing" ? "marketplace" : prefix === "stock" ? "stock" : prefix === "company" ? "company" : null;
  if (!kind) {
    return null;
  }
  if (deal.kind === "supply") {
    return { kind, id, stockKind: "listing", stockId: deal.id };
  }
  if (kind === "company") {
    return null;
  }
  return { kind, id, stockKind: kind, stockId: id };
}

const MARK_WORD: Record<FitMark["state"], string> = { fits: "fits", close: "close", unstated: "not stated", misses: "misses" };

/** What the scorer found, as the "checks" the card shows on expand. */
export function checksOf(row: MatchRow): Record<string, unknown> {
  return {
    reason: row.reason,
    checks: row.checks,
    ...(row.fit?.length ? { fit: row.fit.map((mark) => ({ key: mark.key, label: mark.label, state: mark.state })) } : {}),
    tags: row.tags,
    ...(row.price ? { price: row.price } : {}),
    ...(row.units != null ? { units: row.units } : {}),
    ...(row.country ? { country: row.country } : {}),
    ...(row.holds ? { holds: row.holds } : {}),
    ...(row.askFor?.length ? { ask_for: row.askFor } : {}),
    ...(row.group?.stockIds.length ? { stock_ids: row.group.stockIds } : {}),
  };
}

/** The reason when the model step is not used: the scorer's own line and the first thing to check. Names nobody. */
export function ruleReason(row: MatchRow, forbidden: (string | null | undefined)[] = []): string {
  const fits = (row.fit ?? []).filter((mark) => mark.state === "fits").map((mark) => mark.key);
  const open = (row.fit ?? []).filter((mark) => mark.state !== "fits").map((mark) => `${mark.key} ${MARK_WORD[mark.state]}`);
  const first = fits.length ? `Fits on ${fits.join(", ")}.` : `${row.reason.replace(/[.\s]+$/, "")}.`;
  const second = open.length ? `Check ${open.slice(0, 2).join(", ")}.` : row.checks[0] ? `Check: ${row.checks[0].replace(/[.\s]+$/, "")}.` : "";
  const text = [first, second].filter(Boolean).join(" ");
  return firstLeak(text, forbidden) ? "Ranked by the scorer on the product it matched." : text;
}

/** The facts the model may use for one candidate. No names, no contact, nothing finer than the country. */
export function candidateFacts(row: MatchRow): string {
  return [
    row.tags.length ? `Source: ${row.tags.join(", ")}` : null,
    `Scorer: ${row.reason}`,
    row.holds ? `Holds: ${row.holds}` : null,
    row.units != null ? `Quantity: ${row.units}` : "Quantity: not stated",
    row.fit?.length ? `Fit: ${row.fit.map((mark) => `${mark.key} ${MARK_WORD[mark.state]} (${mark.label})`).join("; ")}` : null,
    row.checks.length ? `To check: ${row.checks.join("; ")}` : null,
    row.price ? `Their price: ${row.price}` : null,
    row.country ? `Country: ${row.country}` : null,
  ].filter(Boolean).join("\n");
}

export type Ranking = { order: string[]; reasons: Record<string, string> };
export type RankingCheck = { ok: true; ranking: Ranking } | { ok: false; why: string };

const NUMBER = /\d+(?:[.,]\d+)*/g;
const numbersIn = (text: string) => new Set((text.match(NUMBER) ?? []).map((value) => value.replace(/,/g, "")));
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter((part) => part.trim()).length;

/**
 * The model's answer, accepted only whole: every id once, a reason for each of one or two sentences, no counterparty
 * named (any candidate's or the deal's), no email address, and every figure present in that candidate's facts or the
 * ask. Anything else and the scorer's order and plain reasons stand.
 */
export function checkRanking(raw: unknown, input: { ids: string[]; facts: Record<string, string>; ask: string; forbidden: (string | null | undefined)[] }): RankingCheck {
  if (!raw || typeof raw !== "object") {
    return { ok: false, why: "no answer" };
  }
  const value = raw as { order?: unknown; reasons?: unknown };
  const order = Array.isArray(value.order) ? value.order.filter((id): id is string => typeof id === "string") : [];
  if (order.length !== input.ids.length || new Set(order).size !== order.length || !order.every((id) => input.ids.includes(id))) {
    return { ok: false, why: "the order is not the candidates given" };
  }
  const reasons = value.reasons && typeof value.reasons === "object" ? value.reasons as Record<string, unknown> : {};
  const out: Record<string, string> = {};
  for (const id of input.ids) {
    const reason = typeof reasons[id] === "string" ? (reasons[id] as string).replace(/\s+/g, " ").trim() : "";
    if (!reason || reason.length > 400 || sentences(reason) > 2) {
      return { ok: false, why: `reason for ${id} is missing or too long` };
    }
    if (/@|https?:\/\//i.test(reason)) {
      return { ok: false, why: `reason for ${id} carries an address` };
    }
    const leak = firstLeak(reason, input.forbidden);
    if (leak) {
      return { ok: false, why: `reason for ${id} names ${leak}` };
    }
    const known = numbersIn(`${input.facts[id] ?? ""}\n${input.ask}`);
    const unknown = [...numbersIn(reason)].find((figure) => !known.has(figure));
    if (unknown) {
      return { ok: false, why: `reason for ${id} cites ${unknown}, which is not in its facts` };
    }
    out[id] = reason;
  }
  return { ok: true, ranking: { order, reasons: out } };
}

const DAY = 86_400_000;
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** `days` Monday to Friday days after `from` (YYYY-MM-DD). The same count as bulk_add_working_days() in SQL. */
export function addWorkingDays(from: string, days: number): string {
  let time = Date.parse(`${from}T00:00:00Z`);
  let left = Math.max(0, days);
  while (left > 0) {
    time += DAY;
    const weekday = new Date(time).getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      left -= 1;
    }
  }
  return isoDay(time);
}

/** How long a reservation holds from `today`: five working days, or the quote's last day if that is sooner. */
export function reservationUntil(today: string, quoteUntil: string | null | undefined): string {
  const standard = addWorkingDays(today, RESERVE_WORKING_DAYS);
  return quoteUntil && quoteUntil < standard ? quoteUntil : standard;
}

/** A reservation is live while the match is offered and its last day is today or later; out of date reads as free. */
export function reservationLive(row: { state: string; reserved_until: string | null }, today: string): boolean {
  return row.state === "offered" && !!row.reserved_until && row.reserved_until.slice(0, 10) >= today;
}

/** "Asked 3 working days ago, no answer": for asked rows with no verdict yet. The chase slice drafts from this. */
export function askedAgo(row: { state: string; asked_at: string | null; verdict: string | null }, now: Date = new Date()): { days: number; label: string } | null {
  if (row.state !== "asked" || !row.asked_at || row.verdict) {
    return null;
  }
  const days = workingDaysBetween(row.asked_at, now);
  return { days, label: days === 0 ? "Asked today, no answer yet" : `Asked ${days} working ${days === 1 ? "day" : "days"} ago, no answer` };
}

/** Today in London, the day every reservation and quote date is compared with. */
export const today = (now: Date = new Date()) => londonDate(now);

/** The seller's quote on a supply deal is in date when the seller confirmed the price and its last day is not past. */
export function quoteInDate(quote: { value: string | null; status: string | null; validUntil: string | null }, on: string): boolean {
  return !!quote.value?.trim() && quote.status === "confirmed" && !!quote.validUntil && quote.validUntil >= on;
}
