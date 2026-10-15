-- Daily PostHog activity snapshot behind the CRM Leaderboard. Written only by
-- scripts/rebattery/leaderboard_snapshot.py; the page reads this, never PostHog.
begin;
create table if not exists crm_user_activity_snapshots (
  window_days integer primary key check (window_days in (7, 30, 90)),
  as_of timestamptz not null,
  row_count integer not null,
  activity jsonb not null
);
commit;
