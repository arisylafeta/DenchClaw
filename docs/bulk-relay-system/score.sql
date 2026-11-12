SET default_transaction_read_only = on;
-- Q1 intake + open stock by stage
select kind, bulk_listing_stage(id) stage, count(*) open_rows,
       count(*) filter (where created_at >= date_trunc('week', now()) - interval '7 days' and created_at < date_trunc('week', now())) new_last_week
from crm_bulk_listings
where status <> 'closed' and coalesce(source_kind,'') not in ('research')
group by 1,2 order by 1,2;
-- Q2 fact completeness of open listings
select kind, count(*) open_rows,
  count(*) filter (where nullif(btrim(context->>'owner'),'') is not null) with_owner,
  count(*) filter (where person_id is not null and company_id is not null) with_party,
  count(*) filter (where spec ? 'max_price' or exists (select 1 from crm_bulk_listing_fields f where f.bulk_listing_id=l.id and f.field_key='seller_price' and f.status<>'missing')) with_price,
  count(*) filter (where clear_by is not null or ship_by is not null or spec ? 'needed_by') with_date,
  count(*) filter (where nullif(btrim(location),'') is not null or exists (select 1 from crm_bulk_listing_fields f where f.bulk_listing_id=l.id and f.field_key='location' and f.status<>'missing')) with_location
from crm_bulk_listings l where status <> 'closed' group by 1;
-- Q3 stale open listings: no work touch (mail/call/quote/outreach/whatsapp/note, offer edit) in 14+ days, by owner
with t as (
  select l.id, l.kind, coalesce(nullif(context->>'owner',''),'(none)') owner,
    greatest((select max(occurred_at) from crm_bulk_listing_activity a where a.bulk_listing_id=l.id and a.kind in ('mail','call','quote','outreach','whatsapp','note','document')),
             (select max(o.updated_at) from crm_bulk_offers o where o.bulk_listing_id=l.id or o.counterpart_id=l.id), l.created_at) last_touch
  from crm_bulk_listings l where status <> 'closed')
select kind, owner, count(*) open_rows, count(*) filter (where last_touch < now()-interval '14 days') stale_14d,
       count(*) filter (where last_touch < now()-interval '30 days') stale_30d
from t group by 1,2 order by 1,2;
-- Q4 offer pipeline and wins
select o.stage, count(*) offers, count(*) filter (where o.terms ? 'amount') priced,
       count(*) filter (where o.stage in ('offered','negotiating') and coalesce(o.last_touch_on, o.updated_at::date) < current_date - 21) quiet_21d,
       count(*) filter (where o.data ? 'take_gbp') take_recorded
from crm_bulk_offers o join crm_bulk_listings l on l.id = o.bulk_listing_id
where o.role = 'counterparty' and (l.status <> 'closed' or o.stage in ('paid','signed','complete','invoiced'))
group by 1 order by 1;
-- Q5 mail threads waiting: we sent last 7+ days ago / they sent last 2+ days ago (human, non-marketing conversations, last 90 days)
with m as (select * from mail_message where state in ('received','accepted') and thread_id is not null and sent_at is not null and coalesce(purpose,'') <> 'marketing'),
hum as (select id, thread_id from m where direction='inbound' and lower(from_email) not like '%rebattery.io'
          and lower(from_email) !~ '^(no-?reply|notifications?|mailer-daemon|newsletters?|updates?|alerts?|billing|invoices?)[@+._-]'
          and not (labels && array['SPAM','TRASH','CATEGORY_PROMOTIONS','CATEGORY_SOCIAL','CATEGORY_UPDATES','CATEGORY_FORUMS'])),
conv as (select thread_id from m where direction='outbound' and campaign_id is null intersect select thread_id from hum),
last as (select distinct on (m.thread_id) m.id, m.direction, m.sent_at from m join conv using (thread_id) order by m.thread_id, m.sent_at desc)
select count(*) filter (where direction='outbound' and sent_at < now()-interval '7 days' and sent_at > now()-interval '90 days') waiting_on_them_7d,
       count(*) filter (where id in (select id from hum) and sent_at < now()-interval '2 days' and sent_at > now()-interval '90 days') waiting_on_us_2d
from last;
