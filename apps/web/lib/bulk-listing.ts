// One model for everything in Trades Preview: a bulk listing. Demand (a buyer wants) or supply (a seller offers).
// There are no separate "trades". Any listing, demand or supply, becomes a trade once a deal on it is accepted: an offer reached
// loi or won, either an offer on this listing (offers.bulk_listing_id) or an offer on another listing that points back at this one
// (offers.counterpart_id). Example: a buyer's demand whose matched supply batch has an accepted offer from that buyer.
// Threads (email, WhatsApp, calls, notes) are the primary content: the party's own conversation, and one thread per offer.
// Safe for client and server.
import type { Demand } from "./bulk-demand";
import type { OfferStage } from "./crm-postgres/bulk-offers";

export type ListingKind = "demand" | "supply";

/** What GET /api/bulk-listings/[id] returns, for either kind. Demand carries its existing Demand shape too. */
export type BulkListingView = {
  id: string;
  kind: ListingKind;
  /** The buyer (demand) or seller (supply) as written. */
  party: string;
  company_id: string | null;
  person_id: string | null;
  contact: string | null;
  email: string | null;
  summary: string;
  quantity: string | null;
  location: string | null;
  note: string | null;
  status: "open" | "qualifying" | "closed";
  closed_reason: string | null;
  observed_on: string | null;
  next_action: string | null;
  next_due: string | null;
  /** Whose move it is: us or them. Null when not judged. */
  waiting_on: "us" | "them" | null;
  waiting_since: string | null;
  spec: Record<string, unknown>;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** Readable title (the demand title rules, or the supply's listing_title / summary). */
  title: string;
  /** The furthest stage reached by any offer on this listing or pointing at it (counterpart_id); null when none. */
  furthest_stage: OfferStage | null;
  /** One of LISTING_STAGES. */
  stage: ListingStage;
  /** True when furthest_stage is on the signing and paying track or beyond: the listing is a trade. A label on the same record, not a separate one. */
  is_trade: boolean;
  /** Present when kind is demand: the existing Demand row the demand panel renders. */
  demand?: Demand;
};

/** A trade is a listing on the signing and paying track or beyond: a contract is out with a counterparty. */
export const TRADE_STAGES: readonly OfferStage[] = ["contract_out", "signed", "invoiced", "paid", "complete"];

/** Every listing stage, in order. Computed by bulk_listing_stage() in Postgres; never stored. Demand and supply
 * have their own early stages (DEMAND_STAGES, SUPPLY_STAGES) and share the deal stages on the Board (BOARD_STAGES). */
export const LISTING_STAGES = ["New", "Qualified", "Sourcing", "Found", "Can't source", "Available", "Offered", "Negotiating", "Agreed", "Paid", "Delivered"] as const;
export type ListingStage = (typeof LISTING_STAGES)[number];

/** Deal stages: an offer is out to a counterparty. Only these are on the Board. */
export const BOARD_STAGES = ["Offered", "Negotiating", "Agreed", "Paid", "Delivered"] as const satisfies readonly ListingStage[];
/** Requests: we look for supply for a buyer, then deal. */
export const DEMAND_STAGES = ["New", "Qualified", "Sourcing", "Found", "Can't source", ...BOARD_STAGES] as const satisfies readonly ListingStage[];
/** Supply: a seller's stock is ready to put to buyers, then deal. */
export const SUPPLY_STAGES = ["New", "Qualified", "Available", ...BOARD_STAGES] as const satisfies readonly ListingStage[];
/** The stages the Requests and Supply lists show as buttons; the rest (Can't source, and the deal stages after Offered,
 * which the Deals tab covers) sit in a "More stages" menu. */
export const DEMAND_MAIN_STAGES = ["New", "Qualified", "Sourcing", "Found", "Offered"] as const satisfies readonly ListingStage[];
export const SUPPLY_MAIN_STAGES = ["New", "Qualified", "Available", "Offered"] as const satisfies readonly ListingStage[];

/** Labels from bulk_listing_stage() before migration 095, mapped to today's stages so the UI reads right whichever
 * order the UI and the migration go live in. Matched means a counterparty was found: Found for demand, Available for supply. */
const LEGACY_STAGE: Record<string, (kind: ListingKind) => ListingStage> = {
  Matched: (kind) => (kind === "demand" ? "Found" : "Available"),
  "Signed & Paid": () => "Agreed",
  Complete: () => "Delivered",
};

/** A stage label as the UI should show it: today's labels as they are, older ones mapped, anything else unchanged. */
export function listingStageOf(label: string, kind: ListingKind): ListingStage {
  return (LISTING_STAGES as readonly string[]).includes(label) ? (label as ListingStage) : LEGACY_STAGE[label]?.(kind) ?? (label as ListingStage);
}

/** A Progress filter value for a list of one kind: kept when it is one of that kind's stages, mapped when it is an older
 * label, otherwise dropped (null). */
export function progressFor(value: string, kind: ListingKind): ListingStage | null {
  const stage = listingStageOf(value, kind);
  return (stagesFor(kind) as readonly string[]).includes(stage) ? stage : null;
}

export function isBoardStage(stage: string): boolean {
  return (BOARD_STAGES as readonly string[]).includes(stage);
}

/** The stages one kind of listing can be in. */
export function stagesFor(kind: ListingKind): readonly ListingStage[] {
  return kind === "demand" ? DEMAND_STAGES : SUPPLY_STAGES;
}
