-- D3 widened (25 Nov 2026): D3 = anyone who came to us (inbound: source Inbound, Supabase import, Email mining or Referral)
--   that is not D1 or D2, plus anyone with logged conversation evidence but incomplete details. A stage field alone (Responded,
--   Engaged) no longer makes a company D3: without a logged conversation it is D4 (contact and location) or D5.
--   Order: D1 transacted, D5 if excluded, D2 logged conversation + contact + location, D3, D4 contact + location, else D5.
--   Hand-set tiers are kept. Idempotent.
begin;

CREATE OR REPLACE FUNCTION public.crm_refresh_buyer_outreach_tiers()
 RETURNS TABLE(tier text, companies bigint)
 LANGUAGE plpgsql
AS $tier$
begin
  perform set_config('rebattery.outreach_tier_refresh', 'on', true);

  perform crm_refresh_last_heard();

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
      coalesce(p.source in ('Inbound', 'Supabase import', 'Email mining', 'Referral'), false) as is_inbound,
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
        or exists (select 1 from crm_interactions ci where ci.direction = 'Received'
                   and (ci.company_id = p.id or ci.person_id in (select pp.id from crm_people pp where pp.company_id = p.id)))
        or exists (select 1 from crm_bulk_listing_activity a join crm_bulk_listings l on l.id = a.bulk_listing_id
                   where l.company_id = p.id and a.kind in ('mail', 'whatsapp', 'call'))
        or exists (select 1 from crm_bulk_listing_activity a join crm_people ap on ap.id = a.person_id
                   where ap.company_id = p.id and a.kind in ('mail', 'whatsapp', 'call'))
        or exists (select 1 from whatsapp_message m
                   join whatsapp_identity_link wl on wl.identity_id = m.sender_identity_id and wl.valid_to is null
                   left join crm_people wp on wp.id = wl.person_id
                   where m.direction = 'inbound' and coalesce(wl.company_id, wp.company_id) = p.id)
        or exists (select 1 from crm_bulk_offers o where o.company_id = p.id
                   and o.last_touch_via ~* '(whatsapp|call|phone|meeting)')
        or exists (select 1 from buyer_interest i where i.company_id = p.id
                   and array_to_string(i.source_refs, ' ') like '%whatsapp:%'), false) as convo,
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
         when convo and has_contact and has_location then 'D2'
         when convo or is_inbound then 'D3'
         when has_contact and has_location then 'D4'
         else 'D5' end as new_tier,
    case when transacted then 'Customer: transacted with us'
         when is_excluded then 'Excluded from outreach'
         else concat_ws('; ',
           nullif(concat_ws(', ', case when convo then 'replied' when is_inbound then 'inbound enquiry, no logged conversation' end, case when has_contact then 'contact' end,
             case when has_location then 'location' end), ''),
           'missing ' || nullif(concat_ws(', ', case when not convo then 'reply' end,
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

  perform crm_refresh_active_deal();
  perform set_config('rebattery.outreach_tier_refresh', 'off', true);
  return query select c.outreach_tier, count(*) from crm_companies c
    where c.outreach_tier is not null group by 1 order by 1;
end $tier$;


select * from crm_refresh_buyer_outreach_tiers();

insert into crm_data_migrations (id) values ('140_tier_d3_inbound') on conflict do nothing;

commit;
