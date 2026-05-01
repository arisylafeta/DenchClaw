create table if not exists crm_companies (
  id text primary key,
  name text not null,
  domain text,
  website text,
  phone text,
  linkedin_url text,
  company_type text,
  platform_role text,
  sector text,
  role_confidence text,
  role_source text,
  country text,
  city text,
  employee_count double precision,
  annual_revenue_micros double precision,
  lifecycle_stage text,
  lead_status text,
  strength_score double precision,
  last_interaction_at timestamptz,
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_people (
  id text primary key,
  full_name text,
  first_name text,
  last_name text,
  email text,
  phone text,
  company_id text references crm_companies(id) on delete set null,
  source_company_name text,
  company_domain text,
  job_title text,
  linkedin_url text,
  avatar_url text,
  contact_type text,
  buying_role text,
  market_role text,
  lifecycle_stage text,
  lead_status text,
  source text,
  strength_score double precision,
  last_interaction_at timestamptz,
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_email_threads (
  id text primary key,
  subject text,
  last_message_at timestamptz,
  message_count integer,
  gmail_thread_id text,
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_email_messages (
  id text primary key,
  thread_id text references crm_email_threads(id) on delete set null,
  subject text,
  sent_at timestamptz,
  from_person_id text references crm_people(id) on delete set null,
  body_preview text,
  body text,
  has_attachments boolean,
  gmail_message_id text,
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_calendar_events (
  id text primary key,
  title text,
  start_at timestamptz,
  end_at timestamptz,
  organizer_person_id text references crm_people(id) on delete set null,
  meeting_type text,
  google_event_id text,
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_objects (
  id text primary key,
  name text not null unique,
  entity_table text,
  description text,
  icon text,
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

create table if not exists crm_custom_field_values (
  object_id text not null references crm_objects(id) on delete cascade,
  entry_id text not null,
  field_id text not null references crm_fields(id) on delete cascade,
  text_value text,
  number_value double precision,
  boolean_value boolean,
  date_value timestamptz,
  json_value jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (entry_id, field_id)
);

create table if not exists crm_relation_links (
  object_id text not null references crm_objects(id) on delete cascade,
  field_id text not null references crm_fields(id) on delete cascade,
  source_entry_id text not null,
  target_entry_id text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (field_id, source_entry_id, target_entry_id)
);

create table if not exists crm_saved_views (
  id text primary key,
  object_id text not null references crm_objects(id) on delete cascade,
  name text not null,
  view_type text not null default 'table',
  filters jsonb,
  sort jsonb,
  columns jsonb,
  column_widths jsonb,
  settings jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (object_id, name)
);

create table if not exists crm_object_view_settings (
  object_id text primary key references crm_objects(id) on delete cascade,
  active_view_id text references crm_saved_views(id) on delete set null,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists crm_statuses (
  id text primary key default (gen_random_uuid()::text),
  object_id text not null references crm_objects(id) on delete cascade,
  name text not null,
  color text default '#94a3b8',
  sort_order integer default 0,
  is_default boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (object_id, name)
);

create table if not exists crm_documents (
  id text primary key default (gen_random_uuid()::text),
  title text default 'Untitled',
  icon text,
  cover_image text,
  file_path text not null unique,
  parent_id text references crm_documents(id),
  parent_object_id text references crm_objects(id),
  entry_id text,
  sort_order integer default 0,
  is_published boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists crm_action_runs (
  id text primary key default (gen_random_uuid()::text),
  action_id text not null,
  field_id text not null,
  entry_id text not null,
  object_id text not null references crm_objects(id) on delete cascade,
  status text not null default 'pending',
  started_at timestamptz default now(),
  completed_at timestamptz,
  result text,
  error text,
  stdout text,
  exit_code integer
);

create index if not exists crm_people_email_idx on crm_people (lower(email));
create index if not exists crm_people_company_idx on crm_people (company_id);
create index if not exists crm_people_last_interaction_idx on crm_people (last_interaction_at desc nulls last);
create index if not exists crm_companies_domain_idx on crm_companies (lower(domain));
create index if not exists crm_companies_name_idx on crm_companies (lower(name));
create index if not exists crm_email_messages_thread_sent_idx on crm_email_messages (thread_id, sent_at desc);
create index if not exists crm_custom_values_field_text_idx on crm_custom_field_values (field_id, text_value);
create index if not exists crm_custom_values_field_number_idx on crm_custom_field_values (field_id, number_value);
create index if not exists crm_custom_values_field_date_idx on crm_custom_field_values (field_id, date_value);
create index if not exists crm_relation_links_source_idx on crm_relation_links (field_id, source_entry_id);
create index if not exists crm_relation_links_target_idx on crm_relation_links (field_id, target_entry_id);
