import { parseShape, type Parsed, type Rule } from "./bulk-trade-details";

/** Demand not confirmed for this long shows as "Still wanted?". */
export const STALE_DAYS = 60;

export const CLOSED_REASONS = ["bought_from_us", "bought_elsewhere", "no_longer_needed", "other"] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];
export const CLOSED_REASON_LABEL: Record<ClosedReason, string> = {
  bought_from_us: "Bought from us",
  bought_elsewhere: "Bought elsewhere",
  no_longer_needed: "No longer needed",
  other: "Other",
};

/** A live trade a demand row fits, from the daily matching. */
export type DemandFit = { lot_id: string; title: string; strength: "strong" | "partial"; reason: string; buyer_id: string | null };

/** One "buyer wants X" row (bulk only, 2+ units). */
export type Demand = {
  id: string;
  buyer: string;
  company_id: string | null;
  person_id: string | null;
  contact: string | null;
  email: string | null;
  wants: string;
  quantity: string | null;
  location: string | null;
  note: string | null;
  source_label: string | null;
  source_url: string | null;
  source_quote: string | null;
  status: "open" | "closed";
  closed_reason: ClosedReason | null;
  confirmed_on: string | null;
  updated_at: string;
  fits: DemandFit[];
};

/** An open demand row the matching picked for a trade, shown as a Suggested buyer. */
export type SuggestedBuyer = {
  demand_id: string;
  buyer: string;
  contact: string | null;
  wants: string;
  confirmed_on: string | null;
  strength: "strong" | "partial";
  reason: string;
};

export type DemandInput = Partial<Pick<Demand, "buyer" | "company_id" | "person_id" | "contact" | "email" | "wants" | "quantity" | "location" | "note" | "confirmed_on">>;
const DEMAND_RULES: Record<string, Rule> = {
  buyer: "text", company_id: "text", person_id: "text", contact: "text", email: "text", wants: "text",
  quantity: "text", location: "text", note: "text", confirmed_on: "date",
};

export function parseDemandInput(body: unknown, creating: boolean): Parsed<DemandInput> {
  const parsed = parseShape(body, DEMAND_RULES, creating ? ["buyer", "wants"] : []);
  if ("error" in parsed) return parsed;
  const value = parsed.value as DemandInput;
  for (const key of ["buyer", "wants"] as const) {
    if (key in value && !value[key]) return { error: `${key} is required.` };
  }
  if (value.email) value.email = value.email.toLowerCase();
  return { value };
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Open and not confirmed in STALE_DAYS (or never). */
export function isStale(demand: Pick<Demand, "status" | "confirmed_on">, today: string): boolean {
  return demand.status === "open" && (!demand.confirmed_on || daysBetween(demand.confirmed_on, today) > STALE_DAYS);
}
