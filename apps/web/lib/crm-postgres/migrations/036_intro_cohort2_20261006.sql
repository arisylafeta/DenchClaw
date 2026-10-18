-- Temporary membership for the second intro batch (6 October 2026).
-- Membership and the saved view are separate approved data operations;
-- customer IDs must not be committed in this migration.
begin;
set local lock_timeout = '5s';

alter table crm_people
  add column if not exists intro_cohort2_20261006 boolean not null default false;

insert into crm_fields (
  id, object_id, name, type, canonical_column, description, sort_order
)
select
  'field_people_intro_cohort2_20261006', id, 'Intro cohort 2', 'boolean',
  'intro_cohort2_20261006',
  'Temporary membership of the second intro batch of 6 October 2026. Not a subscription, send approval or contact Stage.',
  12
from crm_objects
where name = 'people'
on conflict (object_id, name) do nothing;

commit;
