-- REB-344. Apply only after a current backup and explicit schema approval.
begin;
-- Preserve historical auction rows while allowing multiple campaigns per auction.
alter table campaigns drop constraint if exists campaigns_auction_slug_key;
alter table campaigns alter column auction_slug drop not null;
alter table campaigns alter column emails_opened drop not null;
alter table campaigns alter column emails_clicked drop not null;
alter table campaigns add column if not exists objective text;
alter table campaigns add column if not exists success_measure text;
alter table campaigns add column if not exists message_version text;
alter table campaigns add column if not exists stock_snapshot_ref text;
alter table campaigns add column if not exists sender_identity text;
alter table campaigns add column if not exists reply_owner text;
alter table campaigns add column if not exists reply_mailbox text;
alter table campaigns add column if not exists approved_manifest_sha256 text;
alter table campaigns add column if not exists approved_by text;
alter table campaigns add column if not exists approved_at timestamptz;
alter table campaigns add column if not exists reviewed_at timestamptz;
create index if not exists campaigns_auction_slug_idx on campaigns (auction_slug) where auction_slug is not null;

-- A frozen cohort row is also the durable send claim. No Gmail message is fabricated.
create table if not exists crm_campaign_sends (
  id text primary key,
  campaign_id text not null references campaigns(id) on delete restrict,
  person_id text not null references crm_people(id) on delete restrict,
  company_id text references crm_companies(id) on delete set null,
  listing_id text not null,
  auction_url text not null,
  recipient_email text not null,
  provider_message_id text unique,
  state text not null default 'frozen' check (state in ('frozen', 'sending', 'unknown', 'accepted', 'failed')),
  claimed_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  provider_opened_at timestamptz,
  provider_link_clicked_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (campaign_id, person_id),
  unique (campaign_id, recipient_email)
);
create index if not exists crm_campaign_sends_person_listing_idx
  on crm_campaign_sends (person_id, listing_id, accepted_at desc);
commit;
