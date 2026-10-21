-- Labels: which email thread or WhatsApp chat is about which bulk listing.
--   offer_id null  -> the conversation with the listing's own party (the buyer on a demand, the seller on a supply)
--   offer_id set   -> the conversation with that offer's counterparty (a thread in the Offers tab)
-- One row per (channel, thread, listing). A thread is linked only when its content is about the listing's product or ask;
-- a person or company match alone is not enough. 'proposed' links are not shown; 'confirmed' ones are.
-- Additive: no existing table changes. Apply after a current backup (nightly dump) and schema approval.
begin;
create table if not exists crm_bulk_thread_links (
  id text primary key default 'btl_' || gen_random_uuid()::text,
  channel text not null check (channel in ('mail', 'whatsapp')),
  thread_id text not null check (length(btrim(thread_id)) > 0),   -- mail_message.thread_id or whatsapp_thread.id
  bulk_listing_id text not null references crm_bulk_listings(id) on delete cascade,
  offer_id text references crm_bulk_offers(id) on delete set null,
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  state text not null default 'proposed' check (state in ('proposed', 'confirmed', 'rejected')),
  reason text,
  quote text,
  labelled_by text not null,
  labelled_at timestamptz not null default now(),
  confirmed_by text,
  confirmed_at timestamptz,
  check ((state = 'confirmed') = (confirmed_by is not null)),
  unique (channel, thread_id, bulk_listing_id)
);
create index if not exists crm_bulk_thread_links_listing_idx on crm_bulk_thread_links (bulk_listing_id, state);
create index if not exists crm_bulk_thread_links_offer_idx on crm_bulk_thread_links (offer_id) where offer_id is not null;
create index if not exists crm_bulk_thread_links_thread_idx on crm_bulk_thread_links (channel, thread_id);
grant select on crm_bulk_thread_links to crm_web_sql;
grant select, insert, update, delete on crm_bulk_thread_links to crm_agent_sql;
commit;
