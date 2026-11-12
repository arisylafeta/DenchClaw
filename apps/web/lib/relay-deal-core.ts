/**
 * A bulk deal opened from a lead card, the pure part: the listing, its fields, the next action and the Story row,
 * built from the facts the card already holds. No model runs. The shape mirrors what Matcha's "Create deal" job writes
 * (intake.md, "Relay buttons"; adding-listings.md): sender email, title, the card, location, next_action, next_due,
 * waiting_on, one Story row and the thread link. relay-deal.ts writes it.
 */
import { CHECK_FIELD, parsePrice, sizeLead, totalKwh, unitCount, USD_PER, type LeadRoute } from "./relay-front-door";
import type { LeadData } from "./relay-lead-core";
import { parseWhen } from "./relay-when";

export type CardDealField = { key: string; value: string; visibility: "teaser" | "after_nda" | "after_loi" | "never" };
export type CardDeal = {
  kind: "supply" | "demand";
  title: string;
  summary: string;
  quantity: string | null;
  location: string | null;
  clear_by: string | null;
  spec: Record<string, unknown>;
  context: Record<string, unknown>;
  next_action: string;
  next_due: string;
  fields: CardDealField[];
  story: { title: string; body: string; data: Record<string, unknown> };
};

const fact = (lead: LeadData, key: string) => lead.facts.find((f) => f.key === key)?.value?.trim() || null;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Two working days on (Monday to Friday): when we chase if they have not answered. */
export function workingDaysAfter(from: Date, days: number): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return iso(d);
}

/** naming.md: "<quantity>x <make model> [unit]", 70 characters at most, no price and no company. Null facts are left out. */
export function dealTitle(lead: LeadData): string {
  const what = (fact(lead, "what") ?? "").replace(/\s*(?:[€£$]|\b(?:eur|gbp|usd)\b).*$/i, "").replace(/\s+/g, " ").trim();
  const howMany = fact(lead, "how_many") ?? "";
  const units = unitCount(howMany);
  const energy = totalKwh(howMany);
  const unitWord = cap(lead.unit);
  const thing = what ? (/\b(packs?|modules?|cells?|batter(y|ies)|systems?|containers?)\b/i.test(what) ? cap(what) : `${cap(what)} ${unitWord}`) : unitWord;
  let title = thing;
  if (units && units.min === units.max) title = `${units.min.toLocaleString("en-GB")}x ${thing}`;
  else if (units && units.max === Infinity) title = `${units.min.toLocaleString("en-GB")}+ ${thing}`;
  else if (units) title = `${units.min.toLocaleString("en-GB")}-${units.max.toLocaleString("en-GB")}x ${thing}`;
  else if (energy && energy.min === energy.max) title = `${energy.min >= 1000 ? `${energy.min / 1000}MWh` : `${energy.min}kWh`} ${thing}`;
  if (title.length > 70) title = `${title.slice(0, 69).replace(/\s+\S*$/, "")}`;
  return title || lead.summary.slice(0, 70) || "New lead";
}

/** The checklist key each lead ask stands for, where one does: the asks the first reply made count as asked. */
export const ASK_TO_CHECK: Record<string, string> = { what: "what", how_many: "how_many", price: "price", where: "where", health: "health", when: "when", condition: "condition", min_health: "health" };

/** The crm_bulk_listing_fields keys asked for, by the reply's asks. */
export function askedFields(kind: "supply" | "demand", askKeys: string[]): string[] {
  return [...new Set(askKeys.map((k) => CHECK_FIELD[kind][ASK_TO_CHECK[k] ?? ""]).filter((f): f is string => !!f))];
}

const CHASE_LABEL: Record<string, string> = { what: "what", how_many: "how many", price: "price", where: "where", health: "health", when: "when", condition: "condition", owner: "owner", min_health: "minimum health" };

/** The deal a sent lead card opens. `asked`: the ask keys the reply carried. */
export function dealFromCard(input: { lead: LeadData; who: { name: string; email: string }; route: LeadRoute; asked: string[]; sentAt: Date }): CardDeal {
  const { lead, who, route, asked, sentAt } = input;
  const kind = lead.side === "buyer" ? "demand" : "supply";
  const what = fact(lead, "what"), howMany = fact(lead, "how_many"), price = fact(lead, "price"), where = fact(lead, "where"), when = fact(lead, "when");
  const whenDate = when ? parseWhen(when, sentAt)?.date ?? null : null;
  const sizing = sizeLead(lead.facts);
  const fields: CardDealField[] = [];
  const add = (key: string, value: string | null, visibility: CardDealField["visibility"]) => { if (value) fields.push({ key, value, visibility }); };

  const spec: Record<string, unknown> = {};
  const context: Record<string, unknown> = { listing_title: dealTitle(lead), owner: "Alex", size: route.size };
  if (route.route === "recycling") context.recycling = true;
  if (kind === "supply") {
    add("model", what, "teaser");
    add("quantity", howMany, "teaser");
    add("seller_price", price, "never");
    add("location", where, "after_nda");
    add("clear_by", when, "after_nda");
    add("soh", fact(lead, "health"), "after_nda");
    add("condition", fact(lead, "condition"), "after_nda");
    if (lead.unit === "packs" || lead.unit === "cells") spec.trade_kind = lead.unit;
    // The seller's own ask times their own quantity, only when both are exact: never an estimate.
    if (sizing.usd && sizing.usd.min === sizing.usd.max) {
      spec.value_eur = Math.round(sizing.usd.min / USD_PER.EUR);
      spec.value_basis = `Seller ask x quantity from their first email (${price}; ${howMany})`;
    }
  } else {
    spec.intent = "request";
    if (what) spec.product_family = what;
    const units = unitCount(howMany ?? ""), energy = totalKwh(howMany ?? "");
    const exact = energy && energy.min === energy.max ? { volume: energy.min >= 1000 ? energy.min / 1000 : energy.min, volume_unit: energy.min >= 1000 ? "MWh" : "kWh" }
      : units && units.min === units.max ? { volume: units.min, volume_unit: lead.unit } : null;
    if (exact) Object.assign(spec, exact);
    const p = price ? parsePrice(price) : null;
    const unit = p?.per === "kwh" ? "kWh" : p?.per === "unit" && lead.unit !== "modules" ? (lead.unit === "packs" ? "pack" : "cell") : null;
    if (p && unit && p.amount.min === p.amount.max && p.amount.min > 0) Object.assign(spec, { max_price: p.amount.min, price_currency: p.currency, price_unit: unit });
    add("product_family", what, "teaser");
    add("quantity", howMany, "teaser");
    add("max_price", price, "never");
    add("location", where, "after_nda");
    add("needed_by", when, "after_nda");
    add("min_soh", fact(lead, "min_health"), "teaser");
  }

  const gaps = asked.map((k) => CHASE_LABEL[k]).filter(Boolean);
  const name = lead.firstName ?? who.name;
  const next = gaps.length ? `Chase ${name} for the first ask: ${gaps.slice(0, 6).join(", ")}.` : `Read ${name}'s answer and check the checklist.`;
  const usdNote = sizing.usd ? ` (about USD ${Math.round(sizing.usd.min).toLocaleString("en-GB")}${sizing.usd.max !== sizing.usd.min ? "+" : ""})` : "";
  return {
    kind, title: String(context.listing_title), summary: lead.summary || what || "New lead from email",
    quantity: howMany, location: where, clear_by: kind === "supply" ? whenDate : null, spec, context,
    next_action: next, next_due: workingDaysAfter(sentAt, 2), fields,
    story: {
      title: "First reply sent; deal opened from the lead card",
      body: `${route.reason}${usdNote}. Asked for: ${gaps.join(", ") || "nothing, the email had it all"}.`,
      data: { route: route.route, size: route.size, reason: route.reason, facts: lead.facts, asked, kwh: sizing.kwh, usd: sizing.usd },
    },
  };
}
