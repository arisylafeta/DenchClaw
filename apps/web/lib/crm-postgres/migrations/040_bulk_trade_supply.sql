-- Bulk Trades: a Supply list. Reuse batches the inbox check finds that are below the card bar (under about 8 tonnes
-- and $10k, or of unknown size) are kept here instead of becoming a "possible trade" card, and matched against open
-- demand so a small batch can still find a buyer. Adds two tables, one column and widens two checks.
-- Apply only after a current backup and explicit schema approval.
begin;

create table if not exists crm_bulk_trade_supply (
  id text primary key,
  seller text not null check (length(trim(seller)) > 0),
  company_id text references crm_companies(id) on delete set null,
  person_id text references crm_people(id) on delete set null,
  contact text,
  email text check (email is null or email = lower(email)),
  offers text not null check (length(trim(offers)) > 0),
  trade_kind text check (trade_kind in ('packs', 'cells', 'systems')),
  quantity text,
  location text,
  est_tonnes numeric check (est_tonnes is null or est_tonnes >= 0),
  est_value_usd numeric check (est_value_usd is null or est_value_usd >= 0),
  size_note text,
  source_kind text check (source_kind in ('email', 'call', 'manual')),
  source_id text,
  source_thread text,
  source_label text,
  source_url text,
  source_quote text,
  observed_on date,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_reason text check (closed_reason is null or closed_reason in ('sold', 'became_trade', 'gone', 'not_a_fit', 'other')),
  match_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'closed') = (closed_reason is not null))
);

create unique index if not exists crm_bulk_trade_supply_source_idx on crm_bulk_trade_supply (source_kind, source_id)
  where source_id is not null;
create index if not exists crm_bulk_trade_supply_thread_idx on crm_bulk_trade_supply (source_thread)
  where source_thread is not null and status = 'open';
create index if not exists crm_bulk_trade_supply_open_idx on crm_bulk_trade_supply (observed_on desc) where status = 'open';

comment on table crm_bulk_trade_supply is
  'Reuse batches offered to ReBattery that are below the card bar (8 t or $10k) or of unknown size.';
comment on column crm_bulk_trade_supply.match_hash is
  'Hash of the matching content this batch was last judged on against open demand.';

create table if not exists crm_bulk_trade_supply_matches (
  supply_id text not null references crm_bulk_trade_supply(id) on delete cascade,
  demand_id text not null references crm_bulk_trade_demand(id) on delete cascade,
  strength text not null check (strength in ('strong', 'partial')),
  reason text not null,
  hidden boolean not null default false,
  matched_at timestamptz not null default now(),
  primary key (supply_id, demand_id)
);
create index if not exists crm_bulk_trade_supply_matches_demand_idx on crm_bulk_trade_supply_matches (demand_id);

alter table crm_bulk_trade_demand add column if not exists supply_match_hash text;
comment on column crm_bulk_trade_demand.supply_match_hash is
  'Hash of the matching content this row was last judged on against the open Supply list.';

alter table crm_bulk_trade_check_runs drop constraint if exists crm_bulk_trade_check_runs_kind_check;
alter table crm_bulk_trade_check_runs add constraint crm_bulk_trade_check_runs_kind_check
  check (kind in ('check', 'history', 'auctions', 'match', 'supply_match') and (kind <> 'history' or lot_id is not null));

alter table crm_bulk_trade_proposals drop constraint if exists crm_bulk_trade_proposals_kind_check;
alter table crm_bulk_trade_proposals add constraint crm_bulk_trade_proposals_kind_check
  check (kind in ('field', 'buyer_update', 'next_step', 'new_buyer', 'file', 'needs_triage', 'link_contact',
                  'possible_trade', 'trade_kind', 'bid', 'link_auction', 'possible_demand', 'possible_supply'));

commit;
