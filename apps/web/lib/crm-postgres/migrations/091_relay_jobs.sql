-- Relay: background agent jobs for notes that need research or files ("research our LFP supply and attach a list"). Additive.
begin;
create table if not exists relay_job (
  id text primary key default gen_random_uuid()::text,
  item_id text not null references relay_item(id) on delete cascade,
  owner_id uuid not null references crm_users(id) on delete cascade,
  note text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'ready', 'finalising', 'done', 'failed')),
  steps jsonb not null default '[]'::jsonb,
  error text,
  result jsonb,
  session_id text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists relay_job_item_idx on relay_job (item_id, created_at desc);
grant select, insert, update, delete on relay_job to crm_web_sql;
grant select, insert, update, delete on relay_job to crm_agent_sql;
commit;
