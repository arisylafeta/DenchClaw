-- Last platform activity (25 Nov 2026): when anyone at the company last signed in on the marketplace
--   (crm_platform_accounts.last_sign_in_at, kept current by platform_account_sync).
--   last_platform_active_on holds it, and it now also feeds Last Heard From / Days Since Heard From, which take the latest of all
--   signals. It does not change the tiers: a sign-in is not a logged conversation. Idempotent.
begin;

alter table crm_companies add column if not exists last_platform_active_on date;

CREATE OR REPLACE FUNCTION public.crm_refresh_last_heard()
 RETURNS void
 LANGUAGE plpgsql
AS $f$
begin
  perform set_config('rebattery.last_heard_refresh', 'on', true);
  with wa as (
    select coalesce(wl.company_id, wp.company_id) company_id, max(m.occurred_at) last_wa
    from whatsapp_message m
    join whatsapp_identity_link wl on wl.identity_id = m.sender_identity_id and wl.valid_to is null
    left join crm_people wp on wp.id = wl.person_id
    where m.direction = 'inbound' and m.deleted_at is null
    group by 1
  ), logged as (
    select company_id, max(ts) last_logged from (
      select ci.company_id, ci.occurred_at ts from crm_interactions ci where ci.direction = 'Received' and ci.company_id is not null
      union all select p.company_id, ci.occurred_at from crm_interactions ci join crm_people p on p.id = ci.person_id
        where ci.direction = 'Received' and p.company_id is not null
      union all select l.company_id, a.occurred_at from crm_bulk_listing_activity a join crm_bulk_listings l on l.id = a.bulk_listing_id
        where a.kind in ('mail', 'whatsapp', 'call') and l.company_id is not null
      union all select p.company_id, a.occurred_at from crm_bulk_listing_activity a join crm_people p on p.id = a.person_id
        where a.kind in ('mail', 'whatsapp', 'call') and p.company_id is not null
      union all select o.company_id, o.last_touch_on::timestamptz from crm_bulk_offers o
        where o.company_id is not null and o.last_touch_on is not null and o.last_touch_via ~* '(whatsapp|call|phone|meeting)'
    ) x group by 1
  ), plat as (
    select p.company_id, max(pa.last_sign_in_at) last_in
    from crm_platform_accounts pa join crm_people p on p.id = pa.person_id
    where pa.review_status <> 'rejected' and p.company_id is not null and pa.last_sign_in_at is not null
    group by 1
  ), calc as (
    select c.id, (greatest(e.last_heard_at, wa.last_wa, lg.last_logged, pl.last_in) at time zone 'UTC')::date as d,
      (pl.last_in at time zone 'UTC')::date as plat_d
    from crm_companies c
    left join crm_buyer_engagement e on e.company_id = c.id
    left join wa on wa.company_id = c.id
    left join logged lg on lg.company_id = c.id
    left join plat pl on pl.company_id = c.id
  )
  update crm_companies c set last_heard_from_on = calc.d, last_platform_active_on = calc.plat_d,
    days_since_heard_from = case when calc.d is null then null else greatest(current_date - calc.d, 0) end
  from calc
  where c.id = calc.id
    and (c.last_heard_from_on is distinct from calc.d or c.last_platform_active_on is distinct from calc.plat_d
      or c.days_since_heard_from is distinct from case when calc.d is null then null else greatest(current_date - calc.d, 0) end);
end $f$;


insert into crm_fields (id, object_id, name, type, canonical_column, description, sort_order)
select 'fld_company_last_platform_active_on', o.id, 'Last Active on Platform', 'date', 'last_platform_active_on',
  'Date anyone at the company last signed in on the ReBattery marketplace. Blank = no platform account or no sign-in. Updated daily.', 8
from crm_objects o where o.name = 'company'
on conflict (object_id, name) do update set description = excluded.description,
  canonical_column = excluded.canonical_column, updated_at = now();

select crm_refresh_last_heard();

insert into crm_data_migrations (id) values ('141_last_platform_active') on conflict do nothing;

commit;
