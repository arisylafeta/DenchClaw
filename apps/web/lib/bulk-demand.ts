import { parseShape, type Parsed, type Rule } from "./bulk-trade-details";
// The lists live in buy-box-spec.json so the Python inbox check reads the same ones.
import specConfig from "./buy-box-spec.json";

/** Stated and agreed buy-boxes not confirmed for this long show as "Still wanted?". */
export const STALE_DAYS = 60;
/** Estimated buy-boxes (our research) older than this show as "Re-research". */
export const RESEARCH_STALE_DAYS = 180;

export const CLOSED_REASONS = ["bought_from_us", "bought_elsewhere", "no_longer_needed", "expired", "other"] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];
export const CLOSED_REASON_LABEL: Record<ClosedReason, string> = {
  bought_from_us: "Bought from us",
  bought_elsewhere: "Bought elsewhere",
  no_longer_needed: "No longer needed",
  expired: "Past its date",
  other: "Other",
};

export const KINDS = ["request", "standing"] as const;
export type DemandKind = (typeof KINDS)[number];
export const KIND_LABEL: Record<DemandKind, string> = { request: "Request", standing: "Standing" };

/** How we know a standing buy-box, weakest first. */
export const BASES = ["estimated", "stated", "agreed"] as const;
export type Basis = (typeof BASES)[number];
export const BASIS_LABEL: Record<Basis, string> = { estimated: "Estimated", stated: "Stated", agreed: "Agreed" };

export const SPEC_LISTS = specConfig.lists;
export type SpecListKey = keyof typeof SPEC_LISTS;
export const SPEC_LIST_KEYS = Object.keys(SPEC_LISTS) as SpecListKey[];
export const SPEC_LABELS = specConfig.labels as Record<SpecListKey, string>;
export const SPEC_NUMBERS = specConfig.numbers;
export type SpecNumberKey = keyof typeof SPEC_NUMBERS;
export const SPEC_NUMBER_KEYS = Object.keys(SPEC_NUMBERS) as SpecNumberKey[];
export const VOLUME_UNITS = specConfig.volume_units;
export const PRICE_UNITS = specConfig.price_units;
export const CURRENCIES = specConfig.currencies;

/** Structured criteria. Every key is optional; an empty spec means only "wants" describes the demand. */
export type Spec = Partial<Record<SpecListKey, string[]> & Record<SpecNumberKey, number> & { mixed_ok: boolean }>;

/** A live trade a demand row fits, from the matching. */
export type DemandFit = { lot_id: string; title: string; strength: "strong" | "partial"; reason: string; buyer_id: string | null };
/** A trade this demand's buyer was added to, with their status there. */
export type DemandTrade = { lot_id: string; title: string; status: string };

/** One demand row: a request (one-off, by a date) or a standing buy-box (ongoing). Bulk only, 2+ units. */
export type Demand = {
  id: string;
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
  source_kind: string | null;
  source_label: string | null;
  source_url: string | null;
  source_quote: string | null;
  observed_on: string | null;
  status: "open" | "closed";
  closed_reason: ClosedReason | null;
  confirmed_on: string | null;
  updated_at: string;
  fits: DemandFit[];
  trades: DemandTrade[];
  /** The buyer's contact whose latest email is newer than our last email to them (email only). */
  waiting: { since: string; who: string | null; subject: string | null } | null;
};

/** An open demand row the matching picked for a trade, shown as a Suggested buyer. */
export type SuggestedBuyer = {
  demand_id: string;
  kind: DemandKind;
  basis: Basis | null;
  buyer: string;
  contact: string | null;
  wants: string;
  needed_by: string | null;
  confirmed_on: string | null;
  strength: "strong" | "partial";
  reason: string;
};

export type DemandInput = Partial<Pick<Demand,
  "kind" | "basis" | "buyer" | "company_id" | "person_id" | "contact" | "email" | "wants" | "quantity" | "location" | "note"
  | "confirmed_on" | "needed_by" | "volume" | "volume_unit" | "max_price" | "price_currency" | "price_unit" | "spec"
  | "observed_on">>;
const DEMAND_RULES: Record<string, Rule> = {
  kind: KINDS, basis: BASES, buyer: "text", company_id: "text", person_id: "text", contact: "text", email: "text", wants: "text",
  quantity: "text", location: "text", note: "text", confirmed_on: "date", needed_by: "date", observed_on: "date",
};
const NUMBER_KEYS = ["volume", "max_price"] as const;
const OPTION_KEYS = { volume_unit: VOLUME_UNITS, price_currency: CURRENCIES, price_unit: PRICE_UNITS } as const;

/** Checks a spec: known keys only, list values from buy-box-spec.json, numbers in range. Empty values are dropped. */
export function parseSpec(value: unknown): Parsed<Spec> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "spec must be an object." };
  const out: Spec = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    if (key in SPEC_LISTS) {
      const allowed = SPEC_LISTS[key as SpecListKey];
      if (!Array.isArray(raw) || raw.some((item) => !allowed.includes(item as string))) {
        return { error: `spec.${key} must be a list from: ${allowed.join(", ")}.` };
      }
      if (raw.length) out[key as SpecListKey] = [...new Set(raw as string[])];
    } else if (key in SPEC_NUMBERS) {
      const range = SPEC_NUMBERS[key as SpecNumberKey];
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < range.min || raw > range.max) {
        return { error: `spec.${key} must be a number from ${range.min} to ${range.max}.` };
      }
      out[key as SpecNumberKey] = raw;
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
export function cleanSpec(value: unknown): Spec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key in SPEC_LISTS && Array.isArray(raw)) {
      const kept = raw.filter((item) => SPEC_LISTS[key as SpecListKey].includes(item as string));
      if (kept.length) out[key] = kept;
    } else if (key in SPEC_NUMBERS || key === "mixed_ok") {
      out[key] = raw;
    }
  }
  const checked = parseSpec(out);
  if (!("error" in checked)) return checked.value;
  // A bad number or flag: keep the lists only.
  return Object.fromEntries(Object.entries(out).filter(([key]) => key in SPEC_LISTS)) as Spec;
}

export function parseDemandInput(body: unknown, creating: boolean): Parsed<DemandInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be an object." };
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  const extra: DemandInput = {};
  for (const key of NUMBER_KEYS) {
    if (!(key in rest)) continue;
    const value = rest[key];
    delete rest[key];
    if (value === null || value === "") extra[key] = null;
    else if (typeof value === "number" && Number.isFinite(value) && value > 0) extra[key] = value;
    else return { error: `${key} must be a positive number.` };
  }
  for (const [key, allowed] of Object.entries(OPTION_KEYS) as [keyof typeof OPTION_KEYS, string[]][]) {
    if (!(key in rest)) continue;
    const value = rest[key];
    delete rest[key];
    if (value === null || value === "") extra[key] = null;
    else if (typeof value === "string" && allowed.includes(value)) extra[key] = value;
    else return { error: `${key} must be one of: ${allowed.join(", ")}.` };
  }
  if ("spec" in rest) {
    const spec = parseSpec(rest.spec);
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
  if ("volume" in value && "volume_unit" in value && (value.volume == null) !== (value.volume_unit == null)) {
    return { error: "Give both a volume and its unit, or neither." };
  }
  if ("max_price" in value && (value.max_price != null) && (!value.price_currency || !value.price_unit)) {
    return { error: "A max price needs a currency and a unit." };
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
export function specLines(spec: Spec): string[] {
  const lines: string[] = [];
  for (const key of SPEC_LIST_KEYS) {
    const values = spec[key];
    if (values?.length) lines.push(`${SPEC_LABELS[key]}: ${values.join(", ")}`);
  }
  for (const key of SPEC_NUMBER_KEYS) {
    if (spec[key] !== undefined) lines.push(`${SPEC_NUMBERS[key].label}: ${spec[key]}`);
  }
  if (spec.mixed_ok !== undefined) lines.push(spec.mixed_ok ? "Mixed batches OK" : "One make and model per batch");
  return lines;
}
