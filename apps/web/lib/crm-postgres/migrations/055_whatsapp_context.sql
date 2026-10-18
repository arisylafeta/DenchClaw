-- Local capture projections. No credentials, outbound transport or per-chat grants.
create table if not exists whatsapp_account (
  id text primary key,
  account_jid text not null unique,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);
create table if not exists whatsapp_identity (
  id text primary key,
  account_id text not null references whatsapp_account(id),
  canonical_jid text not null,
  e164 text check (e164 is null or e164 ~ '^\+[1-9][0-9]{6,14}$'),
  raw_phone text,
  extension text,
  display_name text,
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  unique(account_id, canonical_jid),
  unique(account_id, id)
);
create table if not exists whatsapp_identity_alias (
  account_id text not null references whatsapp_account(id),
  jid text not null,
  identity_id text not null,
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  primary key(account_id, jid),
  foreign key(account_id, identity_id) references whatsapp_identity(account_id, id)
);
create table if not exists whatsapp_identity_link (
  id text primary key,
  account_id text not null references whatsapp_account(id),
  identity_id text not null,
  person_id text references crm_people(id),
  company_id text references crm_companies(id),
  method text not null check (method in ('auto_e164','manual')),
  confidence text not null check (confidence in ('high','confirmed')),
  evidence jsonb not null,
  actor text not null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  check (person_id is not null or company_id is not null),
  check (valid_to is null or valid_to >= valid_from),
  foreign key(account_id, identity_id) references whatsapp_identity(account_id, id)
);
create unique index if not exists whatsapp_identity_person_active on whatsapp_identity_link(identity_id, person_id) where valid_to is null and person_id is not null;
create unique index if not exists whatsapp_identity_company_active on whatsapp_identity_link(identity_id, company_id) where valid_to is null and person_id is null;
create table if not exists whatsapp_thread (
  id text primary key,
  account_id text not null references whatsapp_account(id),
  canonical_chat_id text not null,
  identity_id text,
  kind text not null check (kind in ('direct','group')),
  subject text,
  first_captured_at timestamptz not null,
  last_captured_at timestamptz not null,
  metadata jsonb not null default '{}',
  unique(account_id, canonical_chat_id),
  unique(account_id, id),
  foreign key(account_id, identity_id) references whatsapp_identity(account_id, id)
);
create table if not exists whatsapp_thread_member (
  account_id text not null,
  thread_id text not null,
  identity_id text not null,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  metadata jsonb not null default '{}',
  primary key(thread_id, identity_id),
  foreign key(account_id, thread_id) references whatsapp_thread(account_id, id),
  foreign key(account_id, identity_id) references whatsapp_identity(account_id, id)
);
create table if not exists whatsapp_message (
  id text primary key,
  account_id text not null,
  thread_id text not null,
  provider_message_id text not null,
  sender_identity_id text,
  direction text check (direction in ('inbound','outbound')),
  occurred_at timestamptz,
  captured_at timestamptz not null,
  timestamp_source text not null default 'capture',
  body text,
  attachment jsonb,
  metadata jsonb not null default '{}',
  reply_to_provider_id text,
  reply_to_message_id text,
  edit_version integer not null default 0,
  deleted_at timestamptz,
  original_seen boolean not null default false,
  projection_order text not null default '',
  unique(account_id, thread_id, provider_message_id),
  foreign key(account_id, thread_id) references whatsapp_thread(account_id, id),
  foreign key(account_id, sender_identity_id) references whatsapp_identity(account_id, id)
);
create index if not exists whatsapp_message_thread_order on whatsapp_message(thread_id, occurred_at, id);
create table if not exists whatsapp_event (
  id text primary key,
  account_id text not null references whatsapp_account(id),
  thread_id text,
  message_id text,
  kind text not null,
  logical_key text not null,
  envelope_id text,
  target_provider_id text,
  source_at timestamptz,
  captured_at timestamptz not null,
  payload jsonb not null,
  provenance jsonb not null default '{}',
  unique(account_id, logical_key),
  foreign key(account_id, thread_id) references whatsapp_thread(account_id, id)
);
create table if not exists whatsapp_ingest_cursor (
  account_id text not null references whatsapp_account(id),
  source_path text not null,
  generation text not null,
  fingerprint text not null,
  byte_offset bigint not null default 0 check (byte_offset >= 0),
  record_count bigint not null default 0,
  quarantine_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key(account_id, source_path)
);
alter table crm_users add column if not exists can_read_whatsapp boolean not null default true;
-- Keep legacy immutable-export evidence separate from live source references.
alter table crm_bulk_trade_evidence_links drop constraint if exists crm_bulk_trade_evidence_links_evidence_kind_check;
alter table crm_bulk_trade_evidence_links add constraint crm_bulk_trade_evidence_links_evidence_kind_check check (
  evidence_kind in ('whatsapp_message', 'whatsapp_attachment', 'gmail_thread', 'gmail_message',
    'crm_opportunity', 'marketplace_listing', 'marketplace_offer', 'marketplace_deal',
    'whatsapp_live_thread', 'whatsapp_live_message')
);
