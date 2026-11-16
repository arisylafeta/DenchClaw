-- Mail thread ownership: which Hermes agent (profile, optionally one session) owns an email thread and its follow-ups.
--
-- Agents manage ownership with `rebattery-mail owner …`; nobody edits these tables by hand. One owner per thread.
-- mail_thread_owner_event keeps every change. mail_owner_rule routes brand-new threads (tag, sender, person,
-- company, domain or mailbox). mail_agent_event is the dispatch queue: one row per inbound message, so a message
-- wakes its owner at most once. Relay's relay_sender_rule (inbox tabs) is unrelated and stays.
begin;
create table if not exists mail_thread_owner (
  thread_id text primary key references mail_thread(id) on delete cascade,
  profile text not null check (profile ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  session_id text check (session_id is null or session_id <> ''),
  assigned_by text not null,
  reason text,
  rule_id text,
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mail_thread_owner_profile_idx on mail_thread_owner (profile, updated_at desc);

create table if not exists mail_thread_owner_event (
  id bigserial primary key,
  thread_id text not null,
  action text not null check (action in ('set', 'handoff', 'clear', 'route')),
  from_profile text,
  from_session_id text,
  to_profile text,
  to_session_id text,
  actor text not null,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists mail_thread_owner_event_thread_idx on mail_thread_owner_event (thread_id, created_at desc);

create table if not exists mail_owner_rule (
  id text primary key default ('mor_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12)),
  match_kind text not null check (match_kind in ('tag', 'sender', 'person', 'company', 'domain', 'mailbox')),
  match_value text not null check (match_value <> ''),
  profile text not null check (profile ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  session_id text,
  priority integer not null default 100,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (match_kind, match_value)
);

create table if not exists mail_agent_event (
  id bigserial primary key,
  message_id text not null unique,
  thread_id text,
  profile text,
  session_id text,
  state text not null default 'pending' check (state in ('pending', 'unassigned', 'dispatched', 'skipped', 'failed')),
  detail jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  dispatched_at timestamptz
);
create index if not exists mail_agent_event_state_idx on mail_agent_event (state, created_at);

-- Same convention as the other mail_* tables (052): agents' SQL role may read, never write; the web role gets nothing.
do $$ declare t text; begin
  foreach t in array array['mail_thread_owner', 'mail_thread_owner_event', 'mail_owner_rule', 'mail_agent_event'] loop
    if exists (select 1 from pg_roles where rolname = 'crm_agent_sql') then
      execute format('grant select on public.%I to crm_agent_sql', t);
      execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from crm_agent_sql', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'crm_web_sql') then
      execute format('revoke all privileges on public.%I from crm_web_sql', t);
    end if;
  end loop;
end $$;
commit;
