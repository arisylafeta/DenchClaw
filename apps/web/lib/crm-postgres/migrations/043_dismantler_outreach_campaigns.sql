-- Sourcing campaigns: emails that ask a supplier for stock rather than invite a buyer to an auction.
--   * A send no longer needs a listing or an auction link (auction campaigns still fill both).
--   * Two indexes let campaign pages find replies.
--   * When a send to a dismantler's company is first accepted by Postmark, the dismantler's history records it
--     (kind 'campaign_email': campaign, subject, send). For campaigns typed 'dismantler_outreach' the dismantler also
--     moves Found/Parked -> Talking, gets the usual "Follow up if no reply" step four working days out when it has no
--     next step, and the company moves New -> Contacted. Recipients are never subscribed to the Supply update list.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_campaign_sends alter column listing_id drop not null;
alter table crm_campaign_sends alter column auction_url drop not null;

-- Campaign pages count a reply as any synced email from the recipient or their company after the send.
create index if not exists crm_email_messages_from_person_sent_idx on crm_email_messages (from_person_id, sent_at);
create index if not exists crm_email_messages_from_email_sent_idx on crm_email_messages (lower(from_email), sent_at);

create or replace function crm_add_working_days(start_on date, days integer) returns date
language plpgsql immutable as $$
declare
  current_day date := start_on;
  left_days integer := days;
begin
  while left_days > 0 loop
    current_day := current_day + 1;
    if extract(isodow from current_day) < 6 then
      left_days := left_days - 1;
    end if;
  end loop;
  return current_day;
end $$;

create or replace function crm_log_dismantler_campaign_send() returns trigger language plpgsql as $$
declare
  kind text;
  label text;
  company text;
  d crm_dismantlers%rowtype;
  today date := (now() at time zone 'Europe/London')::date;
  changes jsonb;
begin
  if new.state <> 'accepted' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.state = 'accepted' then
    return null;  -- already handled when it was first accepted
  end if;
  company := coalesce(new.company_id, (select company_id from crm_people where id = new.person_id));
  if company is null then
    return null;
  end if;
  select * into d from crm_dismantlers where company_id = company for update;
  if not found then
    return null;
  end if;
  select type, campaign_name into kind, label from campaigns where id = new.campaign_id;

  changes := jsonb_build_object(
    'campaign_id', new.campaign_id,
    'campaign', label,
    'send_id', new.id,
    'subject', new.rendered_subject,
    'email', new.recipient_email);

  if kind = 'dismantler_outreach' then
    if d.stage in ('Found', 'Parked') then
      changes := changes || jsonb_build_object('stage', jsonb_build_array(d.stage, 'Talking'));
      update crm_dismantlers
         set stage = 'Talking', stage_since = today, parked_from = null, park_reason = null, revisit_on = null,
             updated_at = now()
       where id = d.id;
    end if;
    if d.next_step is null then
      changes := changes || jsonb_build_object(
        'next_step', jsonb_build_array(null, 'Follow up if no reply'),
        'next_step_due', jsonb_build_array(null, crm_add_working_days(today, 4)));
      update crm_dismantlers
         set next_step = 'Follow up if no reply', next_step_due = crm_add_working_days(today, 4),
             next_step_person_id = new.person_id, updated_at = now()
       where id = d.id;
    end if;
    update crm_companies set relationship_stage = 'Contacted', updated_at = now()
     where id = company and relationship_stage = 'New';
  end if;

  insert into crm_dismantler_events (dismantler_id, kind, changes, created_at)
  values (d.id, 'campaign_email', changes, coalesce(new.accepted_at, now()));
  return null;
end $$;

drop trigger if exists trg_crm_campaign_send_logs_dismantler on crm_campaign_sends;
create trigger trg_crm_campaign_send_logs_dismantler
  after insert or update of state on crm_campaign_sends
  for each row execute function crm_log_dismantler_campaign_send();

commit;
