-- Index of Hermes session metadata so the chat list is one indexed query instead of a walk of every upstream session.
begin;
create table if not exists hermes_security.session_index (
  profile text not null,
  stored_id text not null check (stored_id <> ''),
  source text,
  title text,
  last_active double precision not null default 0,
  started_at double precision not null default 0,
  hidden boolean not null default false,
  is_internal_child boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (profile, stored_id)
);
create index if not exists session_index_recent_idx on hermes_security.session_index (profile, (greatest(last_active, started_at)) desc);
commit;
