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
  /** The Deals board stage, or null when the listing is not a deal (see BOARD_STAGES). */
  deal_stage: DealStage | null;
  /** True when furthest_stage is on the signing and paying track or beyond: the listing is a trade. A label on the same record, not a separate one. */
  is_trade: boolean;
  /** Present when kind is demand: the existing Demand row the demand panel renders. */
  demand?: Demand;
};

/** A trade is a listing on the signing and paying track or beyond: a contract is out with a counterparty. */
export const TRADE_STAGES: readonly OfferStage[] = ["contract_out", "signed", "invoiced", "paid", "complete"];

/** Every list stage, in order (team, 27 Oct 2026). Computed by bulk_listing_stage() in Postgres (migration 116); never
 * stored. Requests (demand) and Supply each have their own list (DEMAND_STAGES, SUPPLY_STAGES). Closed is a demand stage,
 * and also where a supply listing that closed without a sale ends up. */
export const LISTING_STAGES = ["New", "Qualified", "Sourcing", "Available", "Found", "Reserved", "Sold", "Closed"] as const;
export type ListingStage = (typeof LISTING_STAGES)[number];

/** Requests: New, Qualified, Sourcing (looking for supply), Found (a supplier has been offered), Closed. */
export const DEMAND_STAGES = ["New", "Qualified", "Sourcing", "Found", "Closed"] as const satisfies readonly ListingStage[];
/** Supply: New, Qualified, Available (ready for buyers), Reserved (on hold: hold_until, for now), Sold. */
export const SUPPLY_STAGES = ["New", "Qualified", "Available", "Reserved", "Sold"] as const satisfies readonly ListingStage[];

/** The Deals board: a listing is a deal once a counterparty has been offered it, and Lost when every counterparty
 * offer is declined or lost. Computed by bulk_listing_deal_stage(); null when the listing is not a deal. */
export const BOARD_STAGES = ["Offered", "Negotiating", "Agreed", "Paid", "Delivered", "Lost"] as const;
export type DealStage = (typeof BOARD_STAGES)[number];

/** Labels from bulk_listing_stage() before migration 116 (and older links), mapped to today's list stages so the UI reads
 * right whichever order the UI and the migration go live in. Before 116 the deal stages and Can't source were list stages. */
const LEGACY_STAGE: Record<string, (kind: ListingKind) => ListingStage> = {
  Matched: (kind) => (kind === "demand" ? "Sourcing" : "Available"),
  Found: (kind) => (kind === "demand" ? "Found" : "Available"),
  "Can't source": (kind) => (kind === "demand" ? "Sourcing" : "Available"),
  Offered: (kind) => (kind === "demand" ? "Found" : "Available"),
  Negotiating: (kind) => (kind === "demand" ? "Found" : "Available"),
  Agreed: (kind) => (kind === "demand" ? "Found" : "Available"),
  "Signed & Paid": (kind) => (kind === "demand" ? "Found" : "Available"),
  Paid: (kind) => (kind === "demand" ? "Found" : "Sold"),
  Delivered: (kind) => (kind === "demand" ? "Found" : "Sold"),
  Complete: (kind) => (kind === "demand" ? "Found" : "Sold"),
};

/** A stage label as the UI should show it for one kind: its own stages as they are, older labels mapped, anything else unchanged. */
export function listingStageOf(label: string, kind: ListingKind): ListingStage {
  if ((stagesFor(kind) as readonly string[]).includes(label) || label === "Closed") return label as ListingStage;
  return LEGACY_STAGE[label]?.(kind) ?? (label as ListingStage);
}

/** A Progress filter value for a list of one kind: kept when it is one of that kind's stages, mapped when it is an older
 * label, otherwise dropped (null). */
export function progressFor(value: string, kind: ListingKind): ListingStage | null {
  const stage = listingStageOf(value, kind);
  return (stagesFor(kind) as readonly string[]).includes(stage) ? stage : null;
}

/** A deal stage from bulk_listing_deal_stage(), or null for anything else (no deal yet, or an unknown label). */
export function dealStageOf(label: string | null | undefined): DealStage | null {
  return label && (BOARD_STAGES as readonly string[]).includes(label) ? (label as DealStage) : null;
}

export function isBoardStage(stage: string | null | undefined): boolean {
  return dealStageOf(stage) !== null;
}

/** The stages one kind of listing can be in. */
export function stagesFor(kind: ListingKind): readonly ListingStage[] {
  return kind === "demand" ? DEMAND_STAGES : SUPPLY_STAGES;
}
