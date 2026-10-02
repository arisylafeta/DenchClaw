-- Temporary membership for the reviewed 2 October intro audience.
-- CSV membership and saved-view creation are separate approved data operations;
-- customer IDs and recipient data must not be committed in this migration.
begin;
set local lock_timeout = '5s';

alter table crm_people
  add column if not exists intro_audience_20261002 boolean not null default false;

insert into crm_fields (
  id, object_id, name, type, canonical_column, description, sort_order
)
select
  'field_people_intro_audience_20261002', id, 'Intro audience 2 Oct', 'boolean',
  'intro_audience_20261002',
  'Temporary membership of the reviewed 2 October 2026 intro CSV. Not a subscription, send approval or contact Stage.',
  11
from crm_objects
where name = 'people'
on conflict (object_id, name) do nothing;

commit;
