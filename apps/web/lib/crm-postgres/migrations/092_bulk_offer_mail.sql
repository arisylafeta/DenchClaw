-- REB-572: one row per email ReBattery sent about a bulk-trade offer. An index only: the mail stays in mail_message, the
-- offer in crm_bulk_offers, the history in crm_bulk_listing_activity, the thread link in crm_bulk_thread_links.
-- Written hourly by scripts/rebattery/bulk_offer_mail_index.py, which also logs replies and flags overdue chases.
begin;

create table if not exists crm_bulk_offer_mail (
  message_id        text primary key references mail_message(id) on delete cascade,
  bulk_listing_id   text not null references crm_bulk_listings(id) on delete cascade,
  offer_id          text references crm_bulk_offers(id) on delete set null,
  person_id         text,
  thread_id         text,
  identity_key      text,
  subject           text,
  sent_at           timestamptz not null,
  attachments       jsonb not null default '[]'::jsonb,
  matched_by        text not null check (matched_by in ('thread_link', 'recipient')),
  replied_at        timestamptz,
  reply_message_id  text,
  reply_alerted_at  timestamptz,
  chase_alerted_at  timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists crm_bulk_offer_mail_offer_idx on crm_bulk_offer_mail (offer_id, sent_at desc);
create index if not exists crm_bulk_offer_mail_thread_idx on crm_bulk_offer_mail (thread_id) where thread_id is not null;
create index if not exists crm_bulk_offer_mail_listing_idx on crm_bulk_offer_mail (bulk_listing_id, sent_at desc);

commit;
