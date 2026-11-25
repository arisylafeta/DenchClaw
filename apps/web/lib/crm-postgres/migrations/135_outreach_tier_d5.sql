-- Outreach tier v2 (Ari/Alex, 25 Nov 2026): every company in the CRM Buyers view (Purpose contains Buyer) gets a tier.
--   D1  transacted with us, either side
--   D2  we have spoken to them, with a contact (email and/or phone) and a location
--   D3  we have spoken to them, but the contact or the location is missing
--   D4  contact and location, never heard from them
--   D5  everything else in the Buyers view (incomplete, never spoken to; also excluded companies). Replaces NA.
-- Volumes / "reputable" no longer gate D2. Excluded companies are D5 unless they transacted.
-- crm_company_is_buyer_purpose() mirrors companyBuyer() in apps/web/lib/crm-postgres/purpose.ts; keep them in step.
begin;

alter table crm_companies drop constraint if exists crm_companies_outreach_tier_check;
-- the manual-edit trigger must not treat this relabel as a hand edit
select set_config('rebattery.outreach_tier_refresh', 'on', true);
update crm_companies set outreach_tier = 'D5' where outreach_tier = 'NA';
select set_config('rebattery.outreach_tier_refresh', 'off', true);
alter table crm_companies add constraint crm_companies_outreach_tier_check
  check (outreach_tier in ('D1', 'D2', 'D3', 'D4', 'D5'));

create or replace function crm_tags_match(tags text[], pattern text) returns boolean language sql immutable as $$
  select exists (select 1 from unnest(coalesce(tags, '{}'::text[])) t(v)
    where lower(regexp_replace(btrim(coalesce(v, '')), '[[:space:]_-]+', '-', 'g')) ~ pattern)
$$;

create or replace function crm_company_is_buyer_purpose(c crm_companies) returns boolean language sql stable as $$
  select not crm_tags_match(c.tags, '^(internal|internal-contact|internal-company)$')
    and case when nullif(c.purpose, '{}'::text[]) is not null then 'Buyer' = any(c.purpose) else (
      lower(regexp_replace(btrim(coalesce(c.platform_role, '')), '[[:space:]_-]+', '-', 'g')) = 'buyer'
      or exists (select 1 from unnest(coalesce(c.roles, '{}'::text[])) r(v)
                 where lower(regexp_replace(btrim(coalesce(v, '')), '[[:space:]_-]+', '-', 'g')) = 'buyer')
      or lower(regexp_replace(btrim(coalesce(c.buyer_category, '')), '[[:space:]_-]+', '-', 'g'))
         ~ '^(buyer|potential-buyer|buyer-prospect|repurposer|recycler|trader|battery-repurposer-second-life)$'
      or lower(regexp_replace(btrim(coalesce(c.buyer_stage, '')), '[[:space:]_-]+', '-', 'g'))
         in ('identified', 'contacted', 'responded', 'in-conversation', 'qualified', 'bidding', 'customer')
      or nullif(btrim(c.buyer_evidence), '') is not null
      or crm_tags_match(c.tags, '^(buyer(-.*)?|potential-buyer(-contact)?|qualified-buyer|inbound-buyer|channel-buyer|niche-buyer|repurposer(-.*)?|strategic-repurposer|direct-repurposer|ev-battery-repurposing|supply-updates?|new-to-supply-updates?)$')
      or exists (select 1 from crm_people pc where pc.company_id = c.id
                 and not crm_tags_match(pc.tags, '^(internal|internal-contact|internal-company)$')
                 and crm_tags_match(pc.tags, '^(buyer(-.*)?|potential-buyer(-contact)?|qualified-buyer|inbound-buyer|channel-buyer|niche-buyer|repurposer(-.*)?|strategic-repurposer|direct-repurposer|ev-battery-repurposing|supply-updates?|new-to-supply-updates?)$'))
    ) end
$$;

create or replace function crm_refresh_buyer_outreach_tiers() returns table (tier text, companies bigint)
language plpgsql as $$
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

  perform set_config('rebattery.outreach_tier_refresh', 'off', true);
  return query select c.outreach_tier, count(*) from crm_companies c
    where c.outreach_tier is not null group by 1 order by 1;
end $$;

update crm_fields set
  description = 'Buyer outreach tier, set daily by rule unless edited by hand: D1 transacted with us; D2 spoken to, with a contact (email and/or phone) and a location; D3 spoken to, but contact or location missing; D4 contact and location, never heard from; D5 everything else in the Buyers view.',
  enum_values = '["D1", "D2", "D3", "D4", "D5"]'::jsonb,
  updated_at = now()
where id = 'fld_company_outreach_tier';

insert into crm_data_migrations (id) values ('135_outreach_tier_d5') on conflict do nothing;

commit;
