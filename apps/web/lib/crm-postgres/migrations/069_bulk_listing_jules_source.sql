-- Allow listings captured by Jules without changing existing source kinds.
begin;
set local lock_timeout = '5s';
alter table public.crm_bulk_listings
  drop constraint if exists crm_bulk_listings_source_kind_check;
alter table public.crm_bulk_listings
  add constraint crm_bulk_listings_source_kind_check
  check (source_kind in ('research','survey','email','call','auction','manual','import','whatsapp','jules'));
commit;
