-- Sourcing intake queue: one row per buyer ask (platform sourcing request or buyer brief), so nothing waits in an inbox.
-- Additive: a new table, no triggers, nothing reads it yet except the Sorcerer intake jobs.
begin;
set local lock_timeout = '3s';

create table if not exists sourcing_intake_queue (
  id text primary key,
  source text not null,                -- 'typeform_brief' | 'platform_request'
  source_id text not null,             -- the response token or the platform request id
  email text,
  buyer text,
  wants text,
  received_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new', 'drafted', 'replied', 'closed')),
  demand_id text,                      -- the CRM demand row this brief produced, when it produced one
  draft_mail_id text,                  -- the reply draft Sorcerer wrote, never a sent mail
  owner text,
  next_due date,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_id)
);
create index if not exists sourcing_intake_queue_open_idx on sourcing_intake_queue (status, received_at desc);

commit;
