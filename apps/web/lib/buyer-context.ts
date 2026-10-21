import type { Parsed } from "./bulk-trade-details";

/** Decision-relevant context. When supplied in a PATCH, replaces the full context object. */
export type BuyerContext = {
  listing_title?: string;
  application?: string;
  min_usable_energy_kwh_per_pack?: number;
  homogeneous_within_container?: boolean;
  repeat_supply_required?: boolean;
  container_design_finalized?: boolean | null;
  pilot_quantity_conflict?: boolean;
  pilot_quantities_observed?: {
    packs: number;
    date: string;
    source: string;
    source_ref?: string;
  }[];
  alternatives_to_confirm?: string[];
  latest_buyer_response_on?: string;
  missing_documents?: string[];
  next_action?: string;
  sources?: { kind: string; id?: string; url?: string; label: string }[];
  /** The pack types the buyer asked for, one row each (for example a shortlist of marketplace listings). Shown as a table under Product. */
  packs?: BuyerPack[];
  reviewed_at?: string;
};

export type BuyerPack = {
  title: string;
  /** How many of this pack; omit for one. */
  quantity?: number;
  chemistry?: string;
  kwh?: number;
  location?: string;
  url?: string;
  /** Our price for this pack from the supplier, in GBP. */
  supply_price?: number;
  /** What we suggest quoting the buyer, in GBP. */
  suggested_price?: number;
  /** "possible": the buyer may want it, to confirm. Omit when the buyer named it. */
  status?: "possible";
  seen_on?: string;
};

const PACK_KEYS = ["title", "quantity", "chemistry", "kwh", "location", "url", "status", "seen_on", "supply_price", "suggested_price"];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function date(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function safeContextUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function parseBuyerContext(value: unknown): Parsed<BuyerContext> {
  if (!object(value)) return { error: "context must be an object." };
  for (const [key, raw] of Object.entries(value)) {
    let valid = false;
    switch (key) {
      case "listing_title":
      case "application":
      case "next_action":
        valid = typeof raw === "string";
        break;
      case "min_usable_energy_kwh_per_pack":
        valid = typeof raw === "number" && Number.isFinite(raw) && raw > 0;
        break;
      case "homogeneous_within_container":
      case "repeat_supply_required":
      case "pilot_quantity_conflict":
        valid = typeof raw === "boolean";
        break;
      case "container_design_finalized":
        valid = raw === null || typeof raw === "boolean";
        break;
      case "alternatives_to_confirm":
      case "missing_documents":
        valid = Array.isArray(raw) && raw.every((item) => typeof item === "string");
        break;
      case "latest_buyer_response_on":
        valid = date(raw);
        break;
      case "reviewed_at":
        valid =
          typeof raw === "string" &&
          (date(raw) || (date(raw.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T/.test(raw) && !Number.isNaN(Date.parse(raw))));
        break;
      case "pilot_quantities_observed":
        valid =
          Array.isArray(raw) &&
          raw.every(
            (item) =>
              object(item) &&
              Object.keys(item).every((k) =>
                ["packs", "date", "source", "source_ref"].includes(k),
              ) &&
              typeof item.packs === "number" &&
              Number.isInteger(item.packs) &&
              item.packs > 0 &&
              date(item.date) &&
              typeof item.source === "string" && item.source.trim().length > 0 &&
              (item.source_ref === undefined || typeof item.source_ref === "string"),
          );
        break;
      case "packs":
        valid =
          Array.isArray(raw) &&
          raw.length <= 50 &&
          raw.every(
            (item) =>
              object(item) &&
              Object.keys(item).every((k) => PACK_KEYS.includes(k)) &&
              typeof item.title === "string" && item.title.trim().length > 0 &&
              (item.quantity === undefined || (typeof item.quantity === "number" && Number.isInteger(item.quantity) && item.quantity > 0)) &&
              (item.supply_price === undefined || (typeof item.supply_price === "number" && Number.isFinite(item.supply_price) && item.supply_price >= 0)) &&
              (item.suggested_price === undefined || (typeof item.suggested_price === "number" && Number.isFinite(item.suggested_price) && item.suggested_price >= 0)) &&
              (item.chemistry === undefined || typeof item.chemistry === "string") &&
              (item.kwh === undefined || (typeof item.kwh === "number" && Number.isFinite(item.kwh) && item.kwh > 0)) &&
              (item.location === undefined || typeof item.location === "string") &&
              (item.url === undefined || (typeof item.url === "string" && !!safeContextUrl(item.url))) &&
              (item.status === undefined || item.status === "possible") &&
              (item.seen_on === undefined || date(item.seen_on)),
          );
        break;
      case "sources":
        valid =
          Array.isArray(raw) &&
          raw.every(
            (item) =>
              object(item) &&
              Object.keys(item).every((k) => ["kind", "id", "url", "label"].includes(k)) &&
              typeof item.kind === "string" && item.kind.trim().length > 0 &&
              typeof item.label === "string" && item.label.trim().length > 0 &&
              (item.id === undefined || typeof item.id === "string") &&
              (item.url === undefined ||
                (typeof item.url === "string" && !!safeContextUrl(item.url))),
          );
        break;
      default:
        return { error: `Unknown context field: ${key}` };
    }
    if (!valid) return { error: `Invalid context.${key}.` };
  }
  return { value: value as BuyerContext };
}