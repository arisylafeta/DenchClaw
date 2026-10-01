-- Persist object-scoped views and seed broad, dynamically computed purpose filters.
-- Existing saved settings (including an intentionally empty views array) are never replaced.
begin;

-- Existing commercial role columns are schema authority for derived purpose.
alter table crm_companies
  add column if not exists platform_role text,
  add column if not exists roles text[];

create table if not exists crm_object_views (
  object_id text primary key references crm_objects(id) on delete cascade,
  views jsonb not null default '[]'::jsonb,
  active_view text,
  view_settings jsonb,
  updated_at timestamptz not null default now(),
  constraint crm_object_views_array_check check (
    jsonb_typeof(views) = 'array'
    and not jsonb_path_exists(views, '$[*] ? (@.type() != "object" || !exists(@.name) || @.name.type() != "string")')
  ),
  constraint crm_object_views_settings_check check (
    view_settings is null or jsonb_typeof(view_settings) = 'object'
  ),
  constraint crm_object_views_active_check check (
    active_view is null or views @> jsonb_build_array(jsonb_build_object('name', active_view))
  )
);

insert into crm_object_views (object_id, views, active_view)
select id, '[
  {"name":"Buyers","view_type":"table","filters":{"id":"root","conjunction":"and","rules":[{"id":"purpose","field":"Purpose","operator":"is_any_of","value":["Buyer"]}]}},
  {"name":"Dismantlers","view_type":"table","filters":{"id":"root","conjunction":"and","rules":[{"id":"purpose","field":"Purpose","operator":"is_any_of","value":["Dismantler"]}]}}
]'::jsonb, 'Buyers'
from crm_objects
where name in ('company', 'people')
on conflict (object_id) do nothing;

commit;
