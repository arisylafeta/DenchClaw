-- Dismantler replies: auto-replies do not count, and a real reply swaps the follow-up for a reply step.
--
-- 1. crm_mail_is_auto_reply(subject, body): out-of-office and other automatic answers, by the subject prefix or the
--    opening of the body, in the languages our dismantlers write in (EN, NL, DE, FR, ES, IT, SV/NO/DA, LT).
-- 2. Contacted -> Talking only on a real reply. When it moves and the open next step is still the outreach
--    "Follow up if no reply", that step becomes "Reply to their email", due today, for the person who wrote.
begin;

create or replace function crm_mail_is_auto_reply(subject text, body text) returns boolean
language sql immutable as $$
  select coalesce(subject, '') ~* ('^\s*(automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|out of (the )?office'
           || '|abwesenheit|automatische antwort|afwezig|automatisch antwoord|r[ée]ponse automatique|absence'
           || '|respuesta autom[áa]tica|fuera de la oficina|risposta automatica|fuori ufficio'
           || '|autosvar|frånvaro|fravær|frav[æa]r|automatinis atsakymas|on vacation|on holiday)')
      or left(coalesce(body, ''), 400) ~* ('(\m(i am|i''m|i will be) (currently )?(out of (the )?office|on (annual )?leave|on holiday|on vacation|away from (the )?office)'
           || '|this is an automatic (reply|response|message)'
           || '|ik ben (momenteel )?(afwezig|niet aanwezig|met vakantie)'
           || '|ich bin (derzeit |zurzeit )?(nicht im b[üu]ro|abwesend|im urlaub)'
           || '|je suis (actuellement )?absent'
           || '|jeg er (p[åa] ferie|ikke p[åa] kontoret|fraværende)'
           || '|jag är (på semester|ledig|inte på kontoret|borta))')
$$;

create or replace function crm_dismantler_reply_moves_to_talking() returns trigger language plpgsql as $$
declare
  d crm_dismantlers%rowtype;
  today date := (now() at time zone 'Europe/London')::date;
  changes jsonb;
  writer text;
begin
  if new.direction <> 'inbound' or lower(coalesce(new.from_email, '')) like '%@rebattery.io'
     or crm_mail_is_auto_reply(new.subject, new.body_text) then
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

  changes := jsonb_build_object('stage', jsonb_build_array('Contacted', 'Talking'));
  update crm_dismantlers set stage = 'Talking', stage_since = today, updated_at = now() where id = d.id;

  if d.next_step is null or d.next_step = 'Follow up if no reply' then
    writer := coalesce(new.from_person_id,
      (select p.id from crm_people p where p.company_id = d.company_id and lower(p.email) = lower(new.from_email) limit 1));
    changes := changes || jsonb_build_object(
      'next_step', jsonb_build_array(d.next_step, 'Reply to their email'),
      'next_step_due', jsonb_build_array(d.next_step_due, today));
    update crm_dismantlers
       set next_step = 'Reply to their email', next_step_due = today,
           next_step_person_id = coalesce(writer, d.next_step_person_id), updated_at = now()
     where id = d.id;
  end if;

  insert into crm_dismantler_events (dismantler_id, kind, changes) values (d.id, 'updated', changes);
  return null;
end $$;

commit;
