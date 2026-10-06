-- Marketplace Pulse: one number per metric per week (Monday, UTC), written by
-- scripts/rebattery/marketplace_pulse_collect.py from PostHog and the ReBattery platform, plus a
-- weekly target per metric set on the page. Aggregates only; no people are stored here.
-- Apply only after a current backup and explicit schema approval.
begin;

create table if not exists crm_metric_snapshots (
  week_start date not null check (extract(isodow from week_start) = 1),
  metric text not null,
  value numeric,
  collected_at timestamptz not null default now(),
  primary key (week_start, metric)
);

create table if not exists crm_metric_targets (
  metric text primary key,
  weekly_target numeric not null check (weekly_target >= 0),
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Sidebar entry. The workspace shows the Marketplace Pulse screen for this object instead of the
-- generic table, and generic edits are refused (immutable).
insert into crm_objects
  (id, name, entity_table, description, default_view, immutable, hidden_in_sidebar, sort_order)
values
  ('reb_marketplace_pulse_object', 'marketplace_pulse', 'crm_metric_snapshots',
   'Weekly marketplace funnel, targets, and buyers to follow up',
   'table', true, false, 4)
on conflict (name) do update set
  entity_table = excluded.entity_table,
  description = excluded.description,
  immutable = excluded.immutable,
  hidden_in_sidebar = excluded.hidden_in_sidebar,
  sort_order = excluded.sort_order,
  updated_at = now();

commit;
