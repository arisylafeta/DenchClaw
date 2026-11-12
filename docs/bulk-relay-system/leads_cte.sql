with m as (
  select id, thread_id, direction, lower(from_email) fe, to_emails, cc_emails, sent_at, labels, purpose, campaign_id, state, mailbox_owner_id
  from mail_message where state in ('received','accepted') and thread_id is not null and sent_at is not null),
firsts as (select distinct on (thread_id) * from m order by thread_id, sent_at, id),
cand as (
  select f.*, split_part(f.fe,'@',2) dom,
    case when 'supply@rebattery.io' = any(lower(array_to_string(f.to_emails||f.cc_emails,','))::text[] ) then 'x' end dummy,
    case when lower(array_to_string(f.to_emails||f.cc_emails,',')) like '%supply@rebattery.io%' then 'supply'
         when lower(array_to_string(f.to_emails||f.cc_emails,',')) like '%buy@rebattery.io%' then 'buy'
         when lower(array_to_string(f.to_emails||f.cc_emails,',')) like '%hello@rebattery.io%' then 'hello'
         when lower(array_to_string(f.to_emails||f.cc_emails,',')) like '%alex@rebattery.io%' then 'alex' end inbox
  from firsts f
  where f.direction='inbound' and f.sent_at >= now() - interval '90 days'
    and f.fe like '%@%' and f.fe not like '%rebattery.io'
    and f.fe !~ '^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?|newsletters?|news|marketing|updates?|alerts?|billing|invoices?|receipts?|digest|calendar|info-noreply)[@+._-]'
    and f.fe !~ '@(.*\.)?(google\.com|linkedin\.com|facebookmail\.com|stripe\.com|github\.com|slack\.com|notion\.so|calendly\.com|zoom\.us|hubspot\.com|mailchimp\.com|substack\.com|medium\.com)$'
    and not (f.labels && array['SPAM','TRASH','CATEGORY_PROMOTIONS','CATEGORY_SOCIAL','CATEGORY_UPDATES','CATEGORY_FORUMS'])),
leads0 as (
  select c.* from cand c
  where c.inbox is not null
    and not exists (select 1 from mail_message o, unnest(o.to_emails||o.cc_emails) a
       where o.direction='outbound' and o.state='accepted' and o.campaign_id is null and coalesce(o.purpose,'')<>'marketing'
         and o.sent_at < c.sent_at
         and (lower(regexp_replace(a,'^.*<|>.*$','','g')) = c.fe
              or (c.dom not in ('gmail.com','googlemail.com','outlook.com','hotmail.com','yahoo.com','icloud.com','live.com','hotmail.co.uk','yahoo.co.uk','btinternet.com','aol.com','gmx.de','web.de','qq.com','163.com','proton.me','protonmail.com','me.com','msn.com')
                  and split_part(lower(regexp_replace(a,'^.*<|>.*$','','g')),'@',2) = c.dom)))),
leads1 as (select distinct on (l0.fe, date_trunc('minute', l0.sent_at)) l0.*, mm.subject, mm.body_preview from leads0 l0 join mail_message mm on mm.id=l0.id order by l0.fe, date_trunc('minute', l0.sent_at), l0.mailbox_owner_id),
leads as (select *, (coalesce(subject,'') ~* '^\s*(re|aw|sv|antw|r)\s*:') is_reply from leads1
  where coalesce(subject,'') !~* '^\s*(automatic reply|auto.?reply|respuesta autom|out of office|accepted:|declined:|tentative|invitation:|updated invitation|appointment booked|réponse automatique|abwesenheit)'
    and dom !~ '^(notifications?|post|mail|email|e|news|info)\.'
    and (coalesce(subject,'')||' '||coalesce(body_preview,'')) ~* '(batter|cells?\M|modules?\M|\mpacks?\M|kwh|mwh|\mlfp\M|\mnmc\M|\mbess\M|lithium|li-ion|surplus|\mstock\M|second.?life|\mev\M|recycl|black mass)'),
rep as (
  select l.*,
   (select min(o.sent_at) from mail_message o where o.thread_id=l.thread_id and o.direction='outbound' and o.state='accepted' and o.sent_at>l.sent_at and coalesce(o.purpose,'')<>'marketing' and o.campaign_id is null) r_thread,
   (select min(o.sent_at) from mail_message o, unnest(o.to_emails||o.cc_emails) a where o.direction='outbound' and o.state='accepted' and o.sent_at>l.sent_at and coalesce(o.purpose,'')<>'marketing' and o.campaign_id is null and lower(regexp_replace(a,'^.*<|>.*$','','g'))=l.fe) r_addr
  from leads l)
