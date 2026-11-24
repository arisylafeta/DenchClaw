-- Relay "Prepare listings and link": for a seller who has agreed to list, the desk proposes one draft listing per
-- battery group from what they stated; Alex approves on the card; scripts/rebattery/relay_listings.py creates the drafts
-- under ReBattery Sales (supplier API, status draft), issues the prepared-listing invitation and the link goes into the
-- reply. The link itself is a credential and is never stored here, only in the reply. Additive and idempotent.
begin;

create table if not exists relay_listing_proposal (
  id text primary key default gen_random_uuid()::text,
  item_id text not null references relay_item(id) on delete cascade,
  owner_id uuid not null references crm_users(id) on delete cascade,
  seller_email text not null,
  why text not null default '',
  -- [{group, payload}]: the desk's group (lib/relay-listings-core.ts ListingGroup) and the supplier API payload built from it.
  groups jsonb not null,
  -- proposed -> creating -> ready | failed; declined when Alex says not now (the reply gets the sell page instead).
  status text not null default 'proposed' check (status in ('proposed', 'creating', 'ready', 'failed', 'declined')),
  listing_ids text[] not null default '{}',
  invitation_ids text[] not null default '{}',
  pid integer,
  error text,
  approved_by text,
  approved_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live proposal per email: a new one replaces a proposed, failed or declined one; never one that is creating or ready.
create unique index if not exists relay_listing_proposal_live_uidx on relay_listing_proposal (item_id) where status in ('proposed', 'creating');
create index if not exists relay_listing_proposal_item_idx on relay_listing_proposal (item_id, created_at desc);

commit;
