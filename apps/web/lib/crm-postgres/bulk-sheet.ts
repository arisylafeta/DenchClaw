import { likelihoodScoreSql } from "../bulk-likelihood";
import { queryPg } from "../postgres";
import { listingRow, sortSheet, type ListingSheetInput, type SheetRow } from "../bulk-sheet";

/** Closes that are housekeeping, not the end of a deal: they never show as Closed. */
const HOUSEKEEPING = ["duplicate", "moved_to_profile", "moved_to_lot", "research_profile", "not_demand", "offer_reply", "supply", "recycling", "not_a_fit"];

/** One row per live listing (open or qualifying; a qualifying demand shows as stage New), including lots already mirrored as
 * supply listings. Listings closed in the last 30 days stay too, so Closed, Sold, Delivered and Lost are not empty: every
 * closed demand except housekeeping closes, and supply that sold. */
export const SHEET_QUERY = `
  select listing.id, listing.kind, listing.party, listing.company_id, listing.summary,
    listing.spec, listing.context, listing.status, listing.updated_at::text,
    to_char(listing.observed_on, 'YYYY-MM-DD') as observed_on,
    listing.next_action, to_char(listing.next_due, 'YYYY-MM-DD') as next_due,
    listing.waiting_on, to_char(listing.waiting_since, 'YYYY-MM-DD') as waiting_since,
    ${likelihoodScoreSql(`case when listing.kind = 'demand' then bulk_demand_score(
      (listing.spec->>'fee_eur')::numeric, listing.spec->>'price_basis', listing.spec->>'reputation',
      greatest(listing.observed_on, (listing.spec->>'confirmed_on')::date))
      else bulk_supply_score((listing.spec->>'value_eur')::numeric) end`, "listing.context")} as score,
    (select count(*)::int from crm_bulk_listing_activity a
      where a.bulk_listing_id = listing.id and a.kind <> 'status') as activity_count,
    latest.kind as latest_kind, latest.title as latest_title, latest.occurred_at::text as latest_at,
    offer.stage as furthest_stage,
    case when offer.stage not in ('declined', 'lost') then offer.paired_listing_id end as paired_listing_id,
    bulk_listing_stage(listing.id) as stage, bulk_listing_deal_stage(listing.id) as deal_stage,
    listing.created_at::text as created_at, stage_event.occurred_at::text as stage_at, stage_event.note as stage_note,
    talk.last_in_at::text as last_in_at, talk.last_out_at::text as last_out_at, talk.waiting_from::text as waiting_from,
    -- Marked Qualified without a price or a date: the card shows "No price" / "No date" (migration 112's checklist).
    (listing.qualified_at is not null and not bulk_listing_check_answered(listing.id, 'price')) as no_price,
    (listing.qualified_at is not null and not bulk_listing_check_answered(listing.id, 'when')) as no_date
  from crm_bulk_listings listing
  left join lateral (
    select e.occurred_at, e.note from crm_bulk_stage_events e
    where e.subject_kind = 'listing' and e.subject_id = listing.id order by e.occurred_at desc, e.id desc limit 1
  ) stage_event on true
  -- The real conversation: every message on the deal's email threads (its thread links, its offers' links, and the Relay
  -- emails linked to it) and its linked WhatsApp chats. Who wrote last, and when our unanswered run of messages began.
  left join lateral (
    with talk as (
      select m.direction as dir, coalesce(m.sent_at, m.accepted_at, m.created_at) as at from mail_message m
      where m.state in ('received', 'accepted') and m.thread_id in (
        select t.thread_id from crm_bulk_thread_links t where t.bulk_listing_id = listing.id and t.channel = 'mail' and t.state <> 'rejected'
        union select r.mail_thread_id from relay_item r where r.bulk_listing_id = listing.id and r.mail_thread_id is not null)
      union all
      select w.direction, w.occurred_at from whatsapp_message w
      where w.deleted_at is null and w.occurred_at is not null and w.direction is not null and w.thread_id in (
        select t.thread_id from crm_bulk_thread_links t where t.bulk_listing_id = listing.id and t.channel = 'whatsapp' and t.state <> 'rejected')
    ), last_in as (select max(at) as at from talk where dir = 'inbound')
    select (select at from last_in) as last_in_at, (select max(at) from talk where dir = 'outbound') as last_out_at,
      (select min(at) from talk where dir = 'outbound' and at > coalesce((select at from last_in), '-infinity'::timestamptz)) as waiting_from
  ) talk on true
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
  ) offer on true
  where listing.kind in ('demand', 'supply') and (listing.status in ('open', 'qualifying')
    or (listing.status = 'closed' and listing.updated_at >= now() - interval '30 days'
      and listing.closed_reason not in (${HOUSEKEEPING.map((reason) => `'${reason}'`).join(", ")})
      and (listing.kind = 'demand' or bulk_listing_stage(listing.id) = 'Sold')))`;

export async function listSheet(): Promise<SheetRow[]> {
  return sortSheet((await queryPg<ListingSheetInput>(SHEET_QUERY)).map(listingRow));
}
