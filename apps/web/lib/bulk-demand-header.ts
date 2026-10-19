import type { Demand } from "./bulk-demand";
import { priceLabel, specLines, volumeLabel } from "./bulk-demand";
import { shortDate } from "./bulk-trade-details";

/** What is being asked for, as a headline: "4 × Renault Zoe 41 kWh packs". The buyer is shown separately. */
export function demandTitle(demand: Pick<Demand, "wants" | "product_family" | "buyer">): string {
  const raw = (demand.wants || demand.product_family || demand.buyer).trim().replace(/\s+/g, " ");
  const first = raw.split(/(?<=[.!?])\s|\s[—–]\s|;\s/)[0].replace(/[.\s]+$/, "");
  const clipped = first.length > 90 ? `${first.slice(0, 87).replace(/\s+\S*$/, "")}…` : first;
  return clipped.replace(/^(\d[\d,]*)\s+(?!(?:kwh|mwh|ah|v|%|kw)\b)(?=[A-Za-z])/i, "$1 × ");
}

const money = (amount: number, currency: string) =>
  `${currency} ${new Intl.NumberFormat("en-GB", { notation: amount >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(amount)}`;
const unitKey = (unit: string | null) => (unit ?? "").toLowerCase().replace(/s$/, "");

/** Buyer's price times volume when both use the same unit (packs and pack, kWh and kWh); never a guess. */
export function demandValue(demand: Pick<Demand, "max_price" | "price_currency" | "price_unit" | "volume" | "volume_unit" | "expected_fee">): { text: string; note: string | null } | null {
  const { max_price: price, price_currency: currency, volume } = demand;
  if (price != null && currency && volume != null && unitKey(demand.price_unit) === unitKey(demand.volume_unit) && unitKey(demand.price_unit)) {
    return { text: `≈ ${money(price * volume, currency)}`, note: demand.expected_fee != null ? `fee ≈ ${money(demand.expected_fee, "EUR")}` : null };
  }
  if (demand.expected_fee != null) return { text: `≈ ${money(demand.expected_fee, "EUR")}`, note: "our fee" };
  return null;
}

/** The day the request started: when the buyer said it, else when we first asked. */
export function demandStarted(demand: Pick<Demand, "observed_on" | "asked_on">): string | null {
  const date = (demand.observed_on ?? demand.asked_on)?.slice(0, 10);
  if (!date) return null;
  const year = date.slice(0, 4);
  return year === String(new Date().getFullYear()) ? shortDate(date) : `${shortDate(date)} ${year}`;
}

const sentence = (text: string) => {
  const clean = text.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
};

/** A short brief built only from what is recorded on the demand and its buyer context. Capped at 200 words. */
export function demandDescription(demand: Demand, maxWords = 200): string {
  const parts: string[] = [];
  const asked = demand.wants.trim().replace(/[.\s]+$/, "");
  if (asked) parts.push(`${demand.buyer} ${demand.kind === "standing" ? "regularly buys" : "is asking for"}: ${asked}.`);
  if (demand.context?.application) parts.push(`Intended use: ${sentence(demand.context.application)}`);
  const facts = [volumeLabel(demand) && `Volume ${volumeLabel(demand)}`, priceLabel(demand) && `target price ${priceLabel(demand)}`,
    demand.needed_by && `needed by ${shortDate(demand.needed_by)}`, demand.location && `delivery to ${demand.location}`].filter(Boolean) as string[];
  if (facts.length) parts.push(`${facts.join(", ")}.`);
  const spec = specLines(demand.spec ?? {});
  if (spec.length) parts.push(`Requirements: ${spec.join("; ")}.`);
  for (const note of (demand.context_notes ?? []).slice(0, 3)) parts.push(sentence(note.note));
  if (demand.note) parts.push(sentence(demand.note));
  const missing = demand.context?.missing_documents;
  if (missing?.length) parts.push(`Still missing: ${missing.join(", ")}.`);
  const seen = new Set<string>();
  const words: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const next = part.split(/\s+/);
    if (words.length + next.length > maxWords) {
      if (!words.length) words.push(...next.slice(0, maxWords - 1), `${next[maxWords - 1]}…`);
      break;
    }
    words.push(...next);
  }
  return words.join(" ");
}
