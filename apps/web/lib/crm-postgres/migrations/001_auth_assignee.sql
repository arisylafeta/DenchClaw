begin;

create extension if not exists pgcrypto;

create table if not exists crm_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  password_hash text not null,
  is_active boolean not null default true,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table crm_users add column if not exists display_name text;
update crm_users
set display_name = case
  when email = 'ari@rebattery.io' then 'Ari'
  when email = 'alex@rebattery.io' then 'Alex'
  else email
end
where display_name is null;
alter table crm_users alter column display_name set default '';
alter table crm_users alter column display_name set not null;

create table if not exists crm_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references crm_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table work_tasks
  add column if not exists assignee_id uuid references crm_users(id) on delete set null;
create index if not exists crm_sessions_active_idx
  on crm_sessions(token_hash, expires_at) where revoked_at is null;
create index if not exists work_tasks_assignee_idx on work_tasks(assignee_id);

insert into crm_objects (
  id, name, entity_table, description, display_field, immutable, hidden_in_sidebar
)
values (
  'reb_work_task_object', 'work_task', 'work_tasks', 'ReBattery Work Tasks', 'Title', false, false
)
on conflict (name) do update
set entity_table = excluded.entity_table;

insert into crm_objects (
  id, name, entity_table, description, display_field, immutable, hidden_in_sidebar
)
values (
  'crm_users_object', 'crm_user', 'crm_users', 'Invite-only CRM users', 'Name', true, true
)
on conflict (name) do update
set entity_table = excluded.entity_table,
    display_field = excluded.display_field,
    immutable = true,
    hidden_in_sidebar = true;

insert into crm_fields (
  id, object_id, name, type, canonical_column, related_object_id, relationship_type, sort_order
)
select
  'reb_work_task_assignee', task_object.id, 'Assignee', 'relation', 'assignee_id',
  user_object.id, 'many_to_one', 6
from crm_objects task_object
cross join crm_objects user_object
where task_object.name = 'work_task' and user_object.name = 'crm_user'
on conflict (object_id, name) do update
set canonical_column = excluded.canonical_column,
    related_object_id = excluded.related_object_id,
    relationship_type = excluded.relationship_type,
    sort_order = excluded.sort_order;

update crm_fields
set sort_order = 7
where object_id = (select id from crm_objects where name = 'work_task')
  and name = 'Task Details';

insert into crm_fields (id, object_id, name, type, canonical_column, sort_order)
select 'crm_user_name_field', object.id, 'Name', 'text', 'display_name', 0
from crm_objects object
where object.name = 'crm_user'
on conflict (object_id, name) do update
set canonical_column = excluded.canonical_column,
    sort_order = excluded.sort_order;

insert into crm_fields (id, object_id, name, type, canonical_column, sort_order)
select 'crm_user_email_field', object.id, 'Email', 'email', 'email', 1
from crm_objects object
where object.name = 'crm_user'
on conflict (object_id, name) do update
set canonical_column = excluded.canonical_column,
    sort_order = excluded.sort_order;

commit;
