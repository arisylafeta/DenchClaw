-- Buyer email pilot. Apply only after a current backup and explicit schema approval.
begin;
alter table crm_campaign_sends
  add column if not exists personalization jsonb not null default '{}'::jsonb,
  add column if not exists rendered_subject text,
  add column if not exists rendered_html text,
  add column if not exists rendered_text text;
commit;
