-- Dismantler stock sync state and the enrichment queue (approved by Ari, 28 Oct 2026).
--   * stock_phase is the single source of truth for listing permission:
--       none        no registered stock source yet
--       stock_only  stock is synced into crm_stock_opportunities and the pipeline, never listed
--       marketplace permission to list; gone-at-source units are withdrawn automatically
--     The enrichments dismantler-sync and push sync commands read it (source.json no longer decides).
--   * last_synced_at / last_sync_result are written by every `dismantler-sync pull <slug> --apply`
--     (counts: pulled, new, seen, gone, revived, duplicates, withdrawn).
--   * sync_cadence_days says how often the source is re-read; next_sync_due is derived in the view.
--   * crm_dismantler_stock_queue: one row per dismantler with stock, in work order
--     (marketplace first, then stock_only, then none; most unenriched rows first).
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_dismantlers
  add column if not exists stock_phase text not null default 'none',
  add column if not exists sync_cadence_days integer,
  add column if not exists last_synced_at timestamptz,
  add column if not exists last_sync_result jsonb;

alter table crm_dismantlers drop constraint if exists crm_dismantlers_stock_phase_check;
alter table crm_dismantlers add constraint crm_dismantlers_stock_phase_check
  check (stock_phase in ('none', 'stock_only', 'marketplace'));
alter table crm_dismantlers drop constraint if exists crm_dismantlers_sync_cadence_check;
alter table crm_dismantlers add constraint crm_dismantlers_sync_cadence_check
  check (sync_cadence_days is null or sync_cadence_days > 0);

create or replace view crm_dismantler_stock_queue as
with stock as (
  select company_id,
    count(*) filter (where status <> 'stale') as live_rows,
    count(*) filter (where status <> 'stale' and details #>> '{enrichment,item_id}' is not null) as in_pipeline,
    count(*) filter (where status <> 'stale' and nullif(details #>> '{enrichment,enriched_at}', '') is not null) as enriched,
    count(*) filter (where status = 'listed') as listed,
    count(*) filter (where status = 'listed' and details #>> '{sync,available}' = 'false') as listed_but_gone,
    count(*) filter (where status = 'stale') as stale_rows,
    max(nullif(details #>> '{enrichment,enriched_at}', ''))::timestamptz as last_enriched_at
  from crm_stock_opportunities
  group by company_id
)
select d.id as dismantler_id, d.company_id, c.name, d.stage, d.stock_phase,
  coalesce(s.live_rows, 0) as live_rows, coalesce(s.in_pipeline, 0) as in_pipeline,
  coalesce(s.enriched, 0) as enriched, coalesce(s.live_rows, 0) - coalesce(s.enriched, 0) as to_enrich,
  coalesce(s.listed, 0) as listed, coalesce(s.listed_but_gone, 0) as listed_but_gone,
  coalesce(s.stale_rows, 0) as stale_rows, s.last_enriched_at,
  d.last_synced_at, d.sync_cadence_days,
  case when d.last_synced_at is not null and d.sync_cadence_days is not null
    then (d.last_synced_at + make_interval(days => d.sync_cadence_days))::date end as next_sync_due,
  d.last_sync_result,
  row_number() over (order by
    case d.stock_phase when 'marketplace' then 0 when 'stock_only' then 1 else 2 end,
    coalesce(s.live_rows, 0) - coalesce(s.enriched, 0) desc, c.name) as queue_rank
from crm_dismantlers d
join crm_companies c on c.id = d.company_id
left join stock s on s.company_id = d.company_id
where d.stock_phase <> 'none' or coalesce(s.live_rows, 0) > 0;

commit;
