begin;

-- Dismantlers, simpler: five stages that are facts, not judgement calls.
--   Found      not contacted yet
--   Talking    we are in touch (was Contacted and Onboarding)
--   Signed up  they have a ReBattery account
--   Live       they have batteries listed on ReBattery (was Live and Syncing)
--   Parked     not now or not a fit
-- Signed up and Live also follow from the platform: the app lifts a dismantler to them when its
-- ReBattery account and listings show it, so these stored stages are the manual floor.
-- The setup checklist, route and waiting-on fields were never used and are dropped. Each moved
-- row gets a history event so the change shows on the dismantler.

insert into crm_dismantler_events (dismantler_id, kind, changes)
select id, 'simplified',
       jsonb_build_object('stage', jsonb_build_array(stage, case when stage = 'Syncing' then 'Live' else 'Talking' end))
  from crm_dismantlers
 where stage in ('Contacted', 'Onboarding', 'Syncing');

alter table crm_dismantlers drop constraint if exists crm_dismantlers_stage_check;
alter table crm_dismantlers drop constraint if exists crm_dismantlers_parked_from_check;

update crm_dismantlers set stage = 'Talking' where stage in ('Contacted', 'Onboarding');
update crm_dismantlers set stage = 'Live' where stage = 'Syncing';
update crm_dismantlers set parked_from = 'Talking' where parked_from in ('Contacted', 'Onboarding');
update crm_dismantlers set parked_from = 'Live' where parked_from = 'Syncing';

alter table crm_dismantlers add constraint crm_dismantlers_stage_check
  check (stage in ('Found', 'Talking', 'Signed up', 'Live', 'Parked'));
alter table crm_dismantlers add constraint crm_dismantlers_parked_from_check
  check (parked_from in ('Found', 'Talking', 'Signed up', 'Live'));

alter table crm_dismantlers
  drop column if exists route,
  drop column if exists waiting_on,
  drop column if exists waiting_since,
  drop column if exists setup_account_on,
  drop column if exists setup_route_on,
  drop column if exists setup_connected_on,
  drop column if exists setup_first_stock_on,
  drop column if exists setup_first_sync_on,
  drop column if exists setup_second_sync_on;

comment on column crm_dismantlers.platform_account_id is
  'ReBattery supplier account id, set by hand. Null: matched automatically by email. none: no account.';

commit;
