-- Relay: an email reply workbench. Additive only.
-- relay_item: one Gmail thread that needs Alex (or Ari): a reply (action), a chase (follow) or nothing (other).
-- relay_draft: the emails Relay drafted for an item (primary reply plus follow-ons), each a mail_message draft.
-- relay_todo: to-dos suggested from an item's emails; accepted ones become work_tasks.
-- relay_rule: per-user writing rules applied to every Relay draft.
-- relay_chat: the agent conversation pinned to an item, like crm_bulk_listing_chats.
begin;

create table if not exists relay_item (
  id text primary key default gen_random_uuid()::text,
  owner_id uuid not null references crm_users(id) on delete cascade,
  gmail_thread_id text not null,
  mail_thread_id text references mail_thread(id) on delete set null,
  tab text not null check (tab in ('action', 'follow', 'other')),
  status text not null default 'open' check (status in ('open', 'review', 'done')),
  priority text not null default 'medium' check (priority in ('urgent', 'overdue', 'high', 'medium', 'low')),
  counterpart_name text,
  counterpart_email text,
  company text,
  contact_type text,
  headline text not null default '',
  context text not null default '',
  last_message jsonb,
  earlier jsonb not null default '[]'::jsonb,
  bulk_listing_id text references crm_bulk_listings(id) on delete set null,
  deal_label text,
  waiting_since timestamptz,
  last_seen_message_id text,
  note text not null default '',
  snooze_until timestamptz,
  done_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, gmail_thread_id)
);
create index if not exists relay_item_owner_tab_idx on relay_item (owner_id, status, tab);

create table if not exists relay_draft (
  id text primary key default gen_random_uuid()::text,
  item_id text not null references relay_item(id) on delete cascade,
  role text not null check (role in ('primary', 'follow')),
  position integer not null default 0,
  title text not null default '',
  why text not null default '',
  mail_message_id text references mail_message(id) on delete set null,
  gmail_draft_id text,
  state text not null default 'draft' check (state in ('draft', 'gmail', 'sent', 'skipped')),
  source_note text not null default '',
  agent_log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists relay_draft_item_idx on relay_draft (item_id, position);

create table if not exists relay_todo (
  id text primary key default gen_random_uuid()::text,
  item_id text not null references relay_item(id) on delete cascade,
  title text not null,
  detail text not null default '',
  kind text not null default 'suggested' check (kind in ('suggested', 'promise')),
  state text not null default 'suggested' check (state in ('suggested', 'accepted', 'dismissed', 'done')),
  work_task_id text references work_tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists relay_todo_item_idx on relay_todo (item_id);

create table if not exists relay_rule (
  id text primary key default gen_random_uuid()::text,
  owner_id uuid not null references crm_users(id) on delete cascade,
  text text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists relay_chat (
  item_id text not null references relay_item(id) on delete cascade,
  user_id uuid not null references crm_users(id) on delete cascade,
  conversation_key text not null,
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

grant select, insert, update, delete on relay_item, relay_draft, relay_todo, relay_rule, relay_chat to crm_web_sql;
grant select, insert, update, delete on relay_item, relay_draft, relay_todo, relay_rule, relay_chat to crm_agent_sql;
commit;
