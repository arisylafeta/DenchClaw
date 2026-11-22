-- Relay desk: a resumable Claude Code session behind every Relay email. Each first draft and each chat message is one
-- run of that session (scripts/rebattery/relay_desk.py). The desk changes drafts only through Relay's own tools, which
-- go through the guarded code (leak guard, history and Undo, version checks); it never sends. Additive and idempotent.
begin;

-- One desk turn. mode: quick (first draft on open), ahead (background first draft), chat (Alex's message).
-- status: queued -> running -> done | failed | stopped; stopping asks the runner to kill the process group.
create table if not exists relay_desk_run (
  id text primary key default gen_random_uuid()::text,
  item_id text not null references relay_item(id) on delete cascade,
  owner_id uuid not null references crm_users(id) on delete cascade,
  mode text not null check (mode in ('quick', 'ahead', 'chat')),
  text text not null default '',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'stopped', 'stopping')),
  pid integer,
  session_id text,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  cost_usd numeric(10, 4),
  created_at timestamptz not null default now()
);
-- One active desk turn per email: a second start while one is queued, running or stopping fails on this index.
create unique index if not exists relay_desk_run_active_uidx on relay_desk_run (item_id) where status in ('queued', 'running', 'stopping');
create index if not exists relay_desk_run_item_idx on relay_desk_run (item_id, created_at desc);
create index if not exists relay_desk_run_owner_status_idx on relay_desk_run (owner_id, status);

-- The email's Claude Code session, resumed by every desk turn and by "Continue in Claude".
alter table relay_item add column if not exists desk_session_id text;

-- A reply the desk wrote is marked as such, so learning can tell the desk's drafts from the one-shot ones.
alter table relay_draft drop constraint if exists relay_draft_origin_check;
alter table relay_draft add constraint relay_draft_origin_check check (origin in ('note', 'job', 'predraft', 'card', 'desk'));
commit;
