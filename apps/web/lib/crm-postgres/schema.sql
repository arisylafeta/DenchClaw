create extension if not exists pgcrypto;

-- Denchclaw CRM schema — matches production database as of 2026-06-21
--
-- This file mirrors the live `denchclaw` database schema exactly.
-- Tables that were dropped (crm_custom_field_values, crm_saved_views,
-- crm_object_view_settings, crm_statuses, crm_action_runs,
-- crm_commercial_profiles) and the crm_company_commercial_summary_v view
-- are intentionally absent. crm_relation_links is a VIEW, defined at the bottom.

create table if not exists crm_companies (
  id text primary key,
  name text not null,
  domain text,
  website text,
  phone text,
  linkedin_url text,
  country text,
  city text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  notes text,
  tags text[]
);

create table if not exists crm_people (
  id text primary key,
  full_name text,
  first_name text,
  last_name text,
  email text,
  company_id text references crm_companies(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  phone text,
  job_title text,
  linkedin_url text,
  tags text[],
  notes text,
  email_opted_out boolean default false
);

alter table crm_people
  add column if not exists last_interaction_at timestamptz;

create table if not exists crm_email_threads (
  id text primary key,
  subject text,
  last_message_at timestamptz,
  message_count integer,
  gmail_thread_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_email_messages (
  id text primary key,
  thread_id text references crm_email_threads(id) on delete set null,
  subject text,
  sent_at timestamptz,
  from_person_id text references crm_people(id) on delete set null,
  from_email text,
  body_preview text,
  body text,
  has_attachments boolean,
  gmail_message_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_email_thread_participants (
  thread_id text not null references crm_email_threads(id) on delete cascade,
  person_id text not null references crm_people(id) on delete cascade,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (thread_id, person_id)
);

create table if not exists crm_email_message_recipients (
  message_id text not null references crm_email_messages(id) on delete cascade,
  person_id text not null references crm_people(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('to', 'cc')),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (message_id, person_id, recipient_type)
);

create table if not exists crm_calendar_events (
  id text primary key,
  title text,
  start_at timestamptz,
  end_at timestamptz,
  organizer_person_id text references crm_people(id) on delete set null,
  meeting_type text,
  google_event_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_calendar_event_attendees (
  event_id text not null references crm_calendar_events(id) on delete cascade,
  person_id text not null references crm_people(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, person_id)
);

create table if not exists crm_interactions (
  id text primary key,
  type text,
  occurred_at timestamptz,
  person_id text references crm_people(id) on delete set null,
  company_id text references crm_companies(id) on delete set null,
  email_message_id text references crm_email_messages(id) on delete set null,
  calendar_event_id text references crm_calendar_events(id) on delete set null,
  direction text,
  score_contribution double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_objects (
  id text primary key,
  name text not null unique,
  entity_table text,
  description text,
  default_view text not null default 'table',
  display_field text,
  immutable boolean not null default false,
  hidden_in_sidebar boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_fields (
  id text primary key,
  object_id text not null references crm_objects(id) on delete cascade,
  name text not null,
  type text not null,
  canonical_column text,
  description text,
  required boolean not null default false,
  enum_values jsonb,
  enum_colors jsonb,
  enum_multiple boolean not null default false,
  related_object_id text references crm_objects(id),
  relationship_type text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (object_id, name)
);

create table if not exists crm_documents (
  id text primary key default (gen_random_uuid()::text),
  title text default 'Untitled',
  icon text,
  file_path text not null unique,
  parent_object_id text references crm_objects(id),
  entry_id text,
  sort_order integer default 0,
  is_published boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists crm_commercial_opportunities (
  id text primary key,
  company_id text not null references crm_companies(id) on delete cascade,
  contact_person_id text references crm_people(id) on delete set null,
  opportunity_type text not null check (opportunity_type in ('supply', 'demand')),
  status text not null default 'open' check (status in ('draft', 'open', 'matched', 'closed', 'expired', 'cancelled')),
  source_system text not null default 'crm' check (source_system in ('crm', 'supabase', 'csv', 'email')),
  source_id text,
  title text not null,
  battery_type text,
  previous_application text,
  chemistry text,
  condition text,
  format text,
  manufacturer text,
  model text,
  specific_type text,
  quantity numeric(12,2) check (quantity is null or quantity >= 0),
  soh numeric(5,2) check (soh is null or (soh >= 0 and soh <= 100)),
  pack_kwh numeric(12,3) check (pack_kwh is null or pack_kwh >= 0),
  location_country text,
  location_region text,
  available_from timestamptz,
  deadline_at timestamptz,
  price_amount numeric(12,2) check (price_amount is null or price_amount >= 0),
  currency text,
  urgency text not null default 'medium' check (urgency in ('low', 'medium', 'high', 'critical')),
  priority_score numeric(8,2) check (priority_score is null or priority_score >= 0),
  notes text,
  raw_json jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  buyer_company_id text references crm_companies(id) on delete set null,
  seller_company_id text references crm_companies(id) on delete set null
);

-- updated_at maintenance trigger function
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_crm_commercial_opportunities_set_updated_at on crm_commercial_opportunities;
create trigger trg_crm_commercial_opportunities_set_updated_at
before update on crm_commercial_opportunities
for each row
execute function set_updated_at();

-- First-class invite-only CRM identities and revocable sessions.
create table if not exists crm_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  is_active boolean not null default true,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists crm_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references crm_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists crm_sessions_active_idx on crm_sessions(token_hash, expires_at) where revoked_at is null;

-- ReBattery Projects / Work Tasks prototype: canonical tables intentionally keep a small,
-- explicit field set so the existing object table/detail/Kanban interfaces can render them.
create table if not exists projects (
  id text primary key, name text not null, status text not null default 'Active', objective text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists work_tasks (
  id text primary key, reb_key text not null unique, title text not null, status text not null,
  project_id text references projects(id) on delete set null, priority text, repository text, task_details text,
  assignee_id uuid references crm_users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- Upgrade Projects/Work Tasks created by the earlier prototype without
-- deleting its historical columns or data.
alter table projects add column if not exists status text not null default 'Active';
alter table projects add column if not exists objective text;
alter table work_tasks add column if not exists task_details text;
alter table work_tasks add column if not exists assignee_id uuid references crm_users(id) on delete set null;
create index if not exists work_tasks_project_idx on work_tasks(project_id);
create index if not exists work_tasks_assignee_idx on work_tasks(assignee_id);
create index if not exists work_tasks_status_idx on work_tasks(status);
drop trigger if exists trg_projects_set_updated_at on projects;
create trigger trg_projects_set_updated_at before update on projects for each row execute function set_updated_at();
drop trigger if exists trg_work_tasks_set_updated_at on work_tasks;
create trigger trg_work_tasks_set_updated_at before update on work_tasks for each row execute function set_updated_at();

-- Read-only projection of the durable loop runtime for Dench monitoring.
-- loopctl remains authoritative; the sync command only upserts observations.
create table if not exists automation_loops (
  id text primary key,
  name text not null,
  workflow_id text,
  workflow_name text,
  lifecycle text not null,
  operation text not null,
  role text,
  trigger_type text,
  owner_app text,
  objective text,
  mode text,
  definition_path text,
  definition_hash text,
  registry_hash text,
  current_status text,
  current_reason text,
  current_disposition text,
  is_blocked boolean not null default false,
  needs_attention boolean not null default false,
  attention_reason text,
  latest_run_id text,
  latest_invocation_id text,
  last_activity_at timestamptz,
  last_success_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  lease_stale boolean not null default false,
  approval_required boolean not null default false,
  output_exists boolean,
  output_path text,
  schedule_owner text,
  latest_scheduled_at timestamptz,
  scheduler_health text,
  observation_error text,
  source_schema_version integer not null,
  observed_at timestamptz not null,
  tombstoned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists automation_loop_runs (
  id text primary key,
  activity_name text not null,
  loop_id text not null references automation_loops(id) on delete cascade,
  invocation_id text,
  run_id text,
  trigger_key_hash text,
  occurrence_key_hash text,
  origin text,
  kind text,
  status text not null,
  reason text,
  disposition text,
  blocker text,
  approval_required boolean not null default false,
  output_path text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms bigint,
  langfuse_trace_id text,
  agent_session_id text,
  source_schema_version integer not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists automation_loops_attention_idx
  on automation_loops(needs_attention, last_activity_at desc);
create index if not exists automation_loops_status_idx
  on automation_loops(current_status, last_activity_at desc);
create index if not exists automation_loop_runs_loop_started_idx
  on automation_loop_runs(loop_id, started_at desc nulls last);
create unique index if not exists automation_loop_runs_invocation_idx
  on automation_loop_runs(invocation_id) where invocation_id is not null;

-- crm_relation_links is a VIEW (not a table) that unions together all of the
-- relationship edges derived from the junction tables and FK columns above.
create or replace view crm_relation_links as
select
  'seed_obj_email_thread_000000000'::text as object_id,
  'seed_fld_emthread_people_00000'::text as field_id,
  crm_email_thread_participants.thread_id as source_entry_id,
  crm_email_thread_participants.person_id as target_entry_id,
  crm_email_thread_participants.position,
  crm_email_thread_participants.created_at
from crm_email_thread_participants
union all
select
  'seed_obj_email_message_00000000'::text as object_id,
  'seed_fld_emmsg_to_0000000000000'::text as field_id,
  crm_email_message_recipients.message_id as source_entry_id,
  crm_email_message_recipients.person_id as target_entry_id,
  crm_email_message_recipients.position,
  crm_email_message_recipients.created_at
from crm_email_message_recipients
where crm_email_message_recipients.recipient_type = 'to'
union all
select
  'seed_obj_email_message_00000000'::text as object_id,
  'seed_fld_emmsg_cc_0000000000000'::text as field_id,
  crm_email_message_recipients.message_id as source_entry_id,
  crm_email_message_recipients.person_id as target_entry_id,
  crm_email_message_recipients.position,
  crm_email_message_recipients.created_at
from crm_email_message_recipients
where crm_email_message_recipients.recipient_type = 'cc'
union all
select
  'seed_obj_calendar_event_0000000'::text as object_id,
  'seed_fld_calev_attend_000000000'::text as field_id,
  crm_calendar_event_attendees.event_id as source_entry_id,
  crm_calendar_event_attendees.person_id as target_entry_id,
  0 as position,
  crm_calendar_event_attendees.created_at
from crm_calendar_event_attendees
union all
select
  'seed_obj_people_00000000000000'::text as object_id,
  'seed_fld_people_company_0000000'::text as field_id,
  crm_people.id as source_entry_id,
  crm_people.company_id as target_entry_id,
  0 as position,
  crm_people.created_at
from crm_people
where crm_people.company_id is not null
union all
select
  'seed_obj_email_message_00000000'::text as object_id,
  'seed_fld_emmsg_from_00000000000'::text as field_id,
  crm_email_messages.id as source_entry_id,
  crm_email_messages.from_person_id as target_entry_id,
  0 as position,
  crm_email_messages.created_at
from crm_email_messages
where crm_email_messages.from_person_id is not null
union all
select
  'seed_obj_email_message_00000000'::text as object_id,
  'seed_fld_emmsg_thread_000000000'::text as field_id,
  crm_email_messages.id as source_entry_id,
  crm_email_messages.thread_id as target_entry_id,
  0 as position,
  crm_email_messages.created_at
from crm_email_messages
where crm_email_messages.thread_id is not null
union all
select
  'seed_obj_interaction_00000000000'::text as object_id,
  'seed_fld_inter_person_000000000'::text as field_id,
  crm_interactions.id as source_entry_id,
  crm_interactions.person_id as target_entry_id,
  0 as position,
  crm_interactions.created_at
from crm_interactions
where crm_interactions.person_id is not null
union all
select
  'seed_obj_interaction_00000000000'::text as object_id,
  'seed_fld_inter_company_00000000'::text as field_id,
  crm_interactions.id as source_entry_id,
  crm_interactions.company_id as target_entry_id,
  0 as position,
  crm_interactions.created_at
from crm_interactions
where crm_interactions.company_id is not null
union all
select
  'seed_obj_interaction_00000000000'::text as object_id,
  'seed_fld_inter_email_0000000000'::text as field_id,
  crm_interactions.id as source_entry_id,
  crm_interactions.email_message_id as target_entry_id,
  0 as position,
  crm_interactions.created_at
from crm_interactions
where crm_interactions.email_message_id is not null
union all
select
  'seed_obj_interaction_00000000000'::text as object_id,
  'seed_fld_inter_event_0000000000'::text as field_id,
  crm_interactions.id as source_entry_id,
  crm_interactions.calendar_event_id as target_entry_id,
  0 as position,
  crm_interactions.created_at
from crm_interactions
where crm_interactions.calendar_event_id is not null
union all
select
  'seed_obj_calendar_event_0000000'::text as object_id,
  'seed_fld_calev_organ_0000000000'::text as field_id,
  crm_calendar_events.id as source_entry_id,
  crm_calendar_events.organizer_person_id as target_entry_id,
  0 as position,
  crm_calendar_events.created_at
from crm_calendar_events
where crm_calendar_events.organizer_person_id is not null
union all
select
  'f43167a6-6805-44ab-b26a-e187752365f1'::text as object_id,
  '36cf33c6-dcbb-47f8-9c82-c287b40d24ed'::text as field_id,
  crm_commercial_opportunities.id as source_entry_id,
  crm_commercial_opportunities.company_id as target_entry_id,
  0 as position,
  crm_commercial_opportunities.created_at
from crm_commercial_opportunities
where crm_commercial_opportunities.company_id is not null
union all
select
  'f43167a6-6805-44ab-b26a-e187752365f1'::text as object_id,
  '164c1603-4faa-46d8-98dc-03f7e6f91152'::text as field_id,
  crm_commercial_opportunities.id as source_entry_id,
  crm_commercial_opportunities.contact_person_id as target_entry_id,
  0 as position,
  crm_commercial_opportunities.created_at
from crm_commercial_opportunities
where crm_commercial_opportunities.contact_person_id is not null
union all
select
  'f43167a6-6805-44ab-b26a-e187752365f1'::text as object_id,
  '1eac4175-7d53-4712-8f2f-79d23c254e06'::text as field_id,
  crm_commercial_opportunities.id as source_entry_id,
  crm_commercial_opportunities.buyer_company_id as target_entry_id,
  0 as position,
  crm_commercial_opportunities.created_at
from crm_commercial_opportunities
where crm_commercial_opportunities.buyer_company_id is not null
union all
select
  'f43167a6-6805-44ab-b26a-e187752365f1'::text as object_id,
  '30204a59-a42f-4baa-a3a8-3ad92fe441b3'::text as field_id,
  crm_commercial_opportunities.id as source_entry_id,
  crm_commercial_opportunities.seller_company_id as target_entry_id,
  0 as position,
  crm_commercial_opportunities.created_at
from crm_commercial_opportunities
where crm_commercial_opportunities.seller_company_id is not null
union all
select 'reb_work_task_object'::text, 'reb_work_task_3'::text,
       work_tasks.id, work_tasks.project_id, 0, work_tasks.created_at
from work_tasks where work_tasks.project_id is not null
union all
select 'reb_automation_loop_run_object'::text, 'reb_automation_loop_run_loop'::text,
       automation_loop_runs.id, automation_loop_runs.loop_id, 0, automation_loop_runs.created_at
from automation_loop_runs;

-- Indexes (non-constraint indexes only; primary keys & unique constraints
-- are declared inline above).

create index if not exists crm_companies_domain_idx on crm_companies (lower(domain));
create index if not exists crm_companies_name_idx on crm_companies (lower(name));

create index if not exists crm_people_email_idx on crm_people (lower(email));
create index if not exists crm_people_company_idx on crm_people (company_id);
create index if not exists crm_people_job_title_idx on crm_people (job_title) where job_title is not null;

create index if not exists crm_email_messages_thread_sent_idx on crm_email_messages (thread_id, sent_at desc);

create index if not exists idx_thread_participants_person on crm_email_thread_participants (person_id);

create index if not exists idx_msg_recipients_person on crm_email_message_recipients (person_id);
create index if not exists idx_msg_recipients_type on crm_email_message_recipients (recipient_type);

create index if not exists idx_event_attendees_person on crm_calendar_event_attendees (person_id);

create index if not exists idx_crm_commercial_opportunities_company_id on crm_commercial_opportunities (company_id);
create index if not exists idx_crm_commercial_opportunities_type_status on crm_commercial_opportunities (opportunity_type, status);
create index if not exists idx_crm_commercial_opportunities_source on crm_commercial_opportunities (source_system, source_id) where source_id is not null;
create index if not exists idx_crm_commercial_opportunities_deadline on crm_commercial_opportunities (deadline_at) where status = 'open' and deadline_at is not null;

-- Campaign metrics snapshot (one row per auction/campaign).
-- Aggregate metrics filled from the rebattery-platform `auction.invites` /
-- `auction.emails` / `auction.questions` tables after each campaign.
-- Read-only CRM object: registered as crm_objects(name='campaign') + crm_fields
-- in the live database (decorated here for versioning).
create table if not exists campaigns (
  id text primary key,
  campaign_name text not null,
  auction_slug text not null unique,
  type text not null default 'auction_invite',
  channel text not null default 'email-postmark',
  audience text,
  status text not null default 'live',
  source_system text not null default 'rebattery-platform',
  launched_at timestamptz,
  last_invite_at timestamptz,
  audience_size integer not null default 0,
  invites_sent integer not null default 0,
  emails_delivered integer not null default 0,
  emails_opened integer not null default 0,
  emails_clicked integer not null default 0,
  emails_bounced integer not null default 0,
  opted_out integer not null default 0,
  invitees_viewed integer not null default 0,
  total_views integer not null default 0,
  questions_asked integer not null default 0,
  quotes_submitted integer not null default 0,
  total_quote_value numeric(14,2) not null default 0,
  crm_person_coverage integer not null default 0,
  metrics_refreshed_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_campaigns_set_updated_at on campaigns;
create trigger trg_campaigns_set_updated_at
  before update on campaigns
  for each row
  execute function set_updated_at();

create index if not exists campaigns_status_idx on campaigns (status);
create index if not exists campaigns_launched_at_idx on campaigns (launched_at desc nulls last);
