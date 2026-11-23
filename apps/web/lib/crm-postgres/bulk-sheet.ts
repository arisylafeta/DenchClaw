import { likelihoodScoreSql } from "../bulk-likelihood";
import { queryPg } from "../postgres";
import { listingRow, sortSheet, type ListingSheetInput, type SheetRow } from "../bulk-sheet";

/** Closed listings stay on the Board's Closed column this long. */
export const CLOSED_VISIBLE_DAYS = 30;
/** Closures that are housekeeping, not a ticket someone worked: merged duplicates and inbox clean-up. */
const HOUSEKEEPING_REASONS = ["duplicate", "research_profile", "moved_to_profile", "moved_to_lot", "offer_reply"];

/** One row per live listing (open or qualifying; a qualifying demand shows as stage New), including lots already mirrored as supply listings. */
const SHEET_BASE = `
  select listing.id, listing.kind, listing.party, listing.company_id, listing.summary,
    listing.spec, listing.context, listing.status, listing.updated_at::text,
    to_char(listing.observed_on, 'YYYY-MM-DD') as observed_on,
    listing.closed_reason, case when listing.status = 'closed' then coalesce(closed.at, listing.updated_at)::text end as closed_at,
    listing.next_action, to_char(listing.next_due, 'YYYY-MM-DD') as next_due,
    listing.waiting_on, to_char(listing.waiting_since, 'YYYY-MM-DD') as waiting_since, listing.contact,
    ${likelihoodScoreSql(`case when listing.kind = 'demand' then bulk_demand_score(
      (listing.spec->>'fee_eur')::numeric, listing.spec->>'price_basis', listing.spec->>'reputation',
      greatest(listing.observed_on, (listing.spec->>'confirmed_on')::date))
      else bulk_supply_score((listing.spec->>'value_eur')::numeric) end`, "listing.context")} as score,
    (select count(*)::int from crm_bulk_listing_activity a
      where a.bulk_listing_id = listing.id and a.kind <> 'status') as activity_count,
    latest.kind as latest_kind, latest.title as latest_title, latest.occurred_at::text as latest_at,
    offer.stage as furthest_stage,
    case when offer.stage not in ('declined', 'lost') then offer.paired_listing_id end as paired_listing_id,
    bulk_listing_stage(listing.id) as stage
  from crm_bulk_listings listing
  left join lateral (
    select a.kind, a.title, a.occurred_at from crm_bulk_listing_activity a
    where a.bulk_listing_id = listing.id and a.kind <> 'status'
    order by a.occurred_at desc, a.id desc limit 1
  ) latest on true
  left join lateral (
    select max(a.occurred_at) as at from crm_bulk_listing_activity a
    where a.bulk_listing_id = listing.id and a.kind = 'status' and a.title like 'Closed%'
  ) closed on listing.status = 'closed'
  left join lateral (
    select o.stage, case when o.bulk_listing_id = listing.id then o.counterpart_id else o.bulk_listing_id end as paired_listing_id
    from crm_bulk_offers o
    where (o.bulk_listing_id = listing.id or o.counterpart_id = listing.id) and o.stage is not null
    order by case o.stage when 'complete' then 8 when 'paid' then 7 when 'invoiced' then 6 when 'signed' then 5
      when 'contract_out' then 4 when 'negotiating' then 3 when 'offered' then 2 when 'candidate' then 1 else 0 end desc,
      o.updated_at desc, o.id desc limit 1
  ) offer on true
`;
export const SHEET_QUERY = `${SHEET_BASE}
  where listing.status in ('open', 'qualifying') and listing.kind in ('demand', 'supply')`;

/** Listings closed in the last CLOSED_VISIBLE_DAYS days, newest first. The close date is the latest "Closed" entry in the story, else the last update. */
export const CLOSED_QUERY = `${SHEET_BASE}
  where listing.status = 'closed' and listing.kind in ('demand', 'supply')
    and listing.closed_reason <> all ($1::text[])
    and coalesce(closed.at, listing.updated_at) > now() - make_interval(days => $2::int)
  order by coalesce(closed.at, listing.updated_at) desc`;

export async function listClosed(): Promise<SheetRow[]> {
  return (await queryPg<ListingSheetInput>(CLOSED_QUERY, [HOUSEKEEPING_REASONS, CLOSED_VISIBLE_DAYS])).map(listingRow);
}

export async function listSheet(): Promise<SheetRow[]> {
  return sortSheet((await queryPg<ListingSheetInput>(SHEET_QUERY)).map(listingRow));
}
