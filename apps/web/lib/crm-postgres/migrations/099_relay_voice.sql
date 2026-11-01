-- Relay voice: how the owner writes, learned from his sent mail by scripts/rebattery/relay_voice_study.py. Additive.
-- relay_voice: one version of the writing guide, with the numbers it was built from and its eval. One active per owner.
-- relay_voice_situation: one playbook card per kind of email (buyer asks price, chase, decline, ...).
-- relay_voice_example: his best real replies per situation, prices, phones and addresses masked. Drafts get the closest three.
-- relay_item.situation: the kind of email, set by the scan's summary, used to pick the card and examples.
begin;

create table if not exists relay_voice (
  id text primary key default gen_random_uuid()::text,
  owner_id uuid not null references crm_users(id) on delete cascade,
  version integer not null,
  guide text not null,
  stats jsonb not null default '{}'::jsonb,
  eval jsonb,
  source_emails integer,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner_id, version)
);
create unique index if not exists relay_voice_one_active_idx on relay_voice (owner_id) where active;

create table if not exists relay_voice_situation (
  voice_id text not null references relay_voice(id) on delete cascade,
  situation text not null,
  label text not null default '',
  card text not null,
  primary key (voice_id, situation)
);

create table if not exists relay_voice_example (
  id text primary key default gen_random_uuid()::text,
  voice_id text not null references relay_voice(id) on delete cascade,
  situation text not null,
  contact_type text,
  identity text,
  kind text,
  inbound text not null default '',
  reply text not null,
  words integer,
  sent_at timestamptz,
  mail_message_id text,
  thread_id text,
  why text not null default ''
);
create index if not exists relay_voice_example_idx on relay_voice_example (voice_id, situation);

alter table relay_item add column if not exists situation text;

grant select, insert, update, delete on relay_voice, relay_voice_situation, relay_voice_example to crm_web_sql;
grant select, insert, update, delete on relay_voice, relay_voice_situation, relay_voice_example to crm_agent_sql;
commit;
