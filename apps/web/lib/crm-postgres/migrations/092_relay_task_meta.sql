-- Relay To-dos: what Relay knows about each open Work Task (category, next step, urgency, link, snooze).
-- Work Tasks stay the single source of truth; this table only adds Relay's view of them. Additive.
begin;
create table if not exists relay_task_meta (
  work_task_id text primary key references work_tasks(id) on delete cascade,
  category text not null default 'other' check (category in ('market', 'trade', 'ops', 'decide', 'mine', 'other')),
  title text not null default '',
  next_step text not null default '',
  urgent_reason text,
  due_at date,
  question text,
  yes_label text,
  no_label text,
  action_label text,
  action_kind text not null default 'open' check (action_kind in ('draft', 'open', 'none')),
  action_note text not null default '',
  link_kind text check (link_kind in ('mail', 'deal', 'shop', 'chat')),
  link_label text,
  relay_item_id text references relay_item(id) on delete set null,
  mail_thread_id text references mail_thread(id) on delete set null,
  bulk_listing_id text references crm_bulk_listings(id) on delete set null,
  link_url text,
  snooze_until timestamptz,
  source_hash text,
  classified_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists relay_task_meta_snooze_idx on relay_task_meta (snooze_until);
grant select, insert, update, delete on relay_task_meta to crm_web_sql;
grant select, insert, update, delete on relay_task_meta to crm_agent_sql;
commit;
