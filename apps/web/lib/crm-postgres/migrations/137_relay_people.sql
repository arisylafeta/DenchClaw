-- Relay people: one person behind several email addresses (scripts/rebattery/relay_people.py). An address joins a person
-- only on evidence that is kept: their own email saying so ("stated") or Alex saying Yes ("alex"). Weaker hints (the same
-- signed name and phone) wait as suggestions; a pair Alex said No to is never linked again.
-- Additive and idempotent.
begin;

create table if not exists relay_person_address (
  owner_id uuid not null references crm_users(id) on delete cascade,
  address text not null,
  person_key text not null,
  how text not null check (how in ('stated', 'alex')),
  evidence text not null default '',
  message_id text,
  confirmed_by text,
  created_at timestamptz not null default now(),
  primary key (owner_id, address)
);
create index if not exists relay_person_address_key_idx on relay_person_address (owner_id, person_key);

-- address < other_address. status: open (waiting on Alex), yes (Alex linked them), no (never link them).
create table if not exists relay_person_suggestion (
  id text primary key default gen_random_uuid()::text,
  owner_id uuid not null references crm_users(id) on delete cascade,
  address text not null,
  other_address text not null,
  why text not null,
  evidence text not null default '',
  message_id text,
  status text not null default 'open' check (status in ('open', 'yes', 'no')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, address, other_address)
);

commit;
