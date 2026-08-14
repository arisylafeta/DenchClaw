-- Keep loop history tables headless. The DenchClaw Loops and Loop Runs CRM
-- pages were retired by explicit operator request on 2026-08-14.
begin;

-- Loop Runs owns a relation field pointing to Loops, so remove the child object
-- first and let its fields cascade before removing the parent object.
delete from crm_objects
where id = 'reb_automation_loop_run_object';

delete from crm_objects
where id = 'reb_automation_loop_object';

commit;
