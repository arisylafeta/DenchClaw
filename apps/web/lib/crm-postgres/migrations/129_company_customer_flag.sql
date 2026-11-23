-- Lifetime customers (23 Nov 2026). crm_companies.customer marks every company that has transacted with ReBattery
-- on either side: bought from us, sold through us, or sent batteries to recycling. Outreach Tier D1 reads it, so
-- customers who only ever sold or recycled are D1 too. Set by: the outreach refresh (buyer-side Customer stage,
-- signed/paid Trades Preview deals on either side), scripts/rebattery/platform_deal_customers.py (completed or paid
-- marketplace and recycling deals, both parties) and by hand for off-platform deals. Never cleared automatically.
begin;

alter table crm_companies add column if not exists customer boolean not null default false;

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
        c.customer
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
    select p.id,
      coalesce(p.customer or p.buyer_stage = 'Customer'
        or exists (select 1 from crm_bulk_offers o where o.company_id = p.id and o.role = 'counterparty'
                   and o.stage in ('signed', 'invoiced', 'paid', 'complete'))
        or exists (select 1 from crm_bulk_listings l where l.company_id = p.id and l.kind = 'demand'
                   and l.closed_reason = 'bought_from_us')
        -- seller side: their supply lot reached a signed or paid buyer
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
    case when transacted then 'Customer: transacted with us'
         else concat_ws('; ',
           nullif(concat_ws(', ', case when spoken then 'replied' end, case when has_contact then 'contact' end,
             case when has_location then 'location' end, case when volumes then 'volumes' end,
             case when reputable then 'reputable' end), ''),
           'missing ' || nullif(concat_ws(', ', case when not spoken then 'reply' end,
             case when not has_contact then 'contact' end, case when not has_location then 'location' end,
             case when not volumes then 'volumes' end, case when not reputable then 'reputable' end), ''))
    end as new_reason
  from facts f;

  -- Customer is the lifetime list of companies that transacted with us, either side; it is only ever added to.
  update crm_companies c set customer = true
  from outreach_tier_calc t where c.id = t.id and t.new_tier = 'D1' and not c.customer;

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

insert into crm_fields (id, object_id, name, type, canonical_column, description, sort_order)
select 'fld_company_customer', o.id, 'Customer', 'boolean', 'customer',
  'Has transacted with ReBattery on either side (bought, sold through us or recycled). Set by deal syncs or by hand; never cleared automatically.', 4
from crm_objects o where o.name = 'company'
on conflict (object_id, name) do update set description = excluded.description, canonical_column = excluded.canonical_column, updated_at = now();

insert into crm_data_migrations (id) values ('129_company_customer_flag') on conflict do nothing;

commit;
