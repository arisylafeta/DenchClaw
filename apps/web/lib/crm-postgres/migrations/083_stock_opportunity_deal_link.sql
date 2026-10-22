-- 083: a stock item can be part of a Trades Preview deal. crm_stock_opportunities.bulk_listing_id points at the
-- supply listing that sells it as part of a bundle (e.g. Synetiq packs gathered into one marketplace bundle).
-- Count rule: the deal's size is its linked items; never add the deal and its items together.
-- The daily marketplace sync fills it from each bundle listing's sourceUnits (the supplier's stock tags).
begin;
alter table crm_stock_opportunities
  add column if not exists bulk_listing_id text references crm_bulk_listings(id) on delete set null;
create index if not exists crm_stock_opportunities_bulk_listing_idx on crm_stock_opportunities (bulk_listing_id)
  where bulk_listing_id is not null;
commit;
