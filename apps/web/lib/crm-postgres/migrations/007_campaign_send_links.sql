-- A link belongs to one frozen campaign send. Exact URLs match Postmark click events.
begin;
create table if not exists crm_campaign_send_links (
  id text primary key,
  send_id text not null references crm_campaign_sends(id) on delete restrict,
  cta_key text not null,
  destination_url text not null,
  listing_id text,
  first_clicked_at timestamptz,
  unique (send_id, cta_key),
  unique (send_id, destination_url)
);
create index if not exists crm_campaign_send_links_listing_idx
  on crm_campaign_send_links (listing_id, send_id) where listing_id is not null;
commit;
