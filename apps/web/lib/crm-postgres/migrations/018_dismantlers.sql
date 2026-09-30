begin;

-- Dismantlers: ATFs, breakers and dismantlers we want supplying through ReBattery.
-- One row per dismantler, and every row is a CRM company. The tab is a generic
-- CRM object, so Board, List and Table views come from the workspace with no
-- custom screens or API routes.

create table if not exists crm_dismantlers (
  id text primary key default gen_random_uuid()::text,
  name text,
  company_id text not null unique references crm_companies(id) on delete restrict,
  stage text not null default 'Found',
  stage_since date not null default current_date,
  next_step text,
  next_step_due date,
  owner_id uuid references crm_users(id) on delete set null,
  route text,
  country text,
  ebay_username text,
  platform_account_id text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_dismantlers_stage_due_idx
  on crm_dismantlers(stage, next_step_due);

-- Keeps the "every dismantler is a CRM company" rule, whichever way a row is made:
-- a row with only a name links the one company of that name or creates it;
-- a row with only a company takes the company's name.
create or replace function crm_dismantlers_link_company()
returns trigger
language plpgsql
as $$
declare
  matches text[];
begin
  new.name := nullif(btrim(coalesce(new.name, '')), '');
  if new.company_id is null then
    if new.name is null then
      raise exception 'A dismantler needs a name or a company';
    end if;
    select array_agg(id) into matches
      from crm_companies where lower(btrim(name)) = lower(new.name);
    if coalesce(array_length(matches, 1), 0) > 1 then
      raise exception 'Several CRM companies are called "%". Pick the right one in Company.', new.name;
    end if;
    new.company_id := coalesce(matches[1], gen_random_uuid()::text);
    if matches is null then
      insert into crm_companies (id, name) values (new.company_id, new.name);
    end if;
  end if;
  if new.name is null then
    select name into new.name from crm_companies where id = new.company_id;
  end if;
  update crm_companies
     set tags = array_append(coalesce(tags, '{}'), 'dismantler'), updated_at = now()
   where id = new.company_id and not ('dismantler' = any(coalesce(tags, '{}')));
  if tg_op = 'UPDATE' then
    if new.stage is distinct from old.stage then
      new.stage_since := current_date;
    end if;
    if new.company_id is distinct from old.company_id then
      update crm_companies set tags = array_remove(tags, 'dismantler'), updated_at = now()
       where id = old.company_id;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists crm_dismantlers_link_company_trigger on crm_dismantlers;
create trigger crm_dismantlers_link_company_trigger
  before insert or update on crm_dismantlers
  for each row execute function crm_dismantlers_link_company();

create or replace function crm_dismantlers_untag_company()
returns trigger
language plpgsql
as $$
begin
  update crm_companies set tags = array_remove(tags, 'dismantler'), updated_at = now()
   where id = old.company_id;
  return old;
end;
$$;

drop trigger if exists crm_dismantlers_untag_company_trigger on crm_dismantlers;
create trigger crm_dismantlers_untag_company_trigger
  after delete on crm_dismantlers
  for each row execute function crm_dismantlers_untag_company();

-- The Company field needs a company object to point at. Production already has
-- one; this only covers a fresh database.
insert into crm_objects (id, name, entity_table, description, display_field, hidden_in_sidebar)
values ('reb_company_object', 'company', 'crm_companies', 'CRM companies', 'Name', true)
on conflict (name) do nothing;

insert into crm_objects
  (id, name, entity_table, description, default_view, display_field, sort_order)
values
  ('reb_dismantler_object', 'dismantler', 'crm_dismantlers',
   'ATFs, breakers and dismantlers, from first found to syncing stock with ReBattery',
   'kanban', 'Name', 3)
on conflict (name) do update set
  entity_table = excluded.entity_table,
  description = excluded.description,
  default_view = excluded.default_view,
  display_field = excluded.display_field,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into crm_fields (id, object_id, name, type, canonical_column, enum_values, enum_colors, sort_order) values
  ('reb_dismantler_fld_name', 'reb_dismantler_object', 'Name', 'text', 'name', null, null, 0),
  ('reb_dismantler_fld_stage', 'reb_dismantler_object', 'Stage', 'enum', 'stage',
   '["Found", "Contacted", "Onboarding", "Live", "Syncing", "Parked"]',
   '["#94a3b8", "#60a5fa", "#f59e0b", "#22c55e", "#15803d", "#a8a29e"]', 1),
  ('reb_dismantler_fld_next_step', 'reb_dismantler_object', 'Next step', 'text', 'next_step', null, null, 3),
  ('reb_dismantler_fld_next_step_due', 'reb_dismantler_object', 'Next step due', 'date', 'next_step_due', null, null, 4),
  ('reb_dismantler_fld_route', 'reb_dismantler_object', 'Route', 'enum', 'route',
   '["eBay", "API", "Other"]', null, 6),
  ('reb_dismantler_fld_country', 'reb_dismantler_object', 'Country', 'text', 'country', null, null, 7),
  ('reb_dismantler_fld_ebay', 'reb_dismantler_object', 'eBay username', 'text', 'ebay_username', null, null, 8),
  ('reb_dismantler_fld_platform', 'reb_dismantler_object', 'Platform account', 'text', 'platform_account_id', null, null, 9),
  ('reb_dismantler_fld_stage_since', 'reb_dismantler_object', 'In stage since', 'date', 'stage_since', null, null, 10),
  ('reb_dismantler_fld_notes', 'reb_dismantler_object', 'Notes', 'text', 'notes', null, null, 11)
on conflict (object_id, name) do update set
  type = excluded.type,
  canonical_column = excluded.canonical_column,
  enum_values = excluded.enum_values,
  enum_colors = excluded.enum_colors,
  sort_order = excluded.sort_order;

insert into crm_fields (id, object_id, name, type, canonical_column, related_object_id, relationship_type, sort_order)
select 'reb_dismantler_fld_company', 'reb_dismantler_object', 'Company', 'relation', 'company_id', c.id, 'many_to_one', 2
  from crm_objects c where c.name = 'company'
union all
select 'reb_dismantler_fld_owner', 'reb_dismantler_object', 'Owner', 'relation', 'owner_id', u.id, 'many_to_one', 5
  from crm_objects u where u.name = 'crm_user'
on conflict (object_id, name) do update set
  canonical_column = excluded.canonical_column,
  related_object_id = excluded.related_object_id,
  relationship_type = excluded.relationship_type,
  sort_order = excluded.sort_order;

commit;
