-- Business context is not part of the matching buy-box spec.
alter table crm_bulk_trade_demand
  add column context jsonb not null default '{}'::jsonb
  check (jsonb_typeof(context) = 'object');
