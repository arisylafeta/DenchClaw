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

/** The six stages of a listing, in order. Computed by bulk_listing_stage() in Postgres; never stored. */
export const LISTING_STAGES = ["New", "Qualified", "Matched", "Offered", "Signed & Paid", "Complete"] as const;
export type ListingStage = (typeof LISTING_STAGES)[number];
