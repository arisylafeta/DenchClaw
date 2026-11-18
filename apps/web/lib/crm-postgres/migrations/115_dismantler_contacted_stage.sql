-- Dismantlers: a Contacted stage between Found and Talking.
--
--   Found      not contacted yet
--   Contacted  we sent them a campaign email and they have not answered
--   Talking    they answered, or we are in touch some other way
--
-- A campaign email to a Found or Parked dismantler now lands in Contacted, not Talking. A real email back from
-- someone at the company moves Contacted to Talking by itself. Existing Talking rows are not touched here:
-- sorting them (no reply -> Contacted) is a separate, reviewed data step.
begin;

alter table crm_dismantlers drop constraint if exists crm_dismantlers_stage_check;
alter table crm_dismantlers add constraint crm_dismantlers_stage_check
  check (stage in ('Found', 'Contacted', 'Talking', 'Signed up', 'Live', 'Parked'));
alter table crm_dismantlers drop constraint if exists crm_dismantlers_parked_from_check;
alter table crm_dismantlers add constraint crm_dismantlers_parked_from_check
  check (parked_from in ('Found', 'Contacted', 'Talking', 'Signed up', 'Live'));

-- A dismantler outreach campaign email was accepted: Found/Parked -> Contacted, follow-up step, company Contacted.
create or replace function crm_log_dismantler_campaign_send() returns trigger language plpgsql as $$
declare
  kind text;
  label text;
  company text;
  d crm_dismantlers%rowtype;
  today date := (now() at time zone 'Europe/London')::date;
  changes jsonb;
begin
  if new.direction <> 'outbound' or new.campaign_id is null or new.state <> 'accepted' then
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
    'subject', new.subject,
    'email', new.recipient_email);

  if kind = 'dismantler_outreach' then
    if d.stage in ('Found', 'Parked') then
      changes := changes || jsonb_build_object('stage', jsonb_build_array(d.stage, 'Contacted'));
      update crm_dismantlers
         set stage = 'Contacted', stage_since = today, parked_from = null, park_reason = null, revisit_on = null,
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

-- An email back from someone at a Contacted dismantler's company, after one of our campaign emails: Contacted -> Talking.
-- Matches the person by id or by email, like the "replied" badge. Our own addresses never count.
create or replace function crm_dismantler_reply_moves_to_talking() returns trigger language plpgsql as $$
declare
  d crm_dismantlers%rowtype;
  today date := (now() at time zone 'Europe/London')::date;
begin
  if new.direction <> 'inbound' or lower(coalesce(new.from_email, '')) like '%@rebattery.io' then
    return null;
  end if;
  select d2.* into d
    from crm_dismantlers d2
   where d2.stage = 'Contacted'
     and exists (select 1 from crm_people p
                  where p.company_id = d2.company_id
                    and ((new.from_person_id is not null and p.id = new.from_person_id)
                         or (new.from_email is not null and lower(p.email) = lower(new.from_email))))
     and exists (select 1 from mail_message s left join crm_people sp on sp.id = s.person_id
                  where s.direction = 'outbound' and s.campaign_id is not null and s.accepted_at is not null
                    and s.accepted_at < coalesce(new.sent_at, now())
                    and coalesce(s.company_id, sp.company_id) = d2.company_id)
   limit 1
   for update of d2;
  if not found then
    return null;
  end if;
  update crm_dismantlers set stage = 'Talking', stage_since = today, updated_at = now() where id = d.id;
  insert into crm_dismantler_events (dismantler_id, kind, changes)
  values (d.id, 'updated', jsonb_build_object('stage', jsonb_build_array('Contacted', 'Talking')));
  return null;
end $$;

drop trigger if exists trg_mail_reply_moves_dismantler on mail_message;
create trigger trg_mail_reply_moves_dismantler after insert on mail_message
  for each row execute function crm_dismantler_reply_moves_to_talking();

commit;
