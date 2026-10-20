import { parseShape, type Parsed, type Rule } from "./bulk-trade-details";
import type { PriceBasis, Reputation } from "./bulk-demand-score";
import type { Registry } from "./bulk-registry";
import type { CompanyContextNote } from "./crm-postgres/company-context";
import type { SupplyFeedRow } from "./bulk-supply";
import { parseBuyerContext, type BuyerContext } from "./buyer-context";

/** Stated and agreed buy-boxes not confirmed for this long show as "Still wanted?". */
export const STALE_DAYS = 60;
/** Estimated buy-boxes (our research) older than this show as "Re-research". */
export const RESEARCH_STALE_DAYS = 180;

export const CLOSED_REASONS = ["bought_from_us", "bought_elsewhere", "no_longer_needed", "expired", "duplicate", "offer_reply", "moved_to_profile", "research_profile", "recycling", "supply", "not_demand", "other", "moved_to_lot"] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];
export const CLOSED_REASON_LABEL: Record<ClosedReason, string> = {
  bought_from_us: "Sold",
  bought_elsewhere: "Lost",
  no_longer_needed: "Dropped",
  expired: "Expired",
  other: "Other",
  duplicate: "Duplicate",
  moved_to_profile: "Moved to profile",
  moved_to_lot: "Offer reply",
  offer_reply: "Offer reply",
  research_profile: "Research profile",
  recycling: "Recycling",
  supply: "Seller",
  not_demand: "Not demand",
};
export const HISTORY_CATEGORIES = CLOSED_REASONS.filter((reason) => reason !== "moved_to_lot");

export const KINDS = ["request", "standing"] as const;
export type DemandKind = (typeof KINDS)[number];
export const KIND_LABEL: Record<DemandKind, string> = { request: "Request", standing: "Standing" };

/** How we know a standing buy-box, weakest first. */
export const BASES = ["estimated", "stated", "agreed"] as const;
export type Basis = (typeof BASES)[number];
export const BASIS_LABEL: Record<Basis, string> = { estimated: "Estimated", stated: "Stated", agreed: "Agreed" };

// The buyer-ask lists, number ranges, units and currencies live in the database (see bulk-registry.ts).
export type SpecListKey = string;
export type SpecNumberKey = string;

/** Structured criteria. Every key is optional; an empty spec means only "wants" describes the demand. */
type SpecLists = "chemistries" | "formats" | "cell_formats" | "conditions" | "origins" | "makes" | "cell_makers" | "system_brands" | "evidence" | "excludes";
type SpecNumbers = "kwh_min" | "kwh_max" | "min_soh";
/** The keys the app code reads directly are typed; the registry (database) decides which keys are allowed. */
export type Spec = Partial<Record<SpecLists, string[]> & Record<SpecNumbers, number> & { mixed_ok: boolean }> & Record<string, unknown>;

/** A live trade a demand row fits, from the matching. */
export type DemandFit = { lot_id: string; title: string; strength: "strong" | "partial"; reason: string; buyer_id: string | null };
/** A trade this demand's buyer was added to, with their status there. */
export type DemandTrade = { lot_id: string; title: string; status: string };

/** One demand row: a request (one-off, by a date) or a standing buy-box (ongoing). Bulk only, 2+ units. */
export type Demand = {
  id: string;
  priority: boolean;
  missing: string[];
  context_notes: CompanyContextNote[];
  inventory_matches: (SupplyFeedRow & { strength: "strong" | "partial"; reason: string })[];
  kind: DemandKind;
  basis: Basis | null;
  buyer: string;
  company_id: string | null;
  person_id: string | null;
  contact: string | null;
  email: string | null;
  wants: string;
  quantity: string | null;
  location: string | null;
  note: string | null;
  needed_by: string | null;
  volume: number | null;
  volume_unit: string | null;
  max_price: number | null;
  price_currency: string | null;
  price_unit: string | null;
  spec: Spec;
  context: BuyerContext;
  source_kind: string | null;
  source_label: string | null;
  source_url: string | null;
  source_quote: string | null;
  observed_on: string | null;
  status: "open" | "qualifying" | "closed";
  product_family: string | null;
  fee_eur: number | null;
  price_basis: PriceBasis | null;
  reputation: Reputation | null;
  qualify_question: string | null;
  qualify_asked_on: string | null;
  qualify_entered_on: string | null;
  activity_count: number;
  last_activity_at: string | null;
  moved_to: string | null;
  asked_on: string | null;
  score: number | null;
  expected_fee: number | null;
  has_stock: boolean;
  closed_reason: ClosedReason | null;
  confirmed_on: string | null;
  updated_at: string;
  fits: DemandFit[];
  trades: DemandTrade[];
  /** The buyer company's tier: A (procurement desk), B (qualified), C (the rest), or null. */
  tier: string | null;
  /** The buyer's contact whose latest email is newer than our last email to them (email only). */
  waiting: { since: string; who: string | null; subject: string | null } | null;
};

/** An open demand row the matching picked for a trade, shown as a Suggested buyer. */
export type SuggestedBuyer = {
  demand_id: string;
  tier: string | null;
  /** The buyer company's Stage (New, Contacted, Engaged, Active), or null without a company. */
  stage: string | null;
  /** "offer": a buyer we deal with, one who told us what they want, or one Alex has tiered. "introduce": an untiered
   * company still at Stage New (or none) matched only on ReBattery's estimated buy-box, so this trade is a reason to
   * introduce ourselves. */
  group: "offer" | "introduce";
  kind: DemandKind;
  basis: Basis | null;
  buyer: string;
  contact: string | null;
  wants: string;
  needed_by: string | null;
  confirmed_on: string | null;
  strength: "strong" | "partial";
  reason: string;
  /** The buyer's other rows that fit this trade, best first. */
  more: { demand_id: string; wants: string; strength: "strong" | "partial"; reason: string }[];
};

export type DemandInput = Partial<Pick<Demand,
  "kind" | "basis" | "buyer" | "company_id" | "person_id" | "contact" | "email" | "wants" | "quantity" | "location" | "note"
  | "confirmed_on" | "needed_by" | "volume" | "volume_unit" | "max_price" | "price_currency" | "price_unit" | "spec"
  | "observed_on" | "status" | "product_family" | "fee_eur" | "price_basis" | "reputation" | "qualify_question" | "qualify_asked_on" | "moved_to" | "priority" | "context">>;

/** Only compute a euro fee when amount, currency and compatible units are known. */
export function demandFee(input: DemandInput): number | null {
  if (input.price_currency !== "EUR" || !input.max_price || !input.price_unit) return null;
  const quantity = input.quantity?.trim().match(/^(\d+(?:[.,]\d+)?)\s*(packs?|cells?|modules?|systems?|kwh|mwh)$/i);
  const amount = input.volume ?? (quantity ? Number(quantity[1].replace(",", ".")) : null);
  const unit = (input.volume_unit ?? quantity?.[2])?.toLowerCase().replace(/s$/, "");
  const priced = input.price_unit.toLowerCase().replace(/s$/, "");
  if (!amount || !unit) return null;
  const factor = unit === priced ? 1 : unit === "mwh" && priced === "kwh" ? 1000 : null;
  return factor === null ? null : amount * factor * input.max_price * 0.1;
}

const DEMAND_RULES: Record<string, Rule> = {
  kind: KINDS, basis: BASES, buyer: "text", company_id: "text", person_id: "text", contact: "text", email: "text", wants: "text",
  quantity: "text", location: "text", note: "text", confirmed_on: "date", needed_by: "date", observed_on: "date",
  status: ["open", "qualifying", "closed"], product_family: "text", qualify_question: "text", qualify_asked_on: "date", moved_to: "text",
};
const NUMBER_KEYS = ["volume", "max_price", "fee_eur"] as const;
const optionKeys = (registry: Registry): Record<string, readonly string[]> => ({
  volume_unit: registry.volumeUnits, price_currency: registry.currencies, price_unit: registry.priceUnits,
  price_basis: ["buyer", "estimate"], reputation: ["paid", "active", "email", "inbound", "anon"],
});

/** Checks a spec: known keys only, list values from the registry, numbers in range. Empty values are dropped. */
export function parseSpec(value: unknown, registry: Registry): Parsed<Spec> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "spec must be an object." };
  const out: Spec = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    if (key in registry.specLists) {
      const allowed = registry.specLists[key];
      if (!Array.isArray(raw) || raw.some((item) => !allowed.includes(item as string))) {
        return { error: `spec.${key} must be a list from: ${allowed.join(", ")}.` };
      }
      if (raw.length) out[key] = [...new Set(raw as string[])];
    } else if (key in registry.specNumbers) {
      const range = registry.specNumbers[key];
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < range.min || raw > range.max) {
        return { error: `spec.${key} must be a number from ${range.min} to ${range.max}.` };
      }
      out[key] = raw;
    } else if (key === "mixed_ok") {
      if (typeof raw !== "boolean") return { error: "spec.mixed_ok must be true or false." };
      out.mixed_ok = raw;
    } else {
      return { error: `Unknown spec field: ${key}` };
    }
  }
  if (out.kwh_min !== undefined && out.kwh_max !== undefined && out.kwh_min > out.kwh_max) {
    return { error: "spec.kwh_min is above spec.kwh_max." };
  }
  return { value: out };
}

/** For specs a model wrote: keeps the valid parts and drops the rest, instead of rejecting the whole spec. */
export function cleanSpec(value: unknown, registry: Registry): Spec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key in registry.specLists && Array.isArray(raw)) {
      const kept = raw.filter((item) => registry.specLists[key].includes(item as string));
      if (kept.length) out[key] = kept;
    } else if (key in registry.specNumbers || key === "mixed_ok") {
      out[key] = raw;
    }
  }
  const checked = parseSpec(out, registry);
  if (!("error" in checked)) return checked.value;
  // A bad number or flag: keep the lists only.
  return Object.fromEntries(Object.entries(out).filter(([key]) => key in registry.specLists)) as Spec;
}

export function parseDemandInput(body: unknown, creating: boolean, registry: Registry): Parsed<DemandInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be an object." };
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  const extra: DemandInput = {};
  if ("context" in rest) {
    const context = parseBuyerContext(rest.context);
    if ("error" in context) return context;
    extra.context = context.value;
    delete rest.context;
  }
  if ("priority" in rest) {
    if (typeof rest.priority !== "boolean") return { error: "priority must be true or false." };
    extra.priority = rest.priority;
    delete rest.priority;
  }
  for (const key of NUMBER_KEYS) {
    if (!(key in rest)) continue;
    const value = rest[key];
    delete rest[key];
    if (value === null || value === "") extra[key] = null;
    else if (typeof value === "number" && Number.isFinite(value) && (key === "fee_eur" ? value >= 0 : value > 0)) extra[key] = value;
    else return { error: `${key} must be ${key === "fee_eur" ? "a non-negative" : "a positive"} number.` };
  }
  for (const [key, allowed] of Object.entries(optionKeys(registry))) {
    if (!(key in rest)) continue;
    const value = rest[key];
    delete rest[key];
    if (value === null || value === "") Object.assign(extra, { [key]: null });
    else if (typeof value === "string" && allowed.includes(value)) Object.assign(extra, { [key]: value });
    else return { error: `${key} must be one of: ${allowed.join(", ")}.` };
  }
  if ("spec" in rest) {
    const spec = parseSpec(rest.spec, registry);
    delete rest.spec;
    if ("error" in spec) return spec;
    extra.spec = spec.value;
  }
  if (rest.basis === null) delete rest.basis;
  const parsed = parseShape(rest, DEMAND_RULES, creating ? ["buyer", "wants"] : []);
  if ("error" in parsed) return parsed;
  const value = { ...(parsed.value as DemandInput), ...extra };
  for (const key of ["buyer", "wants"] as const) {
    if (key in value && !value[key]) return { error: `${key} is required.` };
  }
  if (value.email) value.email = value.email.toLowerCase();
  // Pairs are set together, so a partial edit can never leave half a pair behind.
  const volumeKeys = (["volume", "volume_unit"] as const).filter((key) => key in value);
  if (volumeKeys.length && (volumeKeys.length < 2 || (value.volume == null) !== (value.volume_unit == null))) {
    return { error: "Give both a volume and its unit, or neither." };
  }
  const priceKeys = (["max_price", "price_currency", "price_unit"] as const).filter((key) => key in value);
  if (priceKeys.length && (priceKeys.length < 3
    || !((value.max_price == null && value.price_currency == null && value.price_unit == null)
      || (value.max_price != null && value.price_currency != null && value.price_unit != null)))) {
    return { error: "A max price needs a currency and a unit; clear all three together." };
  }
  if (creating) {
    value.kind ??= "standing";
    if (value.kind === "standing") value.basis ??= "stated";
  }
  if (value.kind === "request") {
    if (value.basis) return { error: "A request has no basis; only standing buy-boxes do." };
    value.basis = null;
  } else if (value.kind === "standing") {
    if (value.needed_by) return { error: "A standing buy-box has no needed-by date; make it a request instead." };
    value.needed_by = null;
  }
  return { value };
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type CheckReason = "past_needed_by" | "still_wanted" | "re_research";
export const CHECK_LABEL: Record<CheckReason, string> = {
  past_needed_by: "Past needed-by",
  still_wanted: "Still wanted?",
  re_research: "Re-research",
};

/** Why an open row needs a look, or null: a request past its date, a stale stated or agreed buy-box, an old estimate. */
export function checkReason(demand: Pick<Demand, "status" | "kind" | "basis" | "needed_by" | "confirmed_on" | "observed_on">, today: string): CheckReason | null {
  if (demand.status !== "open") return null;
  if (demand.kind === "request") return demand.needed_by && demand.needed_by < today ? "past_needed_by" : null;
  if (demand.basis === "estimated") {
    const seen = demand.confirmed_on ?? demand.observed_on;
    return !seen || daysBetween(seen, today) > RESEARCH_STALE_DAYS ? "re_research" : null;
  }
  return !demand.confirmed_on || daysBetween(demand.confirmed_on, today) > STALE_DAYS ? "still_wanted" : null;
}

/** Open and due a look (see checkReason). */
export function isStale(demand: Parameters<typeof checkReason>[0], today: string): boolean {
  return checkReason(demand, today) !== null;
}

/** Sort rank for suggestions and lists: live requests, then agreed, stated, estimated. */
export function demandRank(demand: Pick<Demand, "kind" | "basis">): number {
  if (demand.kind === "request") return 0;
  return { agreed: 1, stated: 2, estimated: 3 }[demand.basis ?? "stated"];
}

/** "200 packs a month", "1,000 cells", or the buyer's own words when there is no number. */
export function volumeLabel(demand: Pick<Demand, "kind" | "volume" | "volume_unit" | "quantity">): string | null {
  if (demand.volume == null || !demand.volume_unit) return demand.quantity;
  const amount = `${Number(demand.volume).toLocaleString("en-GB")} ${demand.volume_unit}`;
  return demand.kind === "standing" ? `${amount} a month` : amount;
}

/** "EUR 20/kWh" */
export function priceLabel(demand: Pick<Demand, "max_price" | "price_currency" | "price_unit">): string | null {
  if (demand.max_price == null || !demand.price_currency || !demand.price_unit) return null;
  return `${demand.price_currency} ${Number(demand.max_price).toLocaleString("en-GB")}/${demand.price_unit}`;
}

/** "Waiting 3d" style age of an unanswered email; "Waiting today" under a day. */
export function waitingLabel(since: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - Date.parse(since)) / 86_400_000);
  return days < 1 ? "Waiting today" : `Waiting ${days}d`;
}

/** One line per filled spec field, e.g. ["Chemistry: LFP, NMC", "Min SOH %: 70"]. */
export function specLines(spec: Spec, registry: Registry | null): string[] {
  const lines: string[] = [];
  if (!registry) return lines;
  for (const key of Object.keys(registry.specLists)) {
    const values = spec[key];
    if (Array.isArray(values) && values.length) lines.push(`${registry.specLabels[key]}: ${values.join(", ")}`);
  }
  for (const key of Object.keys(registry.specNumbers)) {
    if (spec[key] !== undefined) lines.push(`${registry.specNumbers[key].label}: ${spec[key]}`);
  }
  if (spec.mixed_ok !== undefined) lines.push(spec.mixed_ok ? "Mixed batches OK" : "One make and model per batch");
  return lines;
}
