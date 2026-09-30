begin;

-- Dismantlers: ATFs, breakers and dismantlers we want supplying through ReBattery.
-- One row per dismantler, and every dismantler is a CRM company (its name is the
-- company's name). The Dismantlers screen reads and writes these through
-- /api/dismantlers; every change is logged in crm_dismantler_events.

create table if not exists crm_dismantlers (
  id text primary key default ('dm_' || gen_random_uuid()),
  company_id text not null unique references crm_companies(id) on delete restrict,
  stage text not null default 'Found'
    check (stage in ('Found', 'Contacted', 'Onboarding', 'Live', 'Syncing', 'Parked')),
  stage_since date not null default current_date,
  parked_from text check (parked_from in ('Found', 'Contacted', 'Onboarding', 'Live', 'Syncing')),
  park_reason text,
  revisit_on date,
  next_step text,
  next_step_due date,
  next_step_person_id text references crm_people(id) on delete set null,
  waiting_on text not null default 'us' check (waiting_on in ('us', 'them')),
  waiting_since date,
  owner_user_id uuid references crm_users(id) on delete set null,
  goal boolean not null default false,
  route text check (route in ('eBay', 'API', 'Other')),
  country text,
  ebay_username text,
  ebay_listings integer check (ebay_listings >= 0),
  platform_account_id text,
  source text,
  notes text,
  -- Setup checklist: the date each step happened.
  setup_account_on date,
  setup_route_on date,
  setup_connected_on date,
  setup_first_stock_on date,
  setup_first_sync_on date,
  setup_second_sync_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_dismantlers_stage_due_idx on crm_dismantlers(stage, next_step_due);

-- Append-only history: stage moves, next steps, setup ticks.
create table if not exists crm_dismantler_events (
  id bigserial primary key,
  dismantler_id text not null references crm_dismantlers(id) on delete cascade,
  kind text not null,
  changes jsonb not null default '{}'::jsonb,
  actor_user_id uuid references crm_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists crm_dismantler_events_dismantler_idx on crm_dismantler_events(dismantler_id, id);

create or replace function crm_dismantler_events_append_only()
returns trigger
language plpgsql
as $$
begin
  -- Deleting a dismantler removes its history with it; nothing else rewrites history.
  if tg_op = 'DELETE' and not exists (select 1 from crm_dismantlers where id = old.dismantler_id) then
    return old;
  end if;
  -- Deleting a CRM user clears their name from history (on delete set null); nothing else changes.
  if tg_op = 'UPDATE' and new.actor_user_id is null and old.actor_user_id is not null
     and (new.dismantler_id, new.kind, new.changes, new.created_at) = (old.dismantler_id, old.kind, old.changes, old.created_at) then
    return new;
  end if;
  raise exception 'crm_dismantler_events is append-only';
end;
$$;

drop trigger if exists crm_dismantler_events_append_only_trigger on crm_dismantler_events;
create trigger crm_dismantler_events_append_only_trigger
  before update or delete on crm_dismantler_events
  for each row execute function crm_dismantler_events_append_only();

-- Sidebar entry. The workspace shows the Dismantlers screen for this object instead
-- of the generic table, and generic edits are refused (immutable).
insert into crm_objects
  (id, name, entity_table, description, default_view, immutable, hidden_in_sidebar, sort_order)
values
  ('reb_dismantler_object', 'dismantler', 'crm_dismantlers',
   'ATFs, breakers and dismantlers, from first found to syncing stock with ReBattery',
   'table', true, false, 3)
on conflict (name) do update set
  entity_table = excluded.entity_table,
  description = excluded.description,
  immutable = excluded.immutable,
  hidden_in_sidebar = excluded.hidden_in_sidebar,
  sort_order = excluded.sort_order,
  updated_at = now();

commit;
