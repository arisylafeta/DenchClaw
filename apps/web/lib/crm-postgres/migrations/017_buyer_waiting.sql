-- Bulk Trades: buyers waiting on a reply. One row per buyer contact: a CRM person on an open demand
-- row (or at its company), or a buyer on a live trade. waiting_since is set when their latest email
-- to us is newer than the latest email we sent them from either mailbox (to or cc). Auto-replies do
-- not count. Email only: WhatsApp and calls are not in the CRM.
-- Adds a view only. Apply only after a current backup and explicit schema approval.
begin;

create or replace view crm_bulk_trade_buyer_waiting as
with buyers as (
  select p.id as person_id, p.company_id, p.full_name, p.email
  from crm_people p
  where exists (
      select 1 from crm_bulk_trade_demand d
      where d.status = 'open' and (d.person_id = p.id or (d.company_id is not null and d.company_id = p.company_id)))
    or exists (
      select 1 from crm_bulk_trade_buyers b join crm_bulk_trade_lots l on l.id = b.lot_id
      where b.person_id = p.id and l.trade_stage in ('Needs info', 'With buyers', 'Closing'))
),
inbound as (
  select distinct on (m.from_person_id) m.from_person_id as person_id, m.sent_at, m.subject, m.thread_id
  from crm_email_messages m join buyers b on b.person_id = m.from_person_id
  where m.sent_at is not null
    and coalesce(m.from_email, '') !~* '@rebattery\.io$'
    and coalesce(m.subject, '') !~* '^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|abwesenheit)'
  order by m.from_person_id, m.sent_at desc
),
outbound as (
  select r.person_id, max(m.sent_at) as sent_at
  from crm_email_message_recipients r
  join crm_email_messages m on m.id = r.message_id
  join buyers b on b.person_id = r.person_id
  where m.from_email ~* '@rebattery\.io$'
  group by r.person_id
)
select b.person_id, b.company_id, b.full_name, b.email,
  i.sent_at as last_in_at, i.subject as last_in_subject, i.thread_id as last_in_thread_id, o.sent_at as last_out_at,
  case when i.sent_at > coalesce(o.sent_at, '-infinity'::timestamptz) then i.sent_at end as waiting_since
from buyers b
left join inbound i on i.person_id = b.person_id
left join outbound o on o.person_id = b.person_id;

commit;
