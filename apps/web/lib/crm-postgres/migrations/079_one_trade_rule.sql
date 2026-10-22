-- 079: one meaning of "trade". A trade is a supply listing with a buyer offer at loi or won (lib/bulk-listing.ts TRADE_STAGES).
-- The old spec.is_trade marker only meant "came from a Bulk Trades lot"; it hid 18 open deals from crm_bulk_supply
-- and labelled 24 listings as trades. Keep the provenance in context.from_bulk_trade_lot and drop the marker.
-- The lot -> listing sync (only reachable for repairs and tests, lots are frozen by 077) marks context instead.
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
    jsonb_strip_nulls(to_jsonb(new) - 'id' - 'title' - 'summary' - 'created_at' - 'updated_at'),
    jsonb_build_object('listing_title', new.title, 'from_bulk_trade_lot', true), new.created_at, new.updated_at,
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
drop trigger if exists bulk_lot_listing_sync on crm_bulk_trade_lots;
create trigger bulk_lot_listing_sync after insert or update on crm_bulk_trade_lots
  for each row execute function bulk_lot_listing_sync();
update crm_bulk_listings set context = context || '{"from_bulk_trade_lot": true}'::jsonb, spec = spec - 'is_trade'
 where spec ? 'is_trade';
create or replace view crm_bulk_supply as
SELECT id,
    party AS seller,
    company_id,
    person_id,
    contact,
    email,
    summary AS offers,
    spec ->> 'trade_kind'::text AS trade_kind,
    quantity,
    location,
    (spec ->> 'est_tonnes'::text)::numeric AS est_tonnes,
    NULL::numeric AS est_value_usd,
    spec ->> 'size_note'::text AS size_note,
    source_kind,
    source_id,
    source_thread,
    source_label,
    source_url,
    source_quote,
    observed_on,
    status,
    closed_reason,
    match_hash,
    created_at,
    updated_at
   FROM crm_bulk_listings l
  WHERE kind = 'supply'::text;
create or replace view crm_bulk_listing_supply_feed as
SELECT id,
        CASE
            WHEN COALESCE(auction_id, spec ->> 'auction_id'::text) IS NOT NULL THEN 'auction'::text
            WHEN (EXISTS ( SELECT 1 FROM crm_bulk_offers o WHERE o.bulk_listing_id = l.id AND o.stage = ANY (ARRAY['loi'::text, 'won'::text]))) THEN 'trade'::text
            ELSE 'supply'::text
        END AS kind,
    COALESCE(NULLIF(spec ->> 'listing_title'::text, ''::text), NULLIF(context ->> 'listing_title'::text, ''::text), summary) AS title,
    party AS seller,
    COALESCE(( SELECT NULLIF(f.value, ''::text) AS "nullif"
           FROM crm_bulk_listing_fields f
          WHERE f.bulk_listing_id = l.id AND f.field_key = 'quantity'::text), NULLIF(quantity, ''::text)) AS size,
    COALESCE(( SELECT NULLIF(f.value, ''::text) AS "nullif"
           FROM crm_bulk_listing_fields f
          WHERE f.bulk_listing_id = l.id AND f.field_key = 'location'::text), NULLIF(location, ''::text)) AS location,
    COALESCE(( SELECT max(a.occurred_at) AS max
           FROM crm_bulk_listing_activity a
          WHERE a.bulk_listing_id = l.id), updated_at)::text AS seen,
    status,
    '/?path=~trades-preview&listing='::text || id AS href,
    array_remove(ARRAY[party], NULL::text) AS suppliers,
    NULL::boolean AS verified,
    NULL::integer AS count
   FROM crm_bulk_listings l
  WHERE kind = 'supply'::text AND status = 'open'::text AND COALESCE(spec ->> 'origin'::text, 'supply'::text) <> 'demand'::text AND COALESCE(spec ->> 'trade_stage'::text, ''::text) <> 'On hold'::text AND (hold_until IS NULL OR hold_until < CURRENT_DATE) AND (COALESCE(auction_id, spec ->> 'auction_id'::text) IS NULL OR COALESCE(auction_status, spec ->> 'auction_status'::text) = 'published'::text AND COALESCE(auction_closes_at, (spec ->> 'auction_closes_at'::text)::timestamp with time zone, 'infinity'::timestamp with time zone) > now());
CREATE OR REPLACE FUNCTION public.bulk_supply_view_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare moved jsonb; begin
  if TG_OP = 'DELETE' then delete from crm_bulk_listings where id = OLD.id and kind = 'supply'; return OLD; end if;
  moved := jsonb_strip_nulls(jsonb_build_object('trade_kind', NEW.trade_kind, 'est_tonnes', NEW.est_tonnes, 'size_note', NEW.size_note));
  if TG_OP = 'INSERT' then
    insert into crm_bulk_listings (id, kind, party, company_id, person_id, contact, email, summary, quantity, location, status, closed_reason,
      observed_on, source_kind, source_id, source_thread, source_label, source_url, source_quote, match_hash, spec, created_at, updated_at)
    values (NEW.id, 'supply', NEW.seller, NEW.company_id, NEW.person_id, NEW.contact, NEW.email, NEW.offers, NEW.quantity, NEW.location,
      coalesce(NEW.status, 'open'), NEW.closed_reason, NEW.observed_on, NEW.source_kind, NEW.source_id, NEW.source_thread, NEW.source_label,
      NEW.source_url, NEW.source_quote, NEW.match_hash, moved, coalesce(NEW.created_at, now()), coalesce(NEW.updated_at, now()))
    on conflict (id) do nothing;  -- lets 'insert ... on conflict do nothing' through the view behave as before
    return NEW;
  end if;
  update crm_bulk_listings set id = NEW.id, party = NEW.seller, company_id = NEW.company_id, person_id = NEW.person_id, contact = NEW.contact,
    email = NEW.email, summary = NEW.offers, quantity = NEW.quantity, location = NEW.location, status = NEW.status,
    closed_reason = NEW.closed_reason, observed_on = NEW.observed_on, source_kind = NEW.source_kind, source_id = NEW.source_id,
    source_thread = NEW.source_thread, source_label = NEW.source_label, source_url = NEW.source_url, source_quote = NEW.source_quote,
    match_hash = NEW.match_hash, spec = (spec - 'trade_kind' - 'est_tonnes' - 'size_note') || moved,
    created_at = NEW.created_at, updated_at = NEW.updated_at
  where id = OLD.id and kind = 'supply';
  return NEW;
end $function$;
commit;
