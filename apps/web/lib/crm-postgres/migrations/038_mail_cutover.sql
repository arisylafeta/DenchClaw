-- Apply only after a fresh verified, restore-tested pg_dump and explicit approval.
-- Import with rebattery-mail legacy import --apply before this clean cutover.
-- Campaigns with an accepted receipt become launched; all other loaded campaigns stay legacy.
begin;
set local lock_timeout = '5s';
lock table crm_email_threads, crm_email_messages, crm_email_thread_participants,
  crm_email_message_recipients, crm_campaign_sends, crm_campaign_send_links in access exclusive mode;
-- Compare every imported field again while the sources remain exclusively locked.
do $$ begin
  if exists (select 1 from (
      select id, subject, gmail_thread_id, mailbox_owner_id, last_message_at,
             coalesce(message_count,0) as message_count, true as crm_visible, created_at, updated_at
      from crm_email_threads) e where not exists (
    select 1 from mail_thread t where t.id=e.id and not exists (
      select 1 from jsonb_each(to_jsonb(e)) field
      where to_jsonb(t)->field.key is distinct from field.value))) then
    raise exception 'mail cutover refused: crm_email_threads has unloaded rows or mismatched fields; rerun legacy import';
  end if;
end $$;
do $$ begin
  if exists (select 1 from (
      select s.id, 'outbound'::text as direction, 'postmark-broadcast'::text as transport,
        'marketing'::text as purpose,
        identity.key as identity_key,
        coalesce(identity.address, case when sender.address like '%@%' then sender.address end) as from_email,
        s.campaign_id, s.person_id, s.company_id, s.listing_id, s.auction_url,
        s.recipient_email, array[s.recipient_email] as to_emails,
        s.provider_message_id, s.state, s.claimed_at, s.accepted_at,
        s.accepted_at as sent_at, s.delivered_at, s.bounced_at,
        s.provider_opened_at as opened_at, s.provider_link_clicked_at as clicked_at,
        s.last_synced_at, s.personalization, s.rendered_subject as subject,
        s.rendered_html as body_html, s.rendered_text as body_text,
        false as crm_visible, s.created_at, s.created_at as updated_at
      from crm_campaign_sends s join campaigns c on c.id=s.campaign_id
      cross join lateral (select lower(btrim(coalesce(
        substring(c.sender_identity from '<([^<>]+)>'),c.sender_identity))) as address) sender
      left join lateral (select i.key,i.address from mail_identity i
        where lower(i.key)=lower(btrim(c.sender_identity)) or lower(i.address)=sender.address
        order by i.key limit 1) identity on true) e where not exists (
    select 1 from mail_message t where t.id=e.id and not exists (
      select 1 from jsonb_each(to_jsonb(e)) field
      where to_jsonb(t)->field.key is distinct from field.value))) then
    raise exception 'mail cutover refused: crm_campaign_sends has unloaded rows or mismatched fields; rerun legacy import';
  end if;
end $$;
do $$ begin
  if exists (select 1 from (
      select m.id, m.thread_id, m.subject, m.sent_at, m.from_person_id,
        m.from_email, m.body_preview, m.body as body_text, coalesce(m.has_attachments,false) as has_attachments,
        m.gmail_message_id, m.mailbox_owner_id, m.created_at, m.updated_at,
        'gmail'::text as transport, 'personal'::text as purpose,
        case when own.is_own then 'outbound' else 'inbound' end as direction,
        case when own.is_own then 'accepted' else 'received' end as state,
        case when own.is_own then m.sent_at end as accepted_at,
        (select i.key from mail_identity i where lower(i.address)=lower(m.from_email)
          order by i.key limit 1) as identity_key,
        coalesce((select array_agg(p.email order by r.position, p.id)
          from crm_email_message_recipients r join crm_people p on p.id=r.person_id
          where r.message_id=m.id and r.recipient_type='to' and p.email is not null), '{}') as to_emails,
        coalesce((select array_agg(p.email order by r.position, p.id)
          from crm_email_message_recipients r join crm_people p on p.id=r.person_id
          where r.message_id=m.id and r.recipient_type='cc' and p.email is not null), '{}') as cc_emails,
        true as crm_visible, 'legacy'::text as crm_visible_reason
      from crm_email_messages m left join crm_users u on u.id=m.mailbox_owner_id
      cross join lateral (select coalesce(lower(m.from_email)=lower(u.email),false)
        or exists(select 1 from mail_identity i where lower(i.address)=lower(m.from_email)
          or lower(i.gmail_account)=lower(m.from_email)) as is_own) own) e where not exists (
    select 1 from mail_message t where t.id=e.id and not exists (
      select 1 from jsonb_each(to_jsonb(e)) field
      where to_jsonb(t)->field.key is distinct from field.value))) then
    raise exception 'mail cutover refused: crm_email_messages has unloaded rows or mismatched fields; rerun legacy import';
  end if;
end $$;
do $$ begin
  if exists (select 1 from (
      select id, send_id as message_id, cta_key, destination_url, listing_id,
             first_clicked_at from crm_campaign_send_links) e where not exists (
    select 1 from mail_message_link t where t.id=e.id and not exists (
      select 1 from jsonb_each(to_jsonb(e)) field
      where to_jsonb(t)->field.key is distinct from field.value))) then
    raise exception 'mail cutover refused: crm_campaign_send_links has unloaded rows or mismatched fields; rerun legacy import';
  end if;
end $$;
do $$ begin
  if exists (select 1 from (
      select thread_id, person_id, position, created_at from crm_email_thread_participants) e where not exists (
    select 1 from mail_thread_participant t where t.thread_id=e.thread_id and t.person_id=e.person_id and not exists (
      select 1 from jsonb_each(to_jsonb(e)) field
      where to_jsonb(t)->field.key is distinct from field.value))) then
    raise exception 'mail cutover refused: crm_email_thread_participants has unloaded rows or mismatched fields; rerun legacy import';
  end if;
end $$;
do $$ begin
  if exists (select 1 from (
      select message_id, person_id, recipient_type, position, created_at from crm_email_message_recipients) e where not exists (
    select 1 from mail_message_recipient t where t.message_id=e.message_id and t.person_id=e.person_id and t.recipient_type=e.recipient_type and not exists (
      select 1 from jsonb_each(to_jsonb(e)) field
      where to_jsonb(t)->field.key is distinct from field.value))) then
    raise exception 'mail cutover refused: crm_email_message_recipients has unloaded rows or mismatched fields; rerun legacy import';
  end if;
end $$;
do $$ begin
  if exists (select 1 from (
 select s.id as message_id, e.type, 'postmark'::text as source,
   'legacy:' || s.id || ':' || e.type as provider_event_id, e.at as occurred_at
 from crm_campaign_sends s cross join lateral (values
   ('sent',s.accepted_at), ('delivered',s.delivered_at), ('bounced',s.bounced_at),
   ('opened',s.provider_opened_at), ('clicked',s.provider_link_clicked_at)
 ) e(type,at) where e.at is not null
) e where not exists (
    select 1 from mail_event t where t.source=e.source and t.provider_event_id=e.provider_event_id
      and t.message_id=e.message_id and t.type=e.type and t.occurred_at=e.occurred_at)) then
    raise exception 'mail cutover refused: missing or mismatched legacy events; rerun legacy import';
  end if;
end $$;

-- Discover the existing FK name rather than depending on bootstrap naming.
do $$ declare fk record; begin
  for fk in select conname from pg_constraint where conrelid='crm_interactions'::regclass
    and contype='f' and confrelid='crm_email_messages'::regclass
  loop execute format('alter table crm_interactions drop constraint %I',fk.conname); end loop;
end $$;
alter table crm_interactions add constraint crm_interactions_email_message_id_fkey
  foreign key (email_message_id) references mail_message(id) on delete set null;
drop view crm_buyer_engagement;
drop view crm_bulk_trade_buyer_waiting;
drop view crm_person_campaign_activity;
drop view crm_relation_links;
drop trigger if exists trg_crm_campaign_send_marks_contact on crm_campaign_sends;
drop function if exists crm_mark_campaign_send();
drop table crm_email_message_recipients, crm_email_thread_participants,
  crm_email_messages, crm_email_threads, crm_campaign_send_links, crm_campaign_sends;

-- Keep existing CRM object IDs and saved relations while changing their backing store.
update crm_objects set entity_table='mail_message', immutable=true, updated_at=now()
  where entity_table='crm_email_messages' or name='email_message';
update crm_objects set entity_table='mail_thread', immutable=true, updated_at=now()
  where entity_table='crm_email_threads' or name='email_thread';
update crm_fields set canonical_column='body_text', updated_at=now()
  where canonical_column='body' and object_id in
    (select id from crm_objects where entity_table='mail_message');

-- Provider-owned mail objects are readable through the generic CRM, never editable there.
insert into crm_objects (id,name,entity_table,description,display_field,immutable,hidden_in_sidebar)
values
  ('reb_mail_message_object','mail_message','mail_message','Authoritative mail log','Subject',true,true),
  ('reb_mail_campaign_object','mail_campaign','campaigns','Mail campaigns','Name',true,true)
on conflict (name) do update set entity_table=excluded.entity_table,
  display_field=excluded.display_field, immutable=true, hidden_in_sidebar=true, updated_at=now();
insert into crm_fields (id,object_id,name,type,canonical_column,sort_order)
select 'reb_mail_message_'||v.col,o.id,v.label,v.kind,v.col,v.sort
from crm_objects o cross join (values
  ('subject','Subject','text',0), ('body_text','Body','text',1),
  ('direction','Direction','text',2), ('transport','Transport','text',3),
  ('purpose','Purpose','text',4), ('state','State','text',5),
  ('recipient_email','Recipient','text',6), ('sent_at','Sent at','datetime',7)
) v(col,label,kind,sort) where o.name='mail_message'
on conflict (object_id,name) do update set canonical_column=excluded.canonical_column;
insert into crm_fields (id,object_id,name,type,canonical_column,sort_order)
select 'reb_mail_campaign_'||v.col,o.id,v.label,v.kind,v.col,v.sort
from crm_objects o cross join (values
  ('campaign_name','Name','text',0), ('mail_state','Mail state','text',1),
  ('purpose','Purpose','text',2), ('identity_key','Identity','text',3)
) v(col,label,kind,sort) where o.name='mail_campaign'
on conflict (object_id,name) do update set canonical_column=excluded.canonical_column;

-- Preserve the current (029) campaign-contact side effects, including Buyer Stage.
create or replace function mail_mark_campaign_send() returns trigger language plpgsql as $$
declare
  kind text;
  label text;
  sub_status text;
  company text;
begin
  if new.state <> 'accepted' or new.person_id is null or new.campaign_id is null or new.direction <> 'outbound' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.state = 'accepted' then
    return null;
  end if;
  select type, campaign_name into kind, label from campaigns where id = new.campaign_id;
  if kind is null or kind not in ('supply_update', 'intro') then
    return null;
  end if;
  insert into crm_subscriptions (person_id, list, status, since, how)
  values (new.person_id, 'Supply update', 'Subscribed', coalesce(new.accepted_at, now())::date, 'Sent: ' || label)
  on conflict (person_id, list) do nothing;
  select status into sub_status from crm_subscriptions where person_id = new.person_id and list = 'Supply update';
  if sub_status = 'Subscribed' then
    update crm_people set tags = array(select distinct unnest(coalesce(tags, '{}') || array['Supply Update'])), updated_at = now()
    where id = new.person_id and not (coalesce(tags, '{}') @> array['Supply Update']);
  end if;
  company := coalesce(new.company_id, (select company_id from crm_people where id = new.person_id));
  if company is not null then
    update crm_companies set relationship_stage = 'Contacted', updated_at = now()
    where id = company and relationship_stage = 'New';
    update crm_companies set buyer_stage = 'Contacted', updated_at = now()
    where id = company and 'Buyer' = any(coalesce(purpose, '{}')) and coalesce(buyer_stage, 'Identified') = 'Identified';
  end if;
  return null;
end $$;

create view crm_relation_links as
WITH visible_messages as (select * from mail_message where crm_visible),
visible_participants as (select p.* from mail_thread_participant p join mail_thread t on t.id=p.thread_id where t.crm_visible),
visible_recipients as (select r.* from mail_message_recipient r join mail_message m on m.id=r.message_id where m.crm_visible)
SELECT 'seed_obj_email_thread_000000000'::text AS object_id,
    'seed_fld_emthread_people_00000'::text AS field_id,
    visible_participants.thread_id AS source_entry_id,
    visible_participants.person_id AS target_entry_id,
    visible_participants."position",
    visible_participants.created_at
   FROM visible_participants
UNION ALL
 SELECT 'seed_obj_email_message_00000000'::text AS object_id,
    'seed_fld_emmsg_to_0000000000000'::text AS field_id,
    visible_recipients.message_id AS source_entry_id,
    visible_recipients.person_id AS target_entry_id,
    visible_recipients."position",
    visible_recipients.created_at
   FROM visible_recipients
  WHERE (visible_recipients.recipient_type = 'to'::text)
UNION ALL
 SELECT 'seed_obj_email_message_00000000'::text AS object_id,
    'seed_fld_emmsg_cc_0000000000000'::text AS field_id,
    visible_recipients.message_id AS source_entry_id,
    visible_recipients.person_id AS target_entry_id,
    visible_recipients."position",
    visible_recipients.created_at
   FROM visible_recipients
  WHERE (visible_recipients.recipient_type = 'cc'::text)
UNION ALL
 SELECT 'seed_obj_calendar_event_0000000'::text AS object_id,
    'seed_fld_calev_attend_000000000'::text AS field_id,
    crm_calendar_event_attendees.event_id AS source_entry_id,
    crm_calendar_event_attendees.person_id AS target_entry_id,
    0 AS "position",
    crm_calendar_event_attendees.created_at
   FROM crm_calendar_event_attendees
UNION ALL
 SELECT 'seed_obj_people_00000000000000'::text AS object_id,
    'seed_fld_people_company_0000000'::text AS field_id,
    crm_people.id AS source_entry_id,
    crm_people.company_id AS target_entry_id,
    0 AS "position",
    crm_people.created_at
   FROM crm_people
  WHERE (crm_people.company_id IS NOT NULL)
UNION ALL
 SELECT 'seed_obj_email_message_00000000'::text AS object_id,
    'seed_fld_emmsg_from_00000000000'::text AS field_id,
    visible_messages.id AS source_entry_id,
    visible_messages.from_person_id AS target_entry_id,
    0 AS "position",
    visible_messages.created_at
   FROM visible_messages
  WHERE (visible_messages.from_person_id IS NOT NULL)
UNION ALL
 SELECT 'seed_obj_email_message_00000000'::text AS object_id,
    'seed_fld_emmsg_thread_000000000'::text AS field_id,
    visible_messages.id AS source_entry_id,
    visible_messages.thread_id AS target_entry_id,
    0 AS "position",
    visible_messages.created_at
   FROM visible_messages
  WHERE (visible_messages.thread_id IS NOT NULL)
UNION ALL
 SELECT 'seed_obj_interaction_00000000000'::text AS object_id,
    'seed_fld_inter_person_000000000'::text AS field_id,
    crm_interactions.id AS source_entry_id,
    crm_interactions.person_id AS target_entry_id,
    0 AS "position",
    crm_interactions.created_at
   FROM crm_interactions
  WHERE (crm_interactions.person_id IS NOT NULL)
UNION ALL
 SELECT 'seed_obj_interaction_00000000000'::text AS object_id,
    'seed_fld_inter_company_00000000'::text AS field_id,
    crm_interactions.id AS source_entry_id,
    crm_interactions.company_id AS target_entry_id,
    0 AS "position",
    crm_interactions.created_at
   FROM crm_interactions
  WHERE (crm_interactions.company_id IS NOT NULL)
UNION ALL
 SELECT 'seed_obj_interaction_00000000000'::text AS object_id,
    'seed_fld_inter_email_0000000000'::text AS field_id,
    crm_interactions.id AS source_entry_id,
    crm_interactions.email_message_id AS target_entry_id,
    0 AS "position",
    crm_interactions.created_at
   FROM crm_interactions
  WHERE (crm_interactions.email_message_id IS NOT NULL)
UNION ALL
 SELECT 'seed_obj_interaction_00000000000'::text AS object_id,
    'seed_fld_inter_event_0000000000'::text AS field_id,
    crm_interactions.id AS source_entry_id,
    crm_interactions.calendar_event_id AS target_entry_id,
    0 AS "position",
    crm_interactions.created_at
   FROM crm_interactions
  WHERE (crm_interactions.calendar_event_id IS NOT NULL)
UNION ALL
 SELECT 'seed_obj_calendar_event_0000000'::text AS object_id,
    'seed_fld_calev_organ_0000000000'::text AS field_id,
    crm_calendar_events.id AS source_entry_id,
    crm_calendar_events.organizer_person_id AS target_entry_id,
    0 AS "position",
    crm_calendar_events.created_at
   FROM crm_calendar_events
  WHERE (crm_calendar_events.organizer_person_id IS NOT NULL)
UNION ALL
 SELECT 'f43167a6-6805-44ab-b26a-e187752365f1'::text AS object_id,
    '36cf33c6-dcbb-47f8-9c82-c287b40d24ed'::text AS field_id,
    crm_commercial_opportunities.id AS source_entry_id,
    crm_commercial_opportunities.company_id AS target_entry_id,
    0 AS "position",
    crm_commercial_opportunities.created_at
   FROM crm_commercial_opportunities
  WHERE (crm_commercial_opportunities.company_id IS NOT NULL)
UNION ALL
 SELECT 'f43167a6-6805-44ab-b26a-e187752365f1'::text AS object_id,
    '164c1603-4faa-46d8-98dc-03f7e6f91152'::text AS field_id,
    crm_commercial_opportunities.id AS source_entry_id,
    crm_commercial_opportunities.contact_person_id AS target_entry_id,
    0 AS "position",
    crm_commercial_opportunities.created_at
   FROM crm_commercial_opportunities
  WHERE (crm_commercial_opportunities.contact_person_id IS NOT NULL)
UNION ALL
 SELECT 'f43167a6-6805-44ab-b26a-e187752365f1'::text AS object_id,
    '1eac4175-7d53-4712-8f2f-79d23c254e06'::text AS field_id,
    crm_commercial_opportunities.id AS source_entry_id,
    crm_commercial_opportunities.buyer_company_id AS target_entry_id,
    0 AS "position",
    crm_commercial_opportunities.created_at
   FROM crm_commercial_opportunities
  WHERE (crm_commercial_opportunities.buyer_company_id IS NOT NULL)
UNION ALL
 SELECT 'f43167a6-6805-44ab-b26a-e187752365f1'::text AS object_id,
    '30204a59-a42f-4baa-a3a8-3ad92fe441b3'::text AS field_id,
    crm_commercial_opportunities.id AS source_entry_id,
    crm_commercial_opportunities.seller_company_id AS target_entry_id,
    0 AS "position",
    crm_commercial_opportunities.created_at
   FROM crm_commercial_opportunities
  WHERE (crm_commercial_opportunities.seller_company_id IS NOT NULL)
UNION ALL
 SELECT 'reb_work_task_object'::text AS object_id,
    'reb_work_task_3'::text AS field_id,
    work_tasks.id AS source_entry_id,
    work_tasks.project_id AS target_entry_id,
    0 AS "position",
    work_tasks.created_at
   FROM work_tasks
  WHERE (work_tasks.project_id IS NOT NULL)
UNION ALL
 SELECT 'reb_automation_loop_run_object'::text AS object_id,
    'reb_automation_loop_run_loop'::text AS field_id,
    automation_loop_runs.id AS source_entry_id,
    automation_loop_runs.loop_id AS target_entry_id,
    0 AS "position",
    automation_loop_runs.created_at
   FROM automation_loop_runs;

create view crm_bulk_trade_buyer_waiting as
WITH visible_messages as (select * from mail_message where crm_visible and not (direction='outbound' and campaign_id is not null)),
visible_recipients as (select r.* from mail_message_recipient r join visible_messages m on m.id=r.message_id),
buyers AS (
         SELECT p.id AS person_id,
            p.company_id,
            p.full_name,
            p.email
           FROM crm_people p
          WHERE ((EXISTS ( SELECT 1
                   FROM crm_bulk_trade_demand d
                  WHERE ((d.status = 'open'::text) AND ((d.person_id = p.id) OR ((d.company_id IS NOT NULL) AND (d.company_id = p.company_id)))))) OR (EXISTS ( SELECT 1
                   FROM (crm_bulk_trade_buyers b_1
                     JOIN crm_bulk_trade_lots l ON ((l.id = b_1.lot_id)))
                  WHERE ((b_1.person_id = p.id) AND (l.trade_stage = ANY (ARRAY['Needs info'::text, 'With buyers'::text, 'Closing'::text]))))))
        ), inbound AS (
         SELECT DISTINCT ON (m.from_person_id) m.from_person_id AS person_id,
            m.sent_at,
            m.subject,
            m.thread_id
           FROM (visible_messages m
             JOIN buyers b_1 ON ((b_1.person_id = m.from_person_id)))
          WHERE ((m.sent_at IS NOT NULL) AND (COALESCE(m.from_email, ''::text) !~* '@rebattery\.io$'::text) AND (COALESCE(m.subject, ''::text) !~* '^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|abwesenheit)'::text))
          ORDER BY m.from_person_id, m.sent_at DESC
        ), outbound AS (
         SELECT r.person_id,
            max(m.sent_at) AS sent_at
           FROM ((visible_recipients r
             JOIN visible_messages m ON ((m.id = r.message_id)))
             JOIN buyers b_1 ON ((b_1.person_id = r.person_id)))
          WHERE (m.from_email ~* '@rebattery\.io$'::text)
          GROUP BY r.person_id
        )
 SELECT b.person_id,
    b.company_id,
    b.full_name,
    b.email,
    i.sent_at AS last_in_at,
    i.subject AS last_in_subject,
    i.thread_id AS last_in_thread_id,
    o.sent_at AS last_out_at,
        CASE
            WHEN (i.sent_at > COALESCE(o.sent_at, '-infinity'::timestamp with time zone)) THEN i.sent_at
            ELSE NULL::timestamp with time zone
        END AS waiting_since
   FROM ((buyers b
     LEFT JOIN inbound i ON ((i.person_id = b.person_id)))
     LEFT JOIN outbound o ON ((o.person_id = b.person_id)));

create view crm_person_campaign_activity as
WITH campaign_messages as (select * from mail_message where campaign_id is not null)
SELECT person_id,
    count(*) AS campaigns_sent,
    max(COALESCE(delivered_at, accepted_at, created_at)) AS last_sent_at,
    max(opened_at) AS last_opened_at,
    max(clicked_at) AS last_clicked_at,
    count(opened_at) AS campaigns_opened,
    count(clicked_at) AS campaigns_clicked
   FROM campaign_messages
  WHERE (person_id IS NOT NULL)
  GROUP BY person_id;

create view crm_buyer_engagement as
WITH visible_messages as (select * from mail_message where crm_visible and not (direction='outbound' and campaign_id is not null)),
visible_recipients as (select r.* from mail_message_recipient r join visible_messages m on m.id=r.message_id),
campaign_messages as (select * from mail_message where campaign_id is not null),
people AS (
         SELECT crm_people.id AS person_id,
            crm_people.company_id
           FROM crm_people
          WHERE (crm_people.company_id IS NOT NULL)
        ), mail AS (
         SELECT p.company_id,
            max(m.sent_at) FILTER (WHERE ((m.from_person_id = p.person_id) AND (COALESCE(m.from_email, ''::text) !~* '@rebattery\.io$'::text))) AS last_in_at,
            count(*) FILTER (WHERE ((m.from_person_id = p.person_id) AND (COALESCE(m.from_email, ''::text) !~* '@rebattery\.io$'::text) AND (m.sent_at > (now() - '90 days'::interval)))) AS emails_in_90d
           FROM (visible_messages m
             JOIN people p ON ((p.person_id = m.from_person_id)))
          GROUP BY p.company_id
        ), sent AS (
         SELECT p.company_id,
            max(m.sent_at) AS last_out_at,
            count(DISTINCT m.id) FILTER (WHERE (m.sent_at > (now() - '90 days'::interval))) AS emails_out_90d
           FROM ((visible_recipients r
             JOIN visible_messages m ON ((m.id = r.message_id)))
             JOIN people p ON ((p.person_id = r.person_id)))
          WHERE (m.from_email ~* '@rebattery\.io$'::text)
          GROUP BY p.company_id
        ), meetings AS (
         SELECT p.company_id,
            count(DISTINCT a.event_id) AS meetings,
            max(e.start_at) AS last_meeting_at
           FROM ((crm_calendar_event_attendees a
             JOIN crm_calendar_events e ON ((e.id = a.event_id)))
             JOIN people p ON ((p.person_id = a.person_id)))
          GROUP BY p.company_id
        ), campaigns AS (
         SELECT COALESCE(s.company_id, p.company_id) AS company_id,
            count(*) FILTER (WHERE (s.clicked_at IS NOT NULL)) AS campaign_clicks,
            max(s.clicked_at) AS last_click_at
           FROM (campaign_messages s
             LEFT JOIN people p ON ((p.person_id = s.person_id)))
          GROUP BY COALESCE(s.company_id, p.company_id)
        ), auctions AS (
         SELECT p.company_id,
            sum(ap.view_count) AS auction_views,
            sum(ap.offer_count) AS auction_offers,
            max(ap.last_activity_at) AS last_auction_at
           FROM (crm_bulk_trade_auction_people ap
             JOIN people p ON ((p.person_id = ap.person_id)))
          GROUP BY p.company_id
        ), trades AS (
         SELECT p.company_id,
            count(DISTINCT b.lot_id) AS trades_offered,
            count(DISTINCT b.lot_id) FILTER (WHERE (b.status = 'Won'::text)) AS trades_won,
            count(bid.id) AS bids,
            max(bid.created_at) AS last_bid_at
           FROM ((crm_bulk_trade_buyers b
             JOIN people p ON ((p.person_id = b.person_id)))
             LEFT JOIN crm_bulk_trade_bids bid ON ((bid.buyer_id = b.id)))
          GROUP BY p.company_id
        ), demand AS (
         SELECT crm_bulk_trade_demand.company_id,
            count(*) FILTER (WHERE ((crm_bulk_trade_demand.status = 'open'::text) AND (crm_bulk_trade_demand.kind = 'request'::text))) AS open_requests,
            count(*) FILTER (WHERE ((crm_bulk_trade_demand.status = 'open'::text) AND (crm_bulk_trade_demand.kind = 'standing'::text))) AS open_buy_boxes,
            count(*) FILTER (WHERE ((crm_bulk_trade_demand.status = 'open'::text) AND (crm_bulk_trade_demand.kind = 'standing'::text) AND (crm_bulk_trade_demand.basis = 'agreed'::text))) AS agreed_buy_boxes,
            count(*) FILTER (WHERE (crm_bulk_trade_demand.source_kind = 'survey'::text)) AS surveys
           FROM crm_bulk_trade_demand
          WHERE (crm_bulk_trade_demand.company_id IS NOT NULL)
          GROUP BY crm_bulk_trade_demand.company_id
        ), waiting AS (
         SELECT crm_bulk_trade_buyer_waiting.company_id,
            min(crm_bulk_trade_buyer_waiting.waiting_since) AS waiting_since
           FROM crm_bulk_trade_buyer_waiting
          WHERE ((crm_bulk_trade_buyer_waiting.waiting_since IS NOT NULL) AND (crm_bulk_trade_buyer_waiting.company_id IS NOT NULL))
          GROUP BY crm_bulk_trade_buyer_waiting.company_id
        )
 SELECT c.id AS company_id,
    mail.last_in_at,
    sent.last_out_at,
    waiting.waiting_since,
    COALESCE(mail.emails_in_90d, (0)::bigint) AS emails_in_90d,
    COALESCE(sent.emails_out_90d, (0)::bigint) AS emails_out_90d,
    COALESCE(meetings.meetings, (0)::bigint) AS meetings,
    meetings.last_meeting_at,
    COALESCE(campaigns.campaign_clicks, (0)::bigint) AS campaign_clicks,
    campaigns.last_click_at,
    COALESCE(auctions.auction_views, (0)::bigint) AS auction_views,
    COALESCE(auctions.auction_offers, (0)::bigint) AS auction_offers,
    auctions.last_auction_at,
    COALESCE(trades.trades_offered, (0)::bigint) AS trades_offered,
    COALESCE(trades.trades_won, (0)::bigint) AS trades_won,
    COALESCE(trades.bids, (0)::bigint) AS bids,
    trades.last_bid_at,
    COALESCE(demand.open_requests, (0)::bigint) AS open_requests,
    COALESCE(demand.open_buy_boxes, (0)::bigint) AS open_buy_boxes,
    COALESCE(demand.agreed_buy_boxes, (0)::bigint) AS agreed_buy_boxes,
    COALESCE(demand.surveys, (0)::bigint) AS surveys,
    GREATEST(mail.last_in_at, meetings.last_meeting_at, campaigns.last_click_at, auctions.last_auction_at, trades.last_bid_at) AS last_heard_at,
        CASE
            WHEN (COALESCE(trades.trades_won, (0)::bigint) > 0) THEN 'Customer'::text
            WHEN ((COALESCE(trades.bids, (0)::bigint) > 0) OR (COALESCE(auctions.auction_offers, (0)::bigint) > 0)) THEN 'Bidding'::text
            WHEN ((COALESCE(meetings.meetings, (0)::bigint) > 0) OR ((mail.last_in_at IS NOT NULL) AND (sent.last_out_at IS NOT NULL) AND (COALESCE(mail.emails_in_90d, (0)::bigint) >= 2))) THEN 'In conversation'::text
            WHEN ((mail.last_in_at IS NOT NULL) OR (campaigns.last_click_at IS NOT NULL) OR (COALESCE(auctions.auction_views, (0)::bigint) > 0) OR (COALESCE(demand.surveys, (0)::bigint) > 0)) THEN 'Responded'::text
            WHEN (sent.last_out_at IS NOT NULL) THEN 'Contacted'::text
            ELSE 'Identified'::text
        END AS suggested_stage
   FROM ((((((((crm_companies c
     LEFT JOIN mail ON ((mail.company_id = c.id)))
     LEFT JOIN sent ON ((sent.company_id = c.id)))
     LEFT JOIN meetings ON ((meetings.company_id = c.id)))
     LEFT JOIN campaigns ON ((campaigns.company_id = c.id)))
     LEFT JOIN auctions ON ((auctions.company_id = c.id)))
     LEFT JOIN trades ON ((trades.company_id = c.id)))
     LEFT JOIN demand ON ((demand.company_id = c.id)))
     LEFT JOIN waiting ON ((waiting.company_id = c.id)));

commit;
