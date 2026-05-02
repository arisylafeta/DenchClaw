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

create table if not exists crm_commercial_profiles (
  id text primary key,
  company_id text not null references crm_companies(id) on delete cascade,
  contact_person_id text references crm_people(id) on delete set null,
  profile_type text not null check (profile_type in ('buyer_demand', 'seller_supply', 'recycler_intake')),
  status text not null default 'unverified' check (status in ('active', 'paused', 'unverified', 'archived')),
  battery_types text[] not null default '{}',
  previous_applications text[] not null default '{}',
  chemistries text[] not null default '{}',
  conditions text[] not null default '{}',
  formats text[] not null default '{}',
  specific_types text[] not null default '{}',
  soh_floor numeric(5,2),
  volume_min numeric(12,2),
  volume_max numeric(12,2),
  geographies text[] not null default '{}',
  preferred_outcome text,
  notes text,
  source text,
  last_verified_at timestamptz,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_commercial_profiles_soh_floor_check check (soh_floor is null or (soh_floor >= 0 and soh_floor <= 100)),
  constraint crm_commercial_profiles_volume_check check (
    (volume_min is null or volume_min >= 0)
    and (volume_max is null or volume_max >= 0)
    and (volume_min is null or volume_max is null or volume_min <= volume_max)
  )
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
  quantity numeric(12,2),
  soh numeric(5,2),
  pack_kwh numeric(12,3),
  location_country text,
  location_region text,
  available_from timestamptz,
  deadline_at timestamptz,
  price_amount numeric(12,2),
  currency text,
  urgency text not null default 'medium' check (urgency in ('low', 'medium', 'high', 'critical')),
  priority_score numeric(8,2),
  notes text,
  raw_json jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_commercial_opportunities_quantity_check check (quantity is null or quantity >= 0),
  constraint crm_commercial_opportunities_soh_check check (soh is null or (soh >= 0 and soh <= 100)),
  constraint crm_commercial_opportunities_pack_kwh_check check (pack_kwh is null or pack_kwh >= 0),
  constraint crm_commercial_opportunities_price_amount_check check (price_amount is null or price_amount >= 0),
  constraint crm_commercial_opportunities_priority_score_check check (priority_score is null or priority_score >= 0)
);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_crm_commercial_profiles_set_updated_at on crm_commercial_profiles;
create trigger trg_crm_commercial_profiles_set_updated_at
before update on crm_commercial_profiles
for each row
execute function set_updated_at();

drop trigger if exists trg_crm_commercial_opportunities_set_updated_at on crm_commercial_opportunities;
create trigger trg_crm_commercial_opportunities_set_updated_at
before update on crm_commercial_opportunities
for each row
execute function set_updated_at();

create or replace view crm_company_commercial_summary_v as
with profile_stats as (
  select
    cp.company_id,
    count(*) filter (where cp.status = 'active') as active_profile_count,
    count(*) filter (where cp.status = 'active' and cp.profile_type = 'buyer_demand') as buyer_profile_count,
    count(*) filter (where cp.status = 'active' and cp.profile_type = 'seller_supply') as supplier_profile_count,
    count(*) filter (where cp.status = 'active' and cp.profile_type = 'recycler_intake') as recycler_profile_count,
    max(cp.last_verified_at) as latest_profile_verified_at
  from crm_commercial_profiles cp
  group by cp.company_id
),
opportunity_stats as (
  select
    co.company_id,
    count(*) filter (where co.status = 'open' and co.opportunity_type = 'supply') as open_supply_count,
    count(*) filter (where co.status = 'open' and co.opportunity_type = 'demand') as open_demand_count,
    count(*) filter (
      where co.status = 'open'
        and co.opportunity_type = 'supply'
        and (co.urgency in ('high', 'critical') or (co.deadline_at is not null and co.deadline_at <= now() + interval '14 days'))
    ) as urgent_supply_count,
    count(*) filter (
      where co.status = 'open'
        and co.opportunity_type = 'demand'
        and (co.urgency in ('high', 'critical') or (co.deadline_at is not null and co.deadline_at <= now() + interval '14 days'))
    ) as urgent_demand_count,
    max(co.available_from) filter (where co.opportunity_type = 'supply') as latest_supply_at,
    max(co.available_from) filter (where co.opportunity_type = 'demand') as latest_demand_at,
    min(co.deadline_at) filter (where co.status = 'open' and co.deadline_at is not null) as next_deadline_at,
    max(co.priority_score) filter (where co.status = 'open') as max_open_priority_score
  from crm_commercial_opportunities co
  group by co.company_id
)
select
  c.id as company_id,
  coalesce(ps.active_profile_count, 0) as active_profile_count,
  coalesce(ps.buyer_profile_count, 0) as buyer_profile_count,
  coalesce(ps.supplier_profile_count, 0) as supplier_profile_count,
  coalesce(ps.recycler_profile_count, 0) as recycler_profile_count,
  coalesce(os.open_supply_count, 0) as open_supply_count,
  coalesce(os.open_demand_count, 0) as open_demand_count,
  coalesce(os.urgent_supply_count, 0) as urgent_supply_count,
  coalesce(os.urgent_demand_count, 0) as urgent_demand_count,
  ps.latest_profile_verified_at,
  os.latest_supply_at,
  os.latest_demand_at,
  os.next_deadline_at,
  case
    when coalesce(os.open_supply_count, 0) > 0 and coalesce(os.open_demand_count, 0) > 0 then 'supply_and_demand'
    when coalesce(os.open_supply_count, 0) > 0 then 'active_supply'
    when coalesce(os.open_demand_count, 0) > 0 then 'active_demand'
    when coalesce(ps.active_profile_count, 0) > 0 then 'profile_only'
    else 'inactive'
  end as commercial_status,
  (
    coalesce(os.max_open_priority_score, 0)
    + ((coalesce(os.urgent_supply_count, 0) + coalesce(os.urgent_demand_count, 0)) * 10)
    + coalesce(os.open_supply_count, 0)
    + coalesce(os.open_demand_count, 0)
  )::numeric(10,2) as commercial_priority_score
from crm_companies c
left join profile_stats ps on ps.company_id = c.id
left join opportunity_stats os on os.company_id = c.id;

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
create index if not exists idx_crm_commercial_profiles_company_id on crm_commercial_profiles (company_id);
create index if not exists idx_crm_commercial_profiles_type_status on crm_commercial_profiles (profile_type, status);
create index if not exists idx_crm_commercial_opportunities_company_id on crm_commercial_opportunities (company_id);
create index if not exists idx_crm_commercial_opportunities_type_status on crm_commercial_opportunities (opportunity_type, status);
create index if not exists idx_crm_commercial_opportunities_source on crm_commercial_opportunities (source_system, source_id) where source_id is not null;
create index if not exists idx_crm_commercial_opportunities_deadline on crm_commercial_opportunities (deadline_at) where status = 'open' and deadline_at is not null;
