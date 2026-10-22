-- Trade-level fields that only the old Bulk Trades lots carried, moved onto bulk listings so Bulk Trades can be retired.
-- Kept as columns: value, waiting on, hold, auction link, clear/ship-by dates. The old stage columns are dropped by design
-- (listing status and each offer's stage cover them). Rarely used leftovers (fact line, transport class, TFS, owner) go into
-- context so nothing is lost. Additive and idempotent: the backfill only fills listing values that are still empty.
begin;

alter table crm_bulk_listings
  add column if not exists value text,
  add column if not exists waiting_on text check (waiting_on is null or waiting_on in ('us', 'them')),
  add column if not exists waiting_since date,
  add column if not exists hold_until date,
  add column if not exists hold_reason text,
  add column if not exists auction_id text,
  add column if not exists auction_slug text,
  add column if not exists auction_status text,
  add column if not exists auction_closes_at timestamptz,
  add column if not exists clear_by date,
  add column if not exists ship_by date;

do $$
begin
  if to_regclass('public.crm_bulk_trade_lots') is null then return; end if;
  update crm_bulk_listings l set
    value = coalesce(l.value, lot.value),
    waiting_on = coalesce(l.waiting_on, lot.waiting_on),
    waiting_since = coalesce(l.waiting_since, lot.waiting_since),
    hold_until = coalesce(l.hold_until, lot.hold_until),
    hold_reason = coalesce(l.hold_reason, lot.hold_reason),
    auction_id = coalesce(l.auction_id, lot.auction_id),
    auction_slug = coalesce(l.auction_slug, lot.auction_slug),
    auction_status = coalesce(l.auction_status, lot.auction_status),
    auction_closes_at = coalesce(l.auction_closes_at, lot.auction_closes_at),
    clear_by = coalesce(l.clear_by, lot.clear_by),
    ship_by = coalesce(l.ship_by, lot.ship_by),
    context = jsonb_strip_nulls(jsonb_build_object(
      'fact_line', lot.fact_line, 'transport_class', lot.transport_class, 'tfs_needed', lot.tfs_needed,
      'owner_user_id', lot.owner_user_id::text, 'hold_from_stage', lot.hold_from_stage)) || coalesce(l.context, '{}'::jsonb)
  from crm_bulk_trade_lots lot
  where lot.id = l.id;
end $$;

commit;
