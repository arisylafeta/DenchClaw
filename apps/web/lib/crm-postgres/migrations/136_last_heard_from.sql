-- Last heard from (25 Nov 2026): when each company last made contact with us, and how many days ago.
--   last_heard_from_on: latest inbound signal = inbound email, meeting, campaign click, auction view/offer, bid
--   (crm_buyer_engagement.last_heard_at) or an inbound WhatsApp message. Blank = never heard from.
--   days_since_heard_from: whole days since then, recomputed by crm_refresh_last_heard(), which the daily
--   crm_refresh_buyer_outreach_tiers() call runs (05:30 UTC). Additive and idempotent.
begin;

alter table crm_companies add column if not exists last_heard_from_on date;
alter table crm_companies add column if not exists days_since_heard_from integer;

create or replace function crm_refresh_last_heard() returns void language plpgsql as $f$
begin
  perform set_config('rebattery.last_heard_refresh', 'on', true);
  with wa as (
    select coalesce(wl.company_id, wp.company_id) company_id, max(m.occurred_at) last_wa
    from whatsapp_message m
    join whatsapp_identity_link wl on wl.identity_id = m.sender_identity_id and wl.valid_to is null
    left join crm_people wp on wp.id = wl.person_id
    where m.direction = 'inbound' and m.deleted_at is null
    group by 1
  ), calc as (
    select c.id, (greatest(e.last_heard_at, wa.last_wa) at time zone 'UTC')::date as d
    from crm_companies c
    left join crm_buyer_engagement e on e.company_id = c.id
    left join wa on wa.company_id = c.id
  )
  update crm_companies c set last_heard_from_on = calc.d,
    days_since_heard_from = case when calc.d is null then null else greatest(current_date - calc.d, 0) end
  from calc
  where c.id = calc.id
    and (c.last_heard_from_on is distinct from calc.d
      or c.days_since_heard_from is distinct from case when calc.d is null then null else greatest(current_date - calc.d, 0) end);
end $f$;

CREATE OR REPLACE FUNCTION public.crm_refresh_buyer_outreach_tiers()
 RETURNS TABLE(tier text, companies bigint)
 LANGUAGE plpgsql
AS $tier$
begin
  perform set_config('rebattery.outreach_tier_refresh', 'on', true);

  drop table if exists outreach_tier_calc;
  create temp table outreach_tier_calc on commit drop as
  with pool as (
    select c.*, (coalesce(c.relationship_stage, '') = 'Excluded'
                 or coalesce(c.buyer_workstream_status, '') = 'Excluded') as is_excluded
    from crm_companies c
    where coalesce(c.domain, '') <> 'rebattery.io' and c.name <> 'ReBattery'
      and (
        c.customer
        or crm_company_is_buyer_purpose(c)
        or upper(coalesce(c.platform_role, '')) = 'BUYER'
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
    select p.id, p.is_excluded,
      coalesce(p.customer or p.buyer_stage = 'Customer'
        or exists (select 1 from crm_bulk_offers o where o.company_id = p.id and o.role = 'counterparty'
                   and o.stage in ('signed', 'invoiced', 'paid', 'complete'))
        or exists (select 1 from crm_bulk_listings l where l.company_id = p.id and l.kind = 'demand'
                   and l.closed_reason = 'bought_from_us')
        or exists (select 1 from crm_bulk_listings l join crm_bulk_offers o on o.bulk_listing_id = l.id
                   where l.kind = 'supply' and l.company_id = p.id and o.role = 'counterparty'
                   and o.stage in ('signed', 'invoiced', 'paid', 'complete')), false) as transacted,
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
                   and array_to_string(i.source_refs, ' ') like '%whatsapp:%'), false) as spoken
    from pool p left join crm_buyer_engagement e on e.company_id = p.id
  )
  select f.id,
    case when transacted then 'D1'
         when is_excluded then 'D5'
         when spoken and has_contact and has_location then 'D2'
         when spoken then 'D3'
         when has_contact and has_location then 'D4'
         else 'D5' end as new_tier,
    case when transacted then 'Customer: transacted with us'
         when is_excluded then 'Excluded from outreach'
         else concat_ws('; ',
           nullif(concat_ws(', ', case when spoken then 'replied' end, case when has_contact then 'contact' end,
             case when has_location then 'location' end), ''),
           'missing ' || nullif(concat_ws(', ', case when not spoken then 'reply' end,
             case when not has_contact then 'contact' end, case when not has_location then 'location' end), ''))
    end as new_reason
  from facts f;

  update crm_companies c set customer = true
  from outreach_tier_calc t where c.id = t.id and t.new_tier = 'D1' and not c.customer;

  update crm_companies c set outreach_tier = t.new_tier, outreach_tier_reason = t.new_reason
  from outreach_tier_calc t
  where c.id = t.id and not c.outreach_tier_manual
    and (c.outreach_tier is distinct from t.new_tier or c.outreach_tier_reason is distinct from t.new_reason);

  update crm_companies c set outreach_tier = null, outreach_tier_reason = null
  where c.outreach_tier is not null and not c.outreach_tier_manual
    and not exists (select 1 from outreach_tier_calc t where t.id = c.id);

  perform crm_refresh_last_heard();
  perform set_config('rebattery.outreach_tier_refresh', 'off', true);
  return query select c.outreach_tier, count(*) from crm_companies c
    where c.outreach_tier is not null group by 1 order by 1;
end $tier$;


insert into crm_fields (id, object_id, name, type, canonical_column, description, sort_order)
select v.id, o.id, v.name, v.type, v.col, v.descr, v.sort
from crm_objects o, (values
  ('fld_company_last_heard_from_on', 'Last Heard From', 'date', 'last_heard_from_on',
   'Date we last heard from them: inbound email, meeting, campaign click, auction view or offer, bid, or inbound WhatsApp. Blank = never heard from. Updated daily.', 7),
  ('fld_company_days_since_heard_from', 'Days Since Heard From', 'number', 'days_since_heard_from',
   'Whole days since we last heard from them (see Last Heard From). Blank = never. Updated daily.', 8)
) as v(id, name, type, col, descr, sort)
where o.name = 'company'
on conflict (object_id, name) do update set description = excluded.description,
  canonical_column = excluded.canonical_column, updated_at = now();

select crm_refresh_last_heard();

insert into crm_data_migrations (id) values ('136_last_heard_from') on conflict do nothing;

commit;
