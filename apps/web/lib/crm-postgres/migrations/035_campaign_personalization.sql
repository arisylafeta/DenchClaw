-- Buyer email pilot. Apply only after a current backup and explicit schema approval.
-- After the mail cutover, 050 already preserved these fields in mail_message.
-- The removed legacy ledger must not be recreated on an upgraded database.
begin;
alter table if exists crm_campaign_sends
  add column if not exists personalization jsonb not null default '{}'::jsonb,
  add column if not exists rendered_subject text,
  add column if not exists rendered_html text,
  add column if not exists rendered_text text;
commit;
