-- Buyer outreach tier (Alex, 23 Nov 2026): ranks every buyer company for follow-ups and campaigns.
--   D1  transacted with us before
--   D2  full scope: replied to us, a contact, a location, and their volumes or proof they are reputable
--   D3  replied to us (email, meeting, call or WhatsApp), but we know less
--   D4  on our list with a contact and a location, never replied
--   NA  insufficient data (no contact or no location)
-- Key account (star) is hand-set only: a verified buyer able to transact over GBP 100k a year with us.
-- crm_refresh_buyer_outreach_tiers() recomputes the tier daily. A tier edited by hand is kept (outreach_tier_manual).
-- Separate from buyer_tier ("Priority", A/B/C), which matching and the inbox check sort by. Additive and idempotent.
begin;

alter table crm_companies add column if not exists outreach_tier text;
alter table crm_companies add column if not exists outreach_tier_reason text;
alter table crm_companies add column if not exists outreach_tier_manual boolean not null default false;
alter table crm_companies add column if not exists key_account boolean not null default false;

do $$ begin
  alter table crm_companies add constraint crm_companies_outreach_tier_check
    check (outreach_tier in ('D1', 'D2', 'D3', 'D4', 'NA'));
exception when duplicate_object then null; end $$;
create index if not exists crm_companies_outreach_tier_idx on crm_companies (outreach_tier) where outreach_tier is not null;

-- A hand edit of the tier sticks; clearing it by hand hands the row back to the daily rule.
create or replace function crm_outreach_tier_manual_edit() returns trigger language plpgsql as $$
begin
  if current_setting('rebattery.outreach_tier_refresh', true) is distinct from 'on'
     and new.outreach_tier is distinct from old.outreach_tier then
    new.outreach_tier_manual := new.outreach_tier is not null;
    new.outreach_tier_reason := case when new.outreach_tier is null then null
      else 'Set by hand on ' || to_char(now(), 'DD Mon YYYY') end;
  end if;
  return new;
end $$;
drop trigger if exists crm_outreach_tier_manual_edit on crm_companies;
create trigger crm_outreach_tier_manual_edit before update of outreach_tier on crm_companies
  for each row execute function crm_outreach_tier_manual_edit();

create or replace function crm_refresh_buyer_outreach_tiers() returns table (tier text, companies bigint)
language plpgsql as $$
begin
  perform set_config('rebattery.outreach_tier_refresh', 'on', true);

  drop table if exists outreach_tier_calc;
  create temp table outreach_tier_calc on commit drop as
  with pool as (
    select c.* from crm_companies c
    where coalesce(c.relationship_stage, '') <> 'Excluded'
      and coalesce(c.buyer_workstream_status, '') <> 'Excluded'
      and coalesce(c.domain, '') <> 'rebattery.io' and c.name <> 'ReBattery'
      and (
        upper(coalesce(c.platform_role, '')) = 'BUYER'
        or c.buyer_tier is not null
        or c.buyer_stage in ('Responded', 'In conversation', 'Qualified', 'Bidding', 'Customer')
        or (coalesce(c.platform_role, '') = '' and (
          c.buyer_stage is not null
          or exists (select 1 from buyer_interest i where i.company_id = c.id
                     and i.kind in ('ask', 'bought', 'interest', 'standing', 'saved_search'))
          or exists (select 1 from crm_bulk_offers o where o.company_id = c.id and o.role = 'counterparty')
          or exists (select 1 from crm_bulk_listings l where l.company_id = c.id and l.kind = 'demand')))
      )
  ), facts as (
    select p.id,
      coalesce(p.buyer_stage = 'Customer'
        or exists (select 1 from crm_bulk_offers o where o.company_id = p.id and o.role = 'counterparty'
                   and o.stage in ('signed', 'invoiced', 'paid', 'complete'))
        or exists (select 1 from crm_bulk_listings l where l.company_id = p.id and l.kind = 'demand'
                   and l.closed_reason = 'bought_from_us'), false) as transacted,
      exists (select 1 from crm_people pe where pe.company_id = p.id
              and (coalesce(pe.email, '') <> '' or coalesce(pe.phone, '') <> '')) as has_contact,
      coalesce(p.country, '') <> '' as has_location,
      coalesce(e.last_in_at is not null or coalesce(e.meetings, 0) > 0
        or p.buyer_stage in ('Responded', 'In conversation', 'Qualified', 'Bidding', 'Customer')
        or p.relationship_stage in ('Engaged', 'Active')
        or exists (select 1 from whatsapp_message m
                   join whatsapp_identity_link wl on wl.identity_id = m.sender_identity_id and wl.valid_to is null
                   left join crm_people wp on wp.id = wl.person_id
                   where m.direction = 'inbound' and coalesce(wl.company_id, wp.company_id) = p.id)
        or exists (select 1 from crm_bulk_listing_activity a join crm_people ap on ap.id = a.person_id
                   where ap.company_id = p.id and a.kind in ('whatsapp', 'call'))
        or exists (select 1 from crm_bulk_offers o where o.company_id = p.id
                   and o.last_touch_via ~* '(whatsapp|call|phone|meeting)')
        or exists (select 1 from buyer_interest i where i.company_id = p.id
                   and array_to_string(i.source_refs, ' ') like '%whatsapp:%'), false) as spoken,
      coalesce(exists (select 1 from buyer_interest i where i.company_id = p.id and i.quantity is not null)
        or exists (select 1 from crm_bulk_listings l where l.company_id = p.id and l.kind = 'demand')
        or coalesce(p.buyer_profile, '{}'::jsonb) ?| array['kwh_min', 'past_asks', 'kwh_by_format'], false) as volumes,
      coalesce(p.fit = 'High' or p.buyer_tier is not null
        or p.buyer_stage in ('Qualified', 'Bidding', 'Customer'), false) as reputable
    from pool p left join crm_buyer_engagement e on e.company_id = p.id
  )
  select f.id,
    case when transacted then 'D1'
         when spoken and has_contact and has_location and (volumes or reputable) then 'D2'
         when spoken then 'D3'
         when has_contact and has_location then 'D4'
         else 'NA' end as new_tier,
    case when transacted then 'Bought from us'
         else concat_ws('; ',
           nullif(concat_ws(', ', case when spoken then 'replied' end, case when has_contact then 'contact' end,
             case when has_location then 'location' end, case when volumes then 'volumes' end,
             case when reputable then 'reputable' end), ''),
           'missing ' || nullif(concat_ws(', ', case when not spoken then 'reply' end,
             case when not has_contact then 'contact' end, case when not has_location then 'location' end,
             case when not volumes then 'volumes' end, case when not reputable then 'reputable' end), ''))
    end as new_reason
  from facts f;

  update crm_companies c set outreach_tier = t.new_tier, outreach_tier_reason = t.new_reason
  from outreach_tier_calc t
  where c.id = t.id and not c.outreach_tier_manual
    and (c.outreach_tier is distinct from t.new_tier or c.outreach_tier_reason is distinct from t.new_reason);

  -- Left the buyer pool (excluded, relabelled): clear the automatic tier.
  update crm_companies c set outreach_tier = null, outreach_tier_reason = null
  where c.outreach_tier is not null and not c.outreach_tier_manual
    and not exists (select 1 from outreach_tier_calc t where t.id = c.id);

  perform set_config('rebattery.outreach_tier_refresh', 'off', true);
  return query select c.outreach_tier, count(*) from crm_companies c
    where c.outreach_tier is not null group by 1 order by 1;
end $$;

insert into crm_fields (id, object_id, name, type, canonical_column, description, enum_values, enum_colors, sort_order)
select v.id, o.id, v.name, v.type, v.col, v.descr, v.vals::jsonb, v.colors::jsonb, v.sort
from crm_objects o, (values
  ('fld_company_outreach_tier', 'Outreach Tier', 'enum', 'outreach_tier',
   'Buyer outreach tier, set daily by rule unless edited by hand: D1 bought from us; D2 replied, contact, location, and volumes or reputable; D3 replied; D4 contact and location, never replied; NA insufficient data.',
   '["D1", "D2", "D3", "D4", "NA"]', '["#16a34a", "#2563eb", "#7c3aed", "#94a3b8", "#e5e7eb"]', 4),
  ('fld_company_key_account', 'Key Account ★', 'boolean', 'key_account',
   'Hand-set: verified buyer able to transact over GBP 100k a year with us.', null, null, 5),
  ('fld_company_outreach_tier_reason', 'Tier Reason', 'text', 'outreach_tier_reason',
   'Why the buyer has its outreach tier: the facts we hold and what is missing.', null, null, 6)
) as v(id, name, type, col, descr, vals, colors, sort)
where o.name = 'company'
on conflict (object_id, name) do update set description = excluded.description, enum_values = excluded.enum_values,
  enum_colors = excluded.enum_colors, canonical_column = excluded.canonical_column, updated_at = now();

insert into crm_data_migrations (id) values ('128_buyer_outreach_tier') on conflict do nothing;

commit;
