-- Bulk Trades: every marketplace auction is a bulk trade. The twice-daily auction sync links each
-- published auction to its trade (creating the trade when there is none) and keeps a copy of who
-- engaged with it: offers, buy-now requests and messages from the platform, signed-in page views,
-- and clicks on the auction invite email. People who engaged are added to the trade's buyers.
-- Adds columns and a table, and widens checks only. Apply only after a current backup and
-- explicit schema approval.
begin;

alter table crm_bulk_trade_lots
  add column if not exists auction_id text,
  add column if not exists auction_slug text,
  add column if not exists auction_status text,
  add column if not exists auction_closes_at timestamptz;
create unique index if not exists crm_bulk_trade_lots_auction_idx on crm_bulk_trade_lots (auction_id) where auction_id is not null;

-- One row per person per auction trade, refreshed by each sync. Matched to a CRM person by email
-- where possible, and to the buyer row it created or found.
create table if not exists crm_bulk_trade_auction_people (
  lot_id text not null references crm_bulk_trade_lots(id) on delete cascade,
  email text not null check (email = lower(email)),
  person_id text references crm_people(id) on delete set null,
  buyer_id text references crm_bulk_trade_buyers(id) on delete set null,
  invited_at timestamptz,
  clicked_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer not null default 0,
  offer_count integer not null default 0,
  -- The latest offer or buy-now request: {kind, price_per_kwh?, amount_per_unit, currency, quantity, incoterm?, at}
  last_offer jsonb,
  message_count integer not null default 0,
  last_activity_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (lot_id, email)
);
create index if not exists crm_bulk_trade_auction_people_buyer_idx on crm_bulk_trade_auction_people (buyer_id) where buyer_id is not null;

alter table crm_bulk_trade_check_runs drop constraint if exists crm_bulk_trade_check_runs_kind_check;
alter table crm_bulk_trade_check_runs add constraint crm_bulk_trade_check_runs_kind_check
  check (kind in ('check', 'history', 'auctions') and (kind <> 'history' or lot_id is not null));

alter table crm_bulk_trade_proposals drop constraint if exists crm_bulk_trade_proposals_source_kind_check;
alter table crm_bulk_trade_proposals add constraint crm_bulk_trade_proposals_source_kind_check
  check (source_kind in ('gmail', 'granola', 'auction'));

alter table crm_bulk_trade_proposals drop constraint if exists crm_bulk_trade_proposals_kind_check;
alter table crm_bulk_trade_proposals add constraint crm_bulk_trade_proposals_kind_check check (kind in (
  'field', 'buyer_update', 'next_step', 'new_buyer', 'file', 'needs_triage', 'link_contact', 'possible_trade',
  'trade_kind', 'bid', 'link_auction'
));

commit;
