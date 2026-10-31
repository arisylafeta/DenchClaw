-- Relay: choices that stick, replies that are never missed, and an honest scan time. Additive.
-- relay_item.user_tab: the tab Alex moved an item to. The scan keeps it until a new message arrives after
--   user_tab_seen_id (the newest message Relay had seen when he moved it).
-- relay_item.summary_message_id: the message the headline and context were written for. Kept apart from
--   last_seen_message_id so a failed summary is retried without making a closed item look new.
-- relay_sender_rule: "always treat this sender as needs reply / no reply", by email or "@domain".
-- relay_scan_run: when the last scan finished and when it last pulled mail from Gmail.
begin;

alter table relay_item add column if not exists user_tab text check (user_tab in ('action', 'follow', 'other'));
alter table relay_item add column if not exists user_tab_seen_id text;
alter table relay_item add column if not exists summary_message_id text;
update relay_item set summary_message_id = last_seen_message_id where summary_message_id is null;

create table if not exists relay_sender_rule (
  id text primary key default gen_random_uuid()::text,
  owner_id uuid not null references crm_users(id) on delete cascade,
  match text not null check (match = lower(match) and match like '%@%'),
  tab text not null check (tab in ('action', 'other')),
  created_at timestamptz not null default now(),
  unique (owner_id, match)
);

create table if not exists relay_scan_run (
  owner_id uuid primary key references crm_users(id) on delete cascade,
  finished_at timestamptz not null,
  mail_synced_at timestamptz,
  errors jsonb not null default '[]'::jsonb
);

grant select, insert, update, delete on relay_sender_rule, relay_scan_run to crm_web_sql;
grant select, insert, update, delete on relay_sender_rule, relay_scan_run to crm_agent_sql;
commit;
