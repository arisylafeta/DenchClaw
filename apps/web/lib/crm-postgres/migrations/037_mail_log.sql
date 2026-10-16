-- Mail log: one authoritative store for every message ReBattery sends or receives, both directions,
-- all transports (Gmail, Postmark broadcast, Postmark transactional). Replaces crm_email_* and
-- crm_campaign_sends / crm_campaign_send_links (dropped in 038 after the one-time load).
-- Apply only after a current verified pg_dump and explicit schema approval.
--
-- Ownership:
--   * Provider-owned: mail_message state/timestamps from providers, mail_event. Written only by
--     `rebattery-mail sync`, the Postmark webhook path and the send claim. No hand edits.
--   * Human-owned: mail_approval (approved_by is a named human), mail_identity signatures, mail_template copy.
--   * `campaigns` stays the campaign record (platform-synced metrics live there). It gains the mail columns below.
begin;
set local lock_timeout = '5s';

create table if not exists mail_identity (
  key text primary key check (key ~ '^[a-z][a-z0-9_-]{1,30}$'),
  address text not null unique,
  display_name text not null,
  gmail_account text,             -- authenticated gog account that sends/reads this address (alias source)
  postmark_stream text,           -- Postmark message stream for campaigns/transactional, when verified
  signature_html text,
  signature_text text,
  reply_to text,
  allowed_purposes text[] not null default array['personal','marketing','transactional'],
  escalation_owner text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (gmail_account is not null or postmark_stream is not null)
);

create table if not exists mail_template (
  id text primary key,
  name text not null,
  version integer not null check (version > 0),
  subject text not null,
  html text not null,
  text_body text not null,
  required_variables text[] not null default '{}',
  allowed_identities text[] not null default '{}',   -- empty = any identity
  allowed_purposes text[] not null default array['personal','marketing','transactional'],
  created_by text,
  created_at timestamptz not null default now(),
  unique (name, version)
);

alter table campaigns add column if not exists purpose text
  check (purpose is null or purpose in ('personal','marketing','transactional'));
alter table campaigns add column if not exists identity_key text references mail_identity(key);
alter table campaigns add column if not exists template_name text;
alter table campaigns add column if not exists template_version integer;
alter table campaigns add column if not exists pilot_cap integer check (pilot_cap is null or pilot_cap > 0);
alter table campaigns add column if not exists frozen_at timestamptz;
alter table campaigns add column if not exists mail_state text not null default 'legacy'
  check (mail_state in ('legacy','draft','frozen','approved','pilot','launched','closed'));

create table if not exists mail_thread (
  id text primary key,
  subject text,
  gmail_thread_id text,
  mailbox_owner_id uuid references crm_users(id) on delete restrict,
  rfc_root_message_id text,
  last_message_at timestamptz,
  message_count integer not null default 0,
  crm_visible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists mail_thread_owner_gmail_uidx
  on mail_thread (mailbox_owner_id, gmail_thread_id) where gmail_thread_id is not null;
create index if not exists mail_thread_last_idx on mail_thread (mailbox_owner_id, last_message_at desc);
create index if not exists mail_thread_crm_last_idx on mail_thread (last_message_at desc) where crm_visible;

create table if not exists mail_message (
  id text primary key,
  direction text not null check (direction in ('inbound','outbound')),
  transport text not null check (transport in ('gmail','postmark-broadcast','postmark-transactional')),
  purpose text check (purpose is null or purpose in ('personal','marketing','transactional')),
  identity_key text references mail_identity(key),
  mailbox_owner_id uuid references crm_users(id) on delete restrict,
  campaign_id text references campaigns(id) on delete restrict,
  thread_id text references mail_thread(id) on delete set null,
  subject text,
  body_text text,
  body_html text,
  body_preview text,
  from_email text,
  from_person_id text references crm_people(id) on delete set null,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  bcc_emails text[] not null default '{}',
  recipient_email text,                     -- the single recipient of a campaign or transactional delivery
  person_id text references crm_people(id) on delete set null,
  company_id text references crm_companies(id) on delete set null,
  listing_id text,
  auction_url text,
  personalization jsonb not null default '{}'::jsonb,
  labels text[] not null default '{}',
  has_attachments boolean not null default false,
  state text not null check (state in ('draft','frozen','approved','sending','unknown','accepted','failed','received')),
  idempotency_key text unique,
  provider_message_id text unique,          -- Postmark MessageID
  gmail_message_id text,
  rfc_message_id text,
  in_reply_to text,
  rfc_references text,
  claimed_at timestamptz,
  sent_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  last_synced_at timestamptz,
  crm_visible boolean not null default false,
  crm_visible_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((direction = 'inbound' and state = 'received') or direction = 'outbound'),
  check (direction = 'inbound' or purpose is not null)
);
create unique index if not exists mail_message_owner_gmail_uidx
  on mail_message (mailbox_owner_id, gmail_message_id) where gmail_message_id is not null;
create unique index if not exists mail_message_campaign_person_uidx
  on mail_message (campaign_id, person_id) where campaign_id is not null and person_id is not null;
create unique index if not exists mail_message_campaign_recipient_uidx
  on mail_message (campaign_id, recipient_email) where campaign_id is not null and recipient_email is not null;
create index if not exists mail_message_thread_idx on mail_message (thread_id, sent_at desc);
create index if not exists mail_message_person_idx on mail_message (person_id, sent_at desc);
create index if not exists mail_message_person_listing_idx on mail_message (person_id, listing_id, accepted_at desc);
create index if not exists mail_message_owner_sent_idx on mail_message (mailbox_owner_id, sent_at desc);
create index if not exists mail_message_state_idx on mail_message (state) where state in ('sending','unknown','frozen');
create index if not exists mail_message_crm_sent_idx on mail_message (sent_at desc) where crm_visible;
create index if not exists mail_message_rfc_idx on mail_message (rfc_message_id) where rfc_message_id is not null;
create index if not exists mail_message_search_idx
  on mail_message using gin (to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(body_text, body_preview, '')));

create table if not exists mail_message_link (
  id text primary key,
  message_id text not null references mail_message(id) on delete restrict,
  cta_key text not null,
  destination_url text not null,
  listing_id text,
  first_clicked_at timestamptz,
  unique (message_id, cta_key),
  unique (message_id, destination_url)
);
create index if not exists mail_message_link_listing_idx
  on mail_message_link (listing_id, message_id) where listing_id is not null;

create table if not exists mail_thread_participant (
  thread_id text not null references mail_thread(id) on delete cascade,
  person_id text not null references crm_people(id) on delete cascade,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (thread_id, person_id)
);

create table if not exists mail_message_recipient (
  message_id text not null references mail_message(id) on delete cascade,
  person_id text not null references crm_people(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('to','cc')),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (message_id, person_id, recipient_type)
);

-- Append-only provider truth. mail_message timestamps are a denormalised cache of this table.
create table if not exists mail_event (
  id bigserial primary key,
  message_id text not null references mail_message(id) on delete cascade,
  type text not null check (type in ('sent','delivered','bounced','opened','clicked','unsubscribed','replied','suppressed','accepted_write_failed')),
  source text not null check (source in ('postmark','gmail','cli')),
  provider_event_id text,
  occurred_at timestamptz not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists mail_event_provider_uidx
  on mail_event (source, provider_event_id) where provider_event_id is not null;
create index if not exists mail_event_message_idx on mail_event (message_id, occurred_at);
create index if not exists mail_event_type_idx on mail_event (type, occurred_at desc);

create table if not exists mail_followup (
  id text primary key,
  message_id text references mail_message(id) on delete cascade,
  thread_id text references mail_thread(id) on delete cascade,
  person_id text references crm_people(id) on delete set null,
  identity_key text references mail_identity(key),
  due_at timestamptz not null,
  origin text not null check (origin in ('sequence','commitment')),
  state text not null default 'pending' check (state in ('pending','drafted','paused','cancelled','done')),
  note text,
  paused_reason text,
  draft_message_id text references mail_message(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (message_id is not null or thread_id is not null)
);
create index if not exists mail_followup_due_idx on mail_followup (due_at) where state = 'pending';

create table if not exists mail_approval (
  id text primary key,
  subject_type text not null check (subject_type in ('campaign','message')),
  subject_id text not null,
  sha256 text not null,
  recipient_count integer not null check (recipient_count >= 0),
  identity_key text not null references mail_identity(key),
  approved_by text not null check (length(trim(approved_by)) > 0),
  approved_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
alter table mail_approval add column if not exists scope text not null default 'full'
  check (scope in ('pilot','full'));
create index if not exists mail_approval_subject_idx on mail_approval (subject_type, subject_id, approved_at desc);

-- Port of crm_mark_campaign_send (026): an accepted campaign message subscribes the person to the Supply update list
-- and moves the company New -> Contacted, for campaigns typed supply_update or intro only.
create or replace function mail_mark_campaign_send() returns trigger language plpgsql as $$
declare
  kind text;
  label text;
  sub_status text;
  company text;
begin
  if new.state <> 'accepted' or new.person_id is null or new.campaign_id is null or new.direction <> 'outbound' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.state = 'accepted' then
    return null;
  end if;
  select type, campaign_name into kind, label from campaigns where id = new.campaign_id;
  if kind is null or kind not in ('supply_update', 'intro') then
    return null;
  end if;

  insert into crm_subscriptions (person_id, list, status, since, how)
  values (new.person_id, 'Supply update', 'Subscribed', coalesce(new.accepted_at, now())::date, 'Sent: ' || label)
  on conflict (person_id, list) do nothing;

  select status into sub_status from crm_subscriptions where person_id = new.person_id and list = 'Supply update';
  if sub_status = 'Subscribed' then
    update crm_people set tags = array(select distinct unnest(coalesce(tags, '{}') || array['Supply Update'])), updated_at = now()
    where id = new.person_id and not (coalesce(tags, '{}') @> array['Supply Update']);
  end if;

  company := coalesce(new.company_id, (select company_id from crm_people where id = new.person_id));
  if company is not null then
    update crm_companies set relationship_stage = 'Contacted', updated_at = now()
    where id = company and relationship_stage = 'New';
  end if;
  return null;
end $$;

drop trigger if exists trg_mail_message_marks_contact on mail_message;
create trigger trg_mail_message_marks_contact
  after insert or update of state on mail_message
  for each row execute function mail_mark_campaign_send();

insert into mail_identity (key, address, display_name, gmail_account, postmark_stream, signature_text, allowed_purposes)
values
  ('alex',       'alex@rebattery.io',       'Alex',                 'alex@rebattery.io', null, null, array['personal','marketing','transactional']),
  ('ari',        'ari@rebattery.io',        'Ari',                  'ari@rebattery.io',  null, null, array['personal','marketing','transactional']),
  ('supply',     'supply@rebattery.io',     'Supply @ ReBattery',   'alex@rebattery.io', null, null, array['personal','marketing','transactional']),
  ('hello',      'hello@rebattery.io',      'ReBattery',            null, 'outbound',   null, array['personal','marketing','transactional']),
  ('support',    'support@rebattery.io',    'ReBattery Support',    null, 'outbound',   null, array['personal','marketing','transactional']),
  ('enterprise', 'enterprise@rebattery.io', 'ReBattery Enterprise', null, 'outbound',   null, array['personal','marketing','transactional'])
on conflict (key) do nothing;

-- Address-level opt-outs survive even when no CRM person or message exists.
create table if not exists mail_suppression (
  email text primary key check (email = lower(btrim(email)) and position('@' in email) > 1),
  reason text not null,
  source text not null,
  stream text,
  since timestamptz not null,
  detail jsonb not null default '{}'::jsonb
);

commit;
