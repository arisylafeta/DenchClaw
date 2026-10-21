-- Penny, the pricing agent: every market price seen, and every price card produced from them.
-- Both tables are append-only. A correction is a new row, never an edit.

create or replace function reject_price_row_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

create table if not exists crm_price_observations (
  id              bigint generated always as identity primary key,
  run_id          text not null,
  battery_key     text not null,                 -- normalised identity, e.g. hyundai-kona-64kwh-pack
  battery         text not null,                 -- as listed, e.g. Hyundai Kona 64 kWh pack
  segment         text not null check (segment in ('ev_pack', 'cell', 'bess')),
  kwh_usable      numeric check (kwh_usable > 0),  -- per unit
  kwh_gross       numeric check (kwh_gross > 0),
  chemistry       text,
  part_number     text,
  price           numeric not null check (price > 0),
  price_per       text not null default 'unit' check (price_per in ('unit', 'lot')),
  currency        text not null check (currency ~ '^[A-Z]{3}$'),
  vat             text not null check (vat in ('ex', 'inc', 'unknown')),
  vat_rate        numeric check (vat_rate >= 0 and vat_rate < 1),
  fx_to_gbp       numeric not null check (fx_to_gbp > 0),
  fx_date         date not null,
  price_type      text not null check (price_type in ('ask', 'sold', 'bid', 'quote')),
  qty             numeric not null default 1 check (qty > 0),
  condition       text,
  tested          boolean,
  country         text,
  seller          text,
  seller_type     text,
  title           text,
  source          text not null,                 -- ebay_gb, ebay_de, secondsol, dismantler site ...
  source_url      text,
  seen_at         date not null,
  included        boolean not null,
  exclude_reason  text,
  attributes      jsonb not null default '{}'::jsonb,
  logged_by       text not null default 'penny',
  created_at      timestamptz not null default now(),
  check (included or nullif(trim(exclude_reason), '') is not null)
);
create index if not exists crm_price_observations_key_seen_idx on crm_price_observations (battery_key, seen_at desc);
create index if not exists crm_price_observations_part_idx on crm_price_observations (part_number);
create index if not exists crm_price_observations_url_idx on crm_price_observations (source_url);

create table if not exists crm_price_cards (
  id                bigint generated always as identity primary key,
  run_id            text not null,
  battery_key       text not null,
  battery           text not null,
  segment           text not null check (segment in ('ev_pack', 'cell', 'bess')),
  market            text not null,               -- UK, DE or ALL
  basis             text not null,               -- e.g. usable kWh, ex VAT, buyer collects, used, untested
  kwh_usable        numeric not null check (kwh_usable > 0),
  quick_gbp_kwh     numeric,
  expected_gbp_kwh  numeric,
  patient_gbp_kwh   numeric,
  confidence        text not null check (confidence in ('High', 'Medium', 'Low', 'None')),
  n_prices          integer not null,
  observation_ids   bigint[] not null default '{}',  -- rows used in the asking range
  dropped_ids       bigint[] not null default '{}',  -- rows the script dropped (duplicate, outlier, stale)
  card_md           text not null,
  config            jsonb not null default '{}'::jsonb,
  target_type       text check (target_type in ('stock_item', 'bulk_trade', 'bulk_demand', 'company')),
  target_id         text,
  created_by        text not null default 'penny',
  created_at        timestamptz not null default now(),
  check ((target_type is null) = (target_id is null))
);
create index if not exists crm_price_cards_key_idx on crm_price_cards (battery_key, created_at desc);
create index if not exists crm_price_cards_target_idx on crm_price_cards (target_type, target_id, created_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'crm_price_observations_append_only') then
    create trigger crm_price_observations_append_only before update or delete on crm_price_observations
      for each row execute function reject_price_row_mutation();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'crm_price_cards_append_only') then
    create trigger crm_price_cards_append_only before update or delete on crm_price_cards
      for each row execute function reject_price_row_mutation();
  end if;
end;
$$;

create table if not exists crm_data_migrations (id text primary key, applied_at timestamptz not null default now());
insert into crm_data_migrations (id) values ('069_price_observations') on conflict do nothing;
