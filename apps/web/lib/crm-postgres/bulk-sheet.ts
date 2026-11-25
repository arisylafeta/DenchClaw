import { likelihoodScoreSql } from "../bulk-likelihood";
import { queryPg } from "../postgres";
import { listingRow, sortSheet, type ListingSheetInput, type SheetRow } from "../bulk-sheet";
import { LOSS_REASONS } from "../bulk-abandon";

/** One sheet row per listing, plus any extra columns; SHEET_QUERY and ABANDONED_QUERY add which listings. */
const sheetSelect = (extra = "") => `
  select listing.id, listing.kind, listing.party, listing.company_id, listing.summary,
    listing.spec, listing.context, listing.status, listing.updated_at::text,
    to_char(listing.observed_on, 'YYYY-MM-DD') as observed_on,
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
    bulk_listing_stage(listing.id) as stage${extra}
  from crm_bulk_listings listing
  left join lateral (
    select a.kind, a.title, a.occurred_at from crm_bulk_listing_activity a
    where a.bulk_listing_id = listing.id and a.kind <> 'status'
    order by a.occurred_at desc, a.id desc limit 1
  ) latest on true
  left join lateral (
    select o.stage, case when o.bulk_listing_id = listing.id then o.counterpart_id else o.bulk_listing_id end as paired_listing_id
    from crm_bulk_offers o
    where (o.bulk_listing_id = listing.id or o.counterpart_id = listing.id) and o.stage is not null
    order by case o.stage when 'complete' then 8 when 'paid' then 7 when 'invoiced' then 6 when 'signed' then 5
      when 'contract_out' then 4 when 'negotiating' then 3 when 'offered' then 2 when 'candidate' then 1 else 0 end desc,
      o.updated_at desc, o.id desc limit 1
  ) offer on true`;

/** One row per live listing (open or qualifying; a qualifying demand shows as stage New), including lots already mirrored as supply listings. */
export const SHEET_QUERY = `${sheetSelect()}
  where listing.status in ('open', 'qualifying') and listing.kind in ('demand', 'supply')`;

/** When a closed listing was closed: the board's abandon time, else its latest status change, else its last update. */
const CLOSED_AT = `coalesce(case when listing.context->'abandoned'->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}'
    then (listing.context->'abandoned'->>'at')::timestamptz end,
  (select max(a.occurred_at) from crm_bulk_listing_activity a where a.bulk_listing_id = listing.id and a.kind = 'status'),
  listing.updated_at)`;

/** The Deals board's Abandoned column: listings dragged there (context.abandoned), and listings closed for a loss reason
 * after an offer went out. Requests that closed without ever being offered, and housekeeping closes (duplicate, moved),
 * stay out. Newest first. */
export const ABANDONED_QUERY = `${sheetSelect(`, listing.closed_reason, ${CLOSED_AT}::text as closed_at`)}
  where listing.status = 'closed' and listing.kind in ('demand', 'supply')
    and (listing.context ? 'abandoned'
      or (listing.closed_reason = any($1::text[]) and exists (
        select 1 from crm_bulk_offers o where (o.bulk_listing_id = listing.id or o.counterpart_id = listing.id)
          and o.stage in ('offered', 'negotiating', 'contract_out', 'signed', 'invoiced', 'declined', 'lost'))))
  order by ${CLOSED_AT} desc, listing.id
  limit $2`;

export async function listSheet(): Promise<SheetRow[]> {
  return sortSheet((await queryPg<ListingSheetInput>(SHEET_QUERY)).map(listingRow));
}

/** The newest abandoned listings, for the Deals board's Abandoned column. */
export async function listAbandoned(limit = 100): Promise<SheetRow[]> {
  const rows = await queryPg<ListingSheetInput & { closed_reason: string | null; closed_at: string | null }>(ABANDONED_QUERY, [[...LOSS_REASONS], limit]);
  return rows.map((input) => ({ ...listingRow(input), abandoned: { reason: input.closed_reason, at: input.closed_at } }));
}
