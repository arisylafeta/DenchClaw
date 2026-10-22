-- The marketplace listing a bulk listing sells through (campaign emails and auction links name it). Copied from the
-- old Bulk Trades lots so campaign and person pages can read listing titles without crm_bulk_trade_lots. Additive.
begin;

alter table crm_bulk_listings add column if not exists marketplace_listing_id text;
create index if not exists crm_bulk_listings_marketplace_listing_idx on crm_bulk_listings (marketplace_listing_id)
  where marketplace_listing_id is not null;

do $$
begin
  if to_regclass('public.crm_bulk_trade_lots') is null then return; end if;
  update crm_bulk_listings l set marketplace_listing_id = lot.listing_id
  from crm_bulk_trade_lots lot
  where lot.id = l.id and lot.listing_id is not null and l.marketplace_listing_id is null;
end $$;

commit;
