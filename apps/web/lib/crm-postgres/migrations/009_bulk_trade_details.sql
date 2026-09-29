-- Bulk Trades v3, PR 2: the trade page. Buyers, structured bids, contacts, per-field data with
-- sources and buyer visibility, and uploaded files (stored in the database). Every buyer, bid, field and file change is
-- appended to crm_bulk_trade_events, as is each Gmail draft made from the trade page.
-- Adds tables only; existing rows are untouched.
-- Apply only after a current backup and explicit schema approval.
begin;

-- The marketplace listing a trade is sold through; campaign sends for it show on the buyer rows.
alter table crm_bulk_trade_lots add column if not exists listing_id text;

create table if not exists crm_bulk_trade_contacts (
  id text primary key,
  lot_id text not null references crm_bulk_trade_lots(id) on delete restrict,
  name text not null,
  company text,
  email text,
  phone text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists crm_bulk_trade_contacts_lot_idx on crm_bulk_trade_contacts (lot_id, sort_order);

create table if not exists crm_bulk_trade_buyers (
  id text primary key,
  lot_id text not null references crm_bulk_trade_lots(id) on delete restrict,
  name text not null,
  -- Optional CRM person, so campaign emails to them can be matched to this trade.
  person_id text references crm_people(id) on delete set null,
  contact text,
  wants text,
  status text not null default 'To contact' check (status in (
    'To contact', 'Teaser sent', 'No reply', 'NDA, specs sent', 'Bid in', 'LOI or deposit', 'Won',
    'Declined: price', 'Declined: specs', 'Declined: logistics', 'Declined: timing'
  )),
  last_touch_on date,
  last_touch_via text,
  chase_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_bulk_trade_buyers_lot_idx on crm_bulk_trade_buyers (lot_id, created_at);

-- Bids are never edited; a changed bid is a new row, so the history stays intact.
create table if not exists crm_bulk_trade_bids (
  id bigserial primary key,
  lot_id text not null references crm_bulk_trade_lots(id) on delete restrict,
  buyer_id text not null references crm_bulk_trade_buyers(id) on delete restrict,
  amount numeric not null check (amount > 0),
  unit text not null check (unit in ('kWh', 'pack', 'cell')),
  currency text not null check (currency in ('EUR', 'USD', 'GBP')),
  firmness text not null check (firmness in ('firm', 'indicative')),
  delivery_terms text,
  payment_terms text,
  expires_on date,
  actor_user_id uuid references crm_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists crm_bulk_trade_bids_buyer_idx on crm_bulk_trade_bids (buyer_id, created_at);

-- One row per template field that has been filled in. alternatives holds conflicting claims
-- ([{value, source_label, source_url, source_date}]) until Alex picks one.
create table if not exists crm_bulk_trade_fields (
  lot_id text not null references crm_bulk_trade_lots(id) on delete restrict,
  field_key text not null,
  value text,
  status text not null default 'unverified'
    check (status in ('confirmed', 'unverified', 'conflict', 'missing')),
  visibility text not null default 'never'
    check (visibility in ('teaser', 'after_nda', 'after_loi', 'never')),
  source_label text,
  source_url text,
  source_date date,
  alternatives jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (lot_id, field_key)
);

create table if not exists crm_bulk_trade_files (
  id text primary key,
  lot_id text not null references crm_bulk_trade_lots(id) on delete restrict,
  file_name text not null,
  file_type text not null,
  content_type text,
  byte_size bigint not null check (byte_size >= 0),
  -- The bytes live in the row, so the nightly database backup covers them. Never served publicly.
  content bytea not null,
  source_label text,
  source_date date,
  visibility text not null default 'never'
    check (visibility in ('teaser', 'after_nda', 'after_loi', 'never')),
  uploaded_by uuid references crm_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists crm_bulk_trade_files_lot_idx on crm_bulk_trade_files (lot_id, created_at);

-- One row per link in a Gmail draft made from a trade, unique to its recipient. The public
-- /t/<token> route counts the click and forwards to destination_url.
create table if not exists crm_bulk_trade_links (
  token text primary key,
  lot_id text not null references crm_bulk_trade_lots(id) on delete restrict,
  buyer_id text references crm_bulk_trade_buyers(id) on delete restrict,
  recipient text,
  destination_url text not null check (destination_url ~* '^https?://'),
  created_by uuid references crm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  click_count integer not null default 0,
  first_clicked_at timestamptz,
  last_clicked_at timestamptz
);
create index if not exists crm_bulk_trade_links_buyer_idx on crm_bulk_trade_links (buyer_id) where buyer_id is not null;

alter table crm_bulk_trade_events add column if not exists buyer_id text;
alter table crm_bulk_trade_events drop constraint if exists crm_bulk_trade_events_kind_check;
alter table crm_bulk_trade_events add constraint crm_bulk_trade_events_kind_check check (kind in (
  'trade_created', 'trade_updated',
  'buyer_added', 'buyer_updated', 'bid_added',
  'contact_added', 'contact_updated', 'contact_removed',
  'field_updated', 'file_added', 'file_updated',
  'email_drafted', 'link_clicked'
));

commit;
