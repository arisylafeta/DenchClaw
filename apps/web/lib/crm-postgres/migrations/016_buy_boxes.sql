-- Bulk Trades: buy-boxes. Demand rows gain a kind and a spec:
--   request   one-off: a quantity wanted by a date ("1,000 cells in 3 weeks").
--   standing  ongoing: a spec the buyer wants over time, with a basis:
--             estimated (our research), stated (the buyer said so), agreed (confirmed with price and volume).
-- volume is the total for a request and per month for a standing buy-box. spec holds the structured criteria
-- (lists and numbers from apps/web/lib/buy-box-spec.json). Trade buyers added from a buy-box keep its id, so
-- offers and wins count against it. Existing rows become stated standing buy-boxes.
-- Adds columns and widens checks only. Apply only after a current backup and explicit schema approval.
begin;

alter table crm_bulk_trade_demand
  add column if not exists kind text not null default 'standing' check (kind in ('request', 'standing')),
  -- Defaults to stated so older inserts (a standing row without a basis) stay valid; requests set it to null.
  add column if not exists basis text default 'stated' check (basis in ('estimated', 'stated', 'agreed')),
  add column if not exists needed_by date,
  add column if not exists volume numeric check (volume is null or volume > 0),
  add column if not exists volume_unit text check (volume_unit in ('packs', 'modules', 'cells', 'systems', 'kWh', 'MWh', 'tonnes')),
  add column if not exists max_price numeric check (max_price is null or max_price > 0),
  add column if not exists price_currency text check (price_currency in ('EUR', 'USD', 'GBP')),
  add column if not exists price_unit text check (price_unit in ('kWh', 'pack', 'cell')),
  add column if not exists spec jsonb not null default '{}'::jsonb check (jsonb_typeof(spec) = 'object'),
  add column if not exists source_kind text check (source_kind in ('research', 'survey', 'email', 'call', 'auction', 'manual', 'import')),
  add column if not exists source_id text,
  add column if not exists observed_on date;

update crm_bulk_trade_demand set observed_on = coalesce(confirmed_on, created_at::date) where observed_on is null;

alter table crm_bulk_trade_demand
  drop constraint if exists crm_bulk_trade_demand_basis_kind_check,
  add constraint crm_bulk_trade_demand_basis_kind_check check ((kind = 'standing') = (basis is not null)),
  drop constraint if exists crm_bulk_trade_demand_needed_by_kind_check,
  add constraint crm_bulk_trade_demand_needed_by_kind_check check (kind = 'request' or needed_by is null),
  drop constraint if exists crm_bulk_trade_demand_volume_pair_check,
  add constraint crm_bulk_trade_demand_volume_pair_check check ((volume is null) = (volume_unit is null)),
  drop constraint if exists crm_bulk_trade_demand_price_pair_check,
  add constraint crm_bulk_trade_demand_price_pair_check check ((max_price is null) = (price_currency is null) and (max_price is null) = (price_unit is null));

alter table crm_bulk_trade_demand drop constraint if exists crm_bulk_trade_demand_closed_reason_check;
alter table crm_bulk_trade_demand add constraint crm_bulk_trade_demand_closed_reason_check check (closed_reason is null
  or closed_reason in ('bought_from_us', 'bought_elsewhere', 'no_longer_needed', 'expired', 'other'));

-- A survey response, research note or email becomes one row, however often it is imported.
create unique index if not exists crm_bulk_trade_demand_source_idx
  on crm_bulk_trade_demand (source_kind, source_id) where source_id is not null;
create index if not exists crm_bulk_trade_demand_company_idx on crm_bulk_trade_demand (company_id) where company_id is not null;

alter table crm_bulk_trade_buyers add column if not exists demand_id text references crm_bulk_trade_demand(id) on delete set null;
create index if not exists crm_bulk_trade_buyers_demand_idx on crm_bulk_trade_buyers (demand_id) where demand_id is not null;
update crm_bulk_trade_buyers buyer set demand_id = m.demand_id
  from crm_bulk_trade_demand_matches m where m.buyer_id = buyer.id and buyer.demand_id is null;

commit;
