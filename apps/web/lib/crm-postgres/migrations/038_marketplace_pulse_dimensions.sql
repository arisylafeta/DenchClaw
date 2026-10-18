-- Marketplace Pulse breakdowns: the same weekly snapshot table also holds numbers split by a
-- dimension (acquisition channel, landing page type, referring site, funnel step by channel).
-- Plain weekly numbers keep dimension ''. Widens the primary key only; existing rows are unchanged.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_metric_snapshots add column if not exists dimension text not null default '';
alter table crm_metric_snapshots drop constraint if exists crm_metric_snapshots_pkey;
alter table crm_metric_snapshots add primary key (week_start, metric, dimension);

commit;
