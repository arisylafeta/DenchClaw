import type { OfferStage } from "./crm-postgres/bulk-offers";
import { TRADE_STAGES } from "./bulk-listing";

export const LISTING_STAGE_ORDER: readonly OfferStage[] = ["candidate", "offered", "negotiating", "contract_out", "signed", "invoiced", "paid", "complete"];

/** Closed unsuccessful offers do not advance a listing. */
export function listingStage(stages: readonly (OfferStage | null)[]) {
  const furthest_stage = [...LISTING_STAGE_ORDER].reverse().find((stage) => stages.includes(stage)) ?? null;
  return { furthest_stage, is_trade: furthest_stage !== null && TRADE_STAGES.includes(furthest_stage) };
}
