-- CRM classification v1: one field per question, each with fixed values.
--   Purpose (what they are to us), Segment (what they do), Stage (where we are with them), Source, Region, Fit,
--   plus per-person subscriptions to our mailing lists.
-- Adds columns, a table, views and field rows only; nothing is removed or renamed. The old fields (platform_role,
-- roles, buyer_category, buyer_stage, buyer_workstream_status, classification tags) stay until the fill script has
-- copied them across and both founders have checked the result.
-- Purpose is stored but not registered as a field yet: Ari's computed "Purpose" field keeps working until it is
-- switched to read this column.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_companies
  add column if not exists purpose text[],
  add column if not exists segment text,
  add column if not exists relationship_stage text,
  add column if not exists relationship_stage_changed_on date,
  add column if not exists source text,
  add column if not exists source_detail text,
  add column if not exists region text,
  add column if not exists state text,
  add column if not exists fit text;

do $$ begin
  alter table crm_companies add constraint crm_companies_purpose_check check (
    purpose is null or purpose <@ array['Buyer', 'Supplier', 'Dismantler', 'Recycler', 'Partner', 'Investor', 'Service provider']);
  alter table crm_companies add constraint crm_companies_segment_check check (segment in (
    'Battery repair', 'EV conversion', 'Pack builder', 'Second-life storage', 'Storage integrator', 'Grid-scale developer',
    'Solar / off-grid', 'Trader / broker', 'Cell distributor', 'Salvage / dismantler', 'Recycler', 'E-mobility',
    'Industrial / marine', 'Utility', 'OEM / fleet', 'Other'));
  alter table crm_companies add constraint crm_companies_relationship_stage_check check (relationship_stage in (
    'New', 'Contacted', 'Engaged', 'Active', 'Nurture', 'Paused', 'Excluded'));
  alter table crm_companies add constraint crm_companies_source_check check (source in (
    'Email mining', 'WhatsApp', 'Survey', 'Inbound', 'Web research', 'Buyer discovery', 'Apollo', 'Supabase import',
    'Event', 'Referral', 'Other'));
  alter table crm_companies add constraint crm_companies_region_check check (region in (
    'UK', 'EU-West', 'CEE', 'Nordics', 'US', 'Canada', 'LatAm', 'Africa', 'Middle East', 'Asia-Pacific'));
  alter table crm_companies add constraint crm_companies_fit_check check (fit in ('High', 'Medium', 'Low'));
exception when duplicate_object then null;
end $$;

create index if not exists crm_companies_purpose_idx on crm_companies using gin (purpose);
create index if not exists crm_companies_relationship_stage_idx on crm_companies (relationship_stage) where relationship_stage is not null;

-- Stage date, like buyer_stage_changed_on.
create or replace function crm_stamp_buyer_stage() returns trigger language plpgsql as $$
begin
  if new.buyer_stage is distinct from old.buyer_stage then
    new.buyer_stage_changed_on := current_date;
  end if;
  if new.relationship_stage is distinct from old.relationship_stage then
    new.relationship_stage_changed_on := current_date;
  end if;
  return new;
end $$;

-- The change log also records purpose, segment, stage and fit.
create or replace function crm_log_buyer_profile_change() returns trigger language plpgsql as $$
declare
  key text;
  before jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  after jsonb := to_jsonb(new);
begin
  for key in select k from jsonb_object_keys(after) k
             where (k like 'buyer\_%' and k <> 'buyer_stage_changed_on')
                or k in ('purpose', 'segment', 'relationship_stage', 'fit') loop
    if coalesce(before -> key, 'null'::jsonb) is distinct from after -> key then
      insert into crm_buyer_profile_changes (company_id, field, old_value, new_value)
      values (new.id, key, nullif(before -> key, 'null'::jsonb), nullif(after -> key, 'null'::jsonb));
    end if;
  end loop;
  return null;
end $$;

-- One row per person per list. No row means not asked.
create table if not exists crm_subscriptions (
  person_id text not null references crm_people(id) on delete cascade,
  list text not null check (list in ('Supply update', 'Newsletter', 'Dismantler campaigns', 'Investor updates')),
  status text not null check (status in ('Subscribed', 'Opted out')),
  since date not null default current_date,
  how text,
  note text,
  updated_at timestamptz not null default now(),
  primary key (person_id, list)
);

-- Who gets the supply update: subscribed, has an email, not opted out of email altogether.
create or replace view crm_supply_update_list as
select p.id as person_id, lower(p.email) as email, p.full_name, p.first_name, c.id as company_id, c.name as company,
       c.country, c.region, s.since, s.how
from crm_subscriptions s
join crm_people p on p.id = s.person_id
left join crm_companies c on c.id = p.company_id
where s.list = 'Supply update' and s.status = 'Subscribed'
  and p.email is not null and not coalesce(p.email_opted_out, false);

-- Campaign activity per person, from the campaign send ledger.
create or replace view crm_person_campaign_activity as
select person_id,
       count(*) as campaigns_sent,
       max(coalesce(delivered_at, accepted_at, created_at)) as last_sent_at,
       max(provider_opened_at) as last_opened_at,
       max(provider_link_clicked_at) as last_clicked_at,
       count(provider_opened_at) as campaigns_opened,
       count(provider_link_clicked_at) as campaigns_clicked
from crm_campaign_sends
where person_id is not null
group by person_id;

insert into crm_fields (id, object_id, name, type, canonical_column, enum_values, enum_multiple, sort_order, description)
select 'fld_company_' || v.col, o.id, v.name, v.type, v.col, v.enum_values::jsonb, false, v.sort_order, v.description
from crm_objects o, (values
  ('relationship_stage', 'Stage', 'enum',
   '["New", "Contacted", "Engaged", "Active", "Nurture", "Paused", "Excluded"]', 10,
   'Where we are with them, for any purpose: New, Contacted, Engaged, Active (trading), Nurture, Paused or Excluded.'),
  ('segment', 'Segment', 'enum',
   '["Battery repair", "EV conversion", "Pack builder", "Second-life storage", "Storage integrator", "Grid-scale developer", "Solar / off-grid", "Trader / broker", "Cell distributor", "Salvage / dismantler", "Recycler", "E-mobility", "Industrial / marine", "Utility", "OEM / fleet", "Other"]', 11,
   'What the company does.'),
  ('region', 'Region', 'enum',
   '["UK", "EU-West", "CEE", "Nordics", "US", "Canada", "LatAm", "Africa", "Middle East", "Asia-Pacific"]', 12, null),
  ('state', 'State', 'text', null, 13, 'State or province, e.g. CA for California.'),
  ('fit', 'Fit', 'enum', '["High", "Medium", "Low"]', 14, 'How well they fit what we sell.'),
  ('source', 'Source', 'enum',
   '["Email mining", "WhatsApp", "Survey", "Inbound", "Web research", "Buyer discovery", "Apollo", "Supabase import", "Event", "Referral", "Other"]', 15,
   'How the company came into the CRM.'),
  ('source_detail', 'Source Detail', 'text', null, 16, 'The batch or campaign, e.g. CEE research 2026-10.')
) as v(col, name, type, enum_values, sort_order, description)
where o.name = 'company'
on conflict (object_id, name) do nothing;

commit;
