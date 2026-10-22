-- Stock opportunities: free-form battery stock that suppliers have offered or that we found, one row per item or lot.
-- Replaces the dropped crm_stock_items (migration 070). Every row belongs to a CRM person (the supplier contact) and
-- their company. status says whether the item is already on the ReBattery marketplace ('listed', with the marketplace
-- listing id) or not yet ('opportunity'), so stock is never counted twice. Anything item-specific goes in details.
begin;

create table if not exists crm_stock_opportunities (
  id text primary key default 'sto_' || gen_random_uuid()::text,
  person_id text not null references crm_people(id) on delete restrict,
  company_id text references crm_companies(id) on delete set null,
  status text not null default 'opportunity' check (status in ('opportunity', 'listed')),
  title text not null check (length(btrim(title)) > 0),
  description text,
  quantity numeric,
  quantity_unit text,
  price numeric,
  currency text,
  price_unit text,
  location text,
  supplier_ref text,
  marketplace_listing_id text,
  marketplace_status text,
  source text,
  source_url text,
  observed_on date,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'listed' or marketplace_listing_id is not null)
);

create unique index if not exists crm_stock_opportunities_supplier_ref_uidx
  on crm_stock_opportunities (company_id, supplier_ref) where supplier_ref is not null;
create unique index if not exists crm_stock_opportunities_marketplace_uidx
  on crm_stock_opportunities (marketplace_listing_id) where marketplace_listing_id is not null;
create index if not exists crm_stock_opportunities_person_idx on crm_stock_opportunities (person_id);
create index if not exists crm_stock_opportunities_company_idx on crm_stock_opportunities (company_id);
create index if not exists crm_stock_opportunities_status_idx on crm_stock_opportunities (status);

comment on table crm_stock_opportunities is
  'Supplier battery stock, one row per item or lot. status listed = on the ReBattery marketplace (marketplace_listing_id set); opportunity = not listed. person_id is the supplier contact. Free-form extras in details.';

commit;
