-- One answer per question (CRM improvements v2, Alex 2026-10-01).
--   * Stage follows the Buyer tab's detailed Buyer Stage, so it is set in one place:
--       Identified -> New, Contacted -> Contacted, Responded / In conversation / Qualified -> Engaged,
--       Bidding / Customer -> Active.
--     Forward only (Stage is also moved by supply deals and sends), and an Excluded company is never moved.
--   * A company that gets a Purpose and has no Stage starts at New, whoever creates it.
--   * An intro or supply update send also moves a buyer's Buyer Stage from Identified (or empty) to Contacted.
--   * A company added as a dismantler gets Purpose Dismantler (Segment Salvage / dismantler when empty). A company on a
--     trade as supplier gets Purpose Supplier and Stage Active; one on a trade as buyer gets Purpose Buyer.
--   * Fields the classification replaced leave the Companies table, panels and filters: Buyer Category (Segment),
--     Sectors (Specialisms), Contact Person and Contact Person Title (Buyer Main Contact), Role Confidence and Role
--     Source. Only the field rows move to crm_fields_archive; the columns and their data stay, so any of them can be
--     restored by copying its row back. Platform Role and Roles stay until the Purpose column switch (028).
--   * Buyer Tier is renamed Priority (hand-set A/B/C) and Fit is renamed Research Fit, so the two are not confused.
-- Apply only after a current backup and explicit schema approval, together with the app build that saves the
-- tier as "Priority" (buyer-profile.ts).
begin;

create or replace function crm_apply_stage_rules() returns trigger language plpgsql as $$
declare
  ranks constant text[] := array['New', 'Contacted', 'Engaged', 'Active'];
  mapped text;
begin
  if new.relationship_stage is null and coalesce(cardinality(new.purpose), 0) > 0 then
    new.relationship_stage := 'New';
    new.relationship_stage_changed_on := current_date;
  end if;
  if tg_op = 'INSERT' or new.buyer_stage is distinct from old.buyer_stage then
    mapped := case new.buyer_stage
      when 'Identified' then 'New' when 'Contacted' then 'Contacted'
      when 'Responded' then 'Engaged' when 'In conversation' then 'Engaged' when 'Qualified' then 'Engaged'
      when 'Bidding' then 'Active' when 'Customer' then 'Active' end;
    if mapped is not null and coalesce(new.relationship_stage, '') <> 'Excluded'
       and coalesce(array_position(ranks, new.relationship_stage), 0) < array_position(ranks, mapped) then
      new.relationship_stage := mapped;
      new.relationship_stage_changed_on := current_date;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_crm_companies_stage_rules on crm_companies;
create trigger trg_crm_companies_stage_rules
  before insert or update on crm_companies
  for each row execute function crm_apply_stage_rules();

-- 026, plus the Buyer Stage step.
create or replace function crm_mark_campaign_send() returns trigger language plpgsql as $$
declare
  kind text;
  label text;
  sub_status text;
  company text;
begin
  if new.state <> 'accepted' or new.person_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.state = 'accepted' then
    return null;  -- already handled when it was first accepted
  end if;
  select type, campaign_name into kind, label from campaigns where id = new.campaign_id;
  if kind is null or kind not in ('supply_update', 'intro') then
    return null;
  end if;

  insert into crm_subscriptions (person_id, list, status, since, how)
  values (new.person_id, 'Supply update', 'Subscribed', coalesce(new.accepted_at, now())::date, 'Sent: ' || label)
  on conflict (person_id, list) do nothing;

  select status into sub_status from crm_subscriptions where person_id = new.person_id and list = 'Supply update';
  if sub_status = 'Subscribed' then
    update crm_people set tags = array(select distinct unnest(coalesce(tags, '{}') || array['Supply Update'])), updated_at = now()
    where id = new.person_id and not (coalesce(tags, '{}') @> array['Supply Update']);
  end if;

  company := coalesce(new.company_id, (select company_id from crm_people where id = new.person_id));
  if company is not null then
    update crm_companies set relationship_stage = 'Contacted', updated_at = now()
    where id = company and relationship_stage = 'New';
    update crm_companies set buyer_stage = 'Contacted', updated_at = now()
    where id = company and 'Buyer' = any(coalesce(purpose, '{}')) and coalesce(buyer_stage, 'Identified') = 'Identified';
  end if;
  return null;
end $$;

create or replace function crm_purpose_from_dismantler() returns trigger language plpgsql as $$
begin
  update crm_companies set purpose = array_append(coalesce(purpose, '{}'), 'Dismantler'),
    segment = coalesce(segment, 'Salvage / dismantler'), updated_at = now()
  where id = new.company_id and not ('Dismantler' = any(coalesce(purpose, '{}')));
  return null;
end $$;

drop trigger if exists trg_crm_dismantlers_purpose on crm_dismantlers;
create trigger trg_crm_dismantlers_purpose
  after insert or update of company_id on crm_dismantlers
  for each row execute function crm_purpose_from_dismantler();

create or replace function crm_purpose_from_trade_party() returns trigger language plpgsql as $$
begin
  if new.company_id is null then
    return null;
  end if;
  if new.role = 'supplier' then
    update crm_companies set
      purpose = case when 'Supplier' = any(coalesce(purpose, '{}')) then purpose else array_append(coalesce(purpose, '{}'), 'Supplier') end,
      relationship_stage = case when relationship_stage = 'Excluded' then relationship_stage else 'Active' end,
      updated_at = now()
    where id = new.company_id
      and (not ('Supplier' = any(coalesce(purpose, '{}'))) or coalesce(relationship_stage, '') not in ('Active', 'Excluded'));
  elsif new.role = 'buyer' then
    update crm_companies set purpose = array_append(coalesce(purpose, '{}'), 'Buyer'), updated_at = now()
    where id = new.company_id and not ('Buyer' = any(coalesce(purpose, '{}')));
  end if;
  return null;
end $$;

drop trigger if exists trg_crm_bulk_trade_parties_purpose on crm_bulk_trade_parties;
create trigger trg_crm_bulk_trade_parties_purpose
  after insert or update of company_id, role on crm_bulk_trade_parties
  for each row execute function crm_purpose_from_trade_party();

create table if not exists crm_fields_archive (like crm_fields);
alter table crm_fields_archive add column if not exists archived_at timestamptz not null default now();
alter table crm_fields_archive add column if not exists reason text;

with gone as (
  delete from crm_fields f using crm_objects o
  where o.id = f.object_id and o.name = 'company'
    and f.name in ('Buyer Category', 'Sectors', 'Contact Person', 'Contact Person Title', 'Role Confidence', 'Role Source')
  returning f.*
)
insert into crm_fields_archive
select gone.*, now(), case gone.name
  when 'Buyer Category' then 'Replaced by Segment'
  when 'Sectors' then 'Replaced by Specialisms'
  when 'Contact Person' then 'Replaced by Buyer Main Contact'
  when 'Contact Person Title' then 'Replaced by Buyer Main Contact'
  else 'Old enrichment metadata' end
from gone;

update crm_fields f set name = 'Priority', description = 'Hand-set priority of a known buyer: A (procurement desk), B, C.',
  updated_at = now()
from crm_objects o where o.id = f.object_id and o.name = 'company' and f.canonical_column = 'buyer_tier';
update crm_fields f set name = 'Research Fit', description = 'How well the company fits, judged from research.',
  updated_at = now()
from crm_objects o where o.id = f.object_id and o.name = 'company' and f.canonical_column = 'fit';

commit;
