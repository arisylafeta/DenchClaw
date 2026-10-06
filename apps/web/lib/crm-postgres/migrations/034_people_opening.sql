-- Full recipient introduction paragraphs. Values and campaign cohort selections
-- are separate approved data operations and must never be committed here.
begin;
set local lock_timeout = '5s';

alter table crm_people
  add column if not exists opening text;

insert into crm_fields (
  id, object_id, name, type, canonical_column, description, sort_order
)
select
  'field_people_opening', o.id, 'opening', 'text', 'opening',
  'Draft campaign introduction paragraph. Requires recipient and creative review before sending.',
  coalesce((select max(f.sort_order) from crm_fields f where f.object_id = o.id), -1) + 1
from crm_objects o
where o.name = 'people'
on conflict (object_id, name) do nothing;

do $$
begin
  if not exists (
    select 1 from crm_fields f
    join crm_objects o on o.id = f.object_id
    where o.name = 'people' and f.name = 'opening'
      and f.type = 'text' and f.canonical_column = 'opening'
  ) then
    raise exception 'People opening field must map to the opening text column';
  end if;
end
$$;

commit;
