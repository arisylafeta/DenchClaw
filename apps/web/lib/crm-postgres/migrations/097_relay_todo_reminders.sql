-- Future to-dos: relay_task_meta.snooze_until already hides a to-do until its time. reminded_at records the WhatsApp
-- reminder sent when it came due, so each reminder goes out once. Additive only.
begin;
alter table relay_task_meta add column if not exists reminded_at timestamptz;
commit;
