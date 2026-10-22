-- While Bulk Trades lots still exist, keep the listing columns that Trades Preview, campaign and person pages read
-- (marketplace listing id, auction link) in step with lot writes such as the auction sync and link_auction.
begin;

create or replace function bulk_lot_listing_sync() returns trigger language plpgsql as $function$
begin
  perform set_config('bulk.skip_status_activity', 'on', true);
  insert into crm_bulk_listings (id, kind, party, summary, quantity, status, closed_reason, observed_on, spec, context, created_at, updated_at,
    marketplace_listing_id, auction_id, auction_slug, auction_status, auction_closes_at)
  values (new.id, 'supply',
    coalesce(nullif(btrim(new.seller_name), ''), nullif(btrim(new.seller_ref), ''), 'Unknown seller'),
    coalesce(nullif(btrim(new.summary), ''), new.title),
    nullif(concat_ws(' ', new.observed_quantity::text, new.quantity_unit), ''),
    case when new.trade_stage in ('Done', 'Lost') then 'closed' else 'open' end,
    case new.trade_stage when 'Done' then 'sold' when 'Lost' then 'gone' end,
    new.created_at::date,
    jsonb_strip_nulls(to_jsonb(new) - 'id' - 'title' - 'summary' - 'created_at' - 'updated_at') || jsonb_build_object('is_trade', true),
    jsonb_build_object('listing_title', new.title), new.created_at, new.updated_at,
    new.listing_id, new.auction_id, new.auction_slug, new.auction_status, new.auction_closes_at)
  on conflict (id) do update set
    party = excluded.party, summary = excluded.summary, quantity = excluded.quantity, status = excluded.status,
    closed_reason = excluded.closed_reason, spec = excluded.spec,
    context = coalesce(crm_bulk_listings.context, '{}'::jsonb) || excluded.context, updated_at = excluded.updated_at,
    marketplace_listing_id = coalesce(new.listing_id, crm_bulk_listings.marketplace_listing_id),
    auction_id = coalesce(new.auction_id, crm_bulk_listings.auction_id),
    auction_slug = coalesce(new.auction_slug, crm_bulk_listings.auction_slug),
    auction_status = coalesce(new.auction_status, crm_bulk_listings.auction_status),
    auction_closes_at = coalesce(new.auction_closes_at, crm_bulk_listings.auction_closes_at);
  perform set_config('bulk.skip_status_activity', 'off', true);
  return new;
end $function$;

commit;
