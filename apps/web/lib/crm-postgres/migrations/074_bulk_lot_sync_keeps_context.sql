-- While the old Bulk Trades page still exists, every lot write mirrors the lot into its listing. The mirror replaced the
-- listing's whole context with {listing_title}, wiping Trades Preview data (next action, packs, sources, fact line).
-- Merge instead: the lot's title still wins, every other context key is kept.
begin;

create or replace function bulk_lot_listing_sync() returns trigger language plpgsql as $function$
begin
  perform set_config('bulk.skip_status_activity', 'on', true);
  insert into crm_bulk_listings (id, kind, party, summary, quantity, status, closed_reason, observed_on, spec, context, created_at, updated_at)
  values (new.id, 'supply',
    coalesce(nullif(btrim(new.seller_name), ''), nullif(btrim(new.seller_ref), ''), 'Unknown seller'),
    coalesce(nullif(btrim(new.summary), ''), new.title),
    nullif(concat_ws(' ', new.observed_quantity::text, new.quantity_unit), ''),
    case when new.trade_stage in ('Done', 'Lost') then 'closed' else 'open' end,
    case new.trade_stage when 'Done' then 'sold' when 'Lost' then 'gone' end,
    new.created_at::date,
    jsonb_strip_nulls(to_jsonb(new) - 'id' - 'title' - 'summary' - 'created_at' - 'updated_at') || jsonb_build_object('is_trade', true),
    jsonb_build_object('listing_title', new.title), new.created_at, new.updated_at)
  on conflict (id) do update set
    party = excluded.party, summary = excluded.summary, quantity = excluded.quantity, status = excluded.status,
    closed_reason = excluded.closed_reason, spec = excluded.spec,
    context = coalesce(crm_bulk_listings.context, '{}'::jsonb) || excluded.context, updated_at = excluded.updated_at;
  perform set_config('bulk.skip_status_activity', 'off', true);
  return new;
end $function$;

commit;
