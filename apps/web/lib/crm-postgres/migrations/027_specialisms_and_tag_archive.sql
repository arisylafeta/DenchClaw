-- Specialisms: everything a company does (multi-select), alongside Segment, which is its main business type.
-- Keeps the detail that type tags carried, e.g. a grid-scale developer that works with second-life batteries, a
-- dismantler that also trades batteries, or an EV converter that does golf carts.
-- Tag archive: every tag removed in the clean-up is recorded here first, so any removal can be restored.
-- Adds a column, a table and a field row only. Apply only after a current backup and explicit schema approval.
begin;

alter table crm_companies add column if not exists specialisms text[];

do $$ begin
  alter table crm_companies add constraint crm_companies_specialisms_check check (specialisms is null or specialisms <@ array[
    'Second-life batteries', 'Storage systems', 'Battery repair', 'Battery trading', 'Pack building', 'Cell distribution',
    'EV conversion', 'Golf cart / LSV', 'E-mobility', 'Industrial / forklift / marine', 'Dismantling / salvage',
    'Recycling', 'Battery manufacturing', 'Solar / off-grid']);
exception when duplicate_object then null;
end $$;

create index if not exists crm_companies_specialisms_idx on crm_companies using gin (specialisms);

insert into crm_fields (id, object_id, name, type, canonical_column, enum_values, enum_multiple, sort_order, description)
select 'fld_company_specialisms', o.id, 'Specialisms', 'enum', 'specialisms',
  '["Second-life batteries", "Storage systems", "Battery repair", "Battery trading", "Pack building", "Cell distribution", "EV conversion", "Golf cart / LSV", "E-mobility", "Industrial / forklift / marine", "Dismantling / salvage", "Recycling", "Battery manufacturing", "Solar / off-grid"]'::jsonb,
  true, 11, 'Everything the company does. Segment is the main one.'
from crm_objects o where o.name = 'company'
on conflict (object_id, name) do nothing;

create table if not exists crm_tag_archive (
  id bigserial primary key,
  object text not null check (object in ('company', 'people')),
  record_id text not null,
  tag text not null,
  reason text not null,
  batch text not null,
  archived_at timestamptz not null default now()
);
create index if not exists crm_tag_archive_record_idx on crm_tag_archive (object, record_id);
create index if not exists crm_tag_archive_batch_idx on crm_tag_archive (batch);

commit;
