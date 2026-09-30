-- Bulk Trades: demand. One row per "buyer wants X" (bulk only, 2+ units), in the buyer's words,
-- matched to live supply trades by the inbox check: each trade keeps a fingerprint of its facts
-- and the open demand, and is re-matched only when that changes. New demand found in email and
-- calls waits for Alex as a "possible demand" card. Adds tables and widens a check only.
-- Apply only after a current backup and explicit schema approval.
begin;

create table if not exists crm_bulk_trade_demand (
  id text primary key,
  buyer text not null check (length(trim(buyer)) > 0),
  company_id text references crm_companies(id) on delete set null,
  person_id text references crm_people(id) on delete set null,
  contact text,
  email text check (email is null or email = lower(email)),
  wants text not null check (length(trim(wants)) > 0),
  quantity text,
  location text,
  note text,
  source_label text,
  source_url text,
  source_quote text,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_reason text check (closed_reason is null or closed_reason in ('bought_from_us', 'bought_elsewhere', 'no_longer_needed', 'other')),
  confirmed_on date,
  created_by uuid references crm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'closed') = (closed_reason is not null))
);
create index if not exists crm_bulk_trade_demand_open_idx on crm_bulk_trade_demand (confirmed_on desc) where status = 'open';
create index if not exists crm_bulk_trade_demand_email_idx on crm_bulk_trade_demand (email) where email is not null;

-- The model's verdict per open demand row and live trade. hidden = Alex said "Not a fit", which
-- survives re-matching.
create table if not exists crm_bulk_trade_demand_matches (
  demand_id text not null references crm_bulk_trade_demand(id) on delete cascade,
  lot_id text not null references crm_bulk_trade_lots(id) on delete cascade,
  strength text not null check (strength in ('strong', 'partial')),
  reason text not null,
  hidden boolean not null default false,
  buyer_id text references crm_bulk_trade_buyers(id) on delete set null,
  matched_at timestamptz not null default now(),
  primary key (demand_id, lot_id)
);
create index if not exists crm_bulk_trade_demand_matches_lot_idx on crm_bulk_trade_demand_matches (lot_id);

alter table crm_bulk_trade_lots add column if not exists demand_fingerprint text;

alter table crm_bulk_trade_proposals drop constraint if exists crm_bulk_trade_proposals_kind_check;
alter table crm_bulk_trade_proposals add constraint crm_bulk_trade_proposals_kind_check check (kind in (
  'field', 'buyer_update', 'next_step', 'new_buyer', 'file', 'needs_triage', 'link_contact', 'possible_trade',
  'trade_kind', 'bid', 'link_auction', 'possible_demand'
));

commit;
