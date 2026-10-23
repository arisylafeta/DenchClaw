import { queryPg } from "../postgres";
import type { BulkListingView, ListingStage } from "../bulk-listing";
import type { OfferStage } from "./bulk-offers";
import { listingStage, LISTING_STAGE_ORDER } from "../listing-stage";
import { demandTitle } from "../bulk-demand-header";
import { getDemand } from "./bulk-demand";

export type ListingRow = Omit<BulkListingView, "title" | "furthest_stage" | "is_trade" | "stage" | "demand">;

export async function getListing(id: string): Promise<ListingRow | null> {
  return (await queryPg<ListingRow>(`select id, kind, party, company_id, person_id, contact, email, summary,
    quantity, location, note, status, closed_reason, observed_on::text, next_action, next_due::text,
    spec, context, created_at::text, updated_at::text from crm_bulk_listings where id = $1`, [id]))[0] ?? null;
}

export async function listingFurthestStage(id: string): Promise<OfferStage | null> {
  const [row] = await queryPg<{ stage: OfferStage }>(`select stage from crm_bulk_offers
    where role = 'counterparty' and (bulk_listing_id = $1 or counterpart_id = $1)
      and stage = any($2::text[])
    order by array_position($2::text[], stage) desc limit 1`, [id, [...LISTING_STAGE_ORDER]]);
  return row?.stage ?? null;
}

export async function listingView(id: string): Promise<BulkListingView | null> {
  const listing = await getListing(id);
  if (!listing) return null;
  const [stage, demand, [{ listing_stage }]] = await Promise.all([
    listingFurthestStage(id), listing.kind === "demand" ? getDemand(id) : null,
    queryPg<{ listing_stage: ListingStage }>("select bulk_listing_stage($1) as listing_stage", [id]),
  ]);
  const title = [listing.spec.listing_title, listing.context.listing_title]
    .find((value): value is string => typeof value === "string" && !!value.trim());
  return { ...listing, ...listingStage([stage]), stage: listing_stage, title: demand ? demandTitle(demand) : title?.trim() || listing.summary,
    ...(demand ? { demand } : {}) };
}
