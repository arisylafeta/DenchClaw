-- Each user's Matcha chat for a bulk listing: the "Matcha" tab on a listing reopens the same conversation.
-- Additive only. The conversation itself lives in Hermes; this row just remembers its key.
begin;
create table if not exists crm_bulk_listing_chats (
  listing_id text not null references crm_bulk_listings(id) on delete cascade,
  user_id uuid not null references crm_users(id) on delete cascade,
  conversation_key text not null,
  created_at timestamptz not null default now(),
  primary key (listing_id, user_id)
);
grant select, insert, update, delete on crm_bulk_listing_chats to crm_web_sql;
grant select, insert, update, delete on crm_bulk_listing_chats to crm_agent_sql;
commit;
