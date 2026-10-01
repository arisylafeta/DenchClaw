-- When an intro or supply update email is actually sent (Postmark accepted it), record it on the contact and company:
--   * the person becomes Subscribed to the Supply update list (how = the campaign name), unless they already have a
--     Supply update row (an Opted out is never overwritten, and an earlier subscription keeps its date);
--   * while the campaign sender still builds its audience from the "Supply Update" person tag, subscribed people get
--     that tag too, so the tag and the subscription list agree;
--   * the company moves from New to Contacted (never backwards, never from any other stage).
-- Only campaigns typed 'supply_update' or 'intro' count; auction invites and other campaigns change nothing.
-- Apply only after a current backup and explicit schema approval.
begin;

create or replace function crm_mark_campaign_send() returns trigger language plpgsql as $$
declare
  kind text;
  label text;
  sub_status text;
  company text;
begin
  if new.state <> 'accepted' or new.person_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.state = 'accepted' then
    return null;  -- already handled when it was first accepted
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
  end if;
  return null;
end $$;

drop trigger if exists trg_crm_campaign_send_marks_contact on crm_campaign_sends;
create trigger trg_crm_campaign_send_marks_contact
  after insert or update of state on crm_campaign_sends
  for each row execute function crm_mark_campaign_send();

commit;
