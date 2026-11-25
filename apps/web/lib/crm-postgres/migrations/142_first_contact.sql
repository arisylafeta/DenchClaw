-- First contact + platform enquiries (25 Nov 2026).
--   crm_platform_enquiries: sourcing requests and saved searches from the marketplace (production, read-only copy by
--   scripts/rebattery/platform_enquiry_sync.py), keyed by lower-cased email.
--   first_contact_on: earliest evidence of any contact (never later than Last Heard From): platform request/saved search, platform account creation, our first
--   direct email (campaign sends excluded), logged interaction, logged call/whatsapp/mail or WhatsApp message. Blank = none.
--   Last Heard From now also counts the latest platform enquiry (an inbound buyer contacting us). Tiers are unchanged:
--   an enquiry is not a logged conversation. Idempotent.
begin;

create table if not exists crm_platform_enquiries (
  kind text not null check (kind in ('sourcing_request', 'saved_search')),
  platform_id text not null,
  email text not null,
  created_at timestamptz not null,
  primary key (kind, platform_id)
);
create index if not exists crm_platform_enquiries_email_idx on crm_platform_enquiries (email);

alter table crm_companies add column if not exists first_contact_on date;

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
  ), enq as (
    select p.company_id, max(q.created_at) last_enq, min(q.created_at) first_enq
    from crm_platform_enquiries q join crm_people p on lower(p.email) = q.email
    where p.company_id is not null group by 1
  ), mailfirst as (
    select company_id, min(ts) first_mail from (
      select m.company_id, m.sent_at ts from mail_message m
        where m.crm_visible and m.campaign_id is null and m.company_id is not null and m.sent_at is not null
      union all select p.company_id, m.sent_at from mail_message m join crm_people p on p.id = m.person_id
        where m.crm_visible and m.campaign_id is null and p.company_id is not null and m.sent_at is not null
    ) x group by 1
  ), firstc as (
    select company_id, min(ts) first_ts from (
      select company_id, first_enq ts from enq
      union all select company_id, first_mail from mailfirst
      union all select p.company_id, pa.auth_created_at from crm_platform_accounts pa join crm_people p on p.id = pa.person_id
        where pa.review_status <> 'rejected' and p.company_id is not null and pa.auth_created_at is not null
      union all select ci.company_id, ci.occurred_at from crm_interactions ci where ci.company_id is not null and ci.occurred_at is not null
      union all select l.company_id, a.occurred_at from crm_bulk_listing_activity a join crm_bulk_listings l on l.id = a.bulk_listing_id
        where a.kind in ('mail', 'whatsapp', 'call') and l.company_id is not null
      union all select coalesce(wl.company_id, wp.company_id), min(m.occurred_at) from whatsapp_message m
        join whatsapp_identity_link wl on wl.identity_id = m.sender_identity_id and wl.valid_to is null
        left join crm_people wp on wp.id = wl.person_id
        where m.deleted_at is null and coalesce(wl.company_id, wp.company_id) is not null group by 1
    ) y where ts is not null group by 1
  ), calc as (
    select c.id, (greatest(e.last_heard_at, wa.last_wa, lg.last_logged, pl.last_in, en.last_enq) at time zone 'UTC')::date as d,
      (least(fc.first_ts, greatest(e.last_heard_at, wa.last_wa, lg.last_logged, pl.last_in, en.last_enq)) at time zone 'UTC')::date as first_d,
      (pl.last_in at time zone 'UTC')::date as plat_d
    from crm_companies c
    left join crm_buyer_engagement e on e.company_id = c.id
    left join wa on wa.company_id = c.id
    left join logged lg on lg.company_id = c.id
    left join plat pl on pl.company_id = c.id
    left join enq en on en.company_id = c.id
    left join firstc fc on fc.company_id = c.id
  )
  update crm_companies c set last_heard_from_on = calc.d, last_platform_active_on = calc.plat_d, first_contact_on = calc.first_d,
    days_since_heard_from = case when calc.d is null then null else greatest(current_date - calc.d, 0) end
  from calc
  where c.id = calc.id
    and (c.last_heard_from_on is distinct from calc.d or c.last_platform_active_on is distinct from calc.plat_d or c.first_contact_on is distinct from calc.first_d
      or c.days_since_heard_from is distinct from case when calc.d is null then null else greatest(current_date - calc.d, 0) end);
end $f$;


insert into crm_fields (id, object_id, name, type, canonical_column, description, sort_order)
select 'fld_company_first_contact_on', o.id, 'First Contact', 'date', 'first_contact_on',
  'Date of our earliest recorded contact with the company: marketplace request or saved search, account creation, first direct email, logged call, chat or interaction. Blank = none recorded. Updated daily.', 8
from crm_objects o where o.name = 'company'
on conflict (object_id, name) do update set description = excluded.description,
  canonical_column = excluded.canonical_column, updated_at = now();

insert into crm_data_migrations (id) values ('142_first_contact') on conflict do nothing;

commit;
