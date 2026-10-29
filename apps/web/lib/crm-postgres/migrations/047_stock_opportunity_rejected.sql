-- Stock rows rejected in the enrichment pipeline (approved by Ari, 29 Oct 2026).
--   status 'rejected': the row's pipeline item was dropped (not a traction battery, no identifier,
--   duplicate, ...). details.rejected holds { on, by, reason }. Written by the enrichments
--   `dismantler-sync crm-update`; undropping the item returns the row to 'opportunity'.
--   Distinct from 'stale' (gone at the source). Rejected rows are never revived by a source sync.
-- Apply only after a current backup and explicit schema approval.
begin;
alter table crm_stock_opportunities drop constraint if exists crm_stock_opportunities_status_check;
alter table crm_stock_opportunities add constraint crm_stock_opportunities_status_check
  check (status in ('opportunity', 'listed', 'stale', 'rejected'));

drop view if exists crm_dismantler_stock_queue;
create view crm_dismantler_stock_queue as
with stock as (
  select company_id,
    count(*) filter (where status in ('opportunity', 'listed')) as live_rows,
    count(*) filter (where status in ('opportunity', 'listed') and details #>> '{enrichment,item_id}' is not null) as in_pipeline,
    count(*) filter (where status in ('opportunity', 'listed') and details #>> '{enrichment,state}' in ('enriched', 'ready')) as enriched,
    count(*) filter (where status in ('opportunity', 'listed') and details #>> '{enrichment,state}' = 'ready') as ready,
    count(*) filter (where status = 'listed') as listed,
    count(*) filter (where status = 'listed' and details #>> '{sync,available}' = 'false') as listed_but_gone,
    count(*) filter (where status = 'stale') as stale_rows,
    count(*) filter (where status = 'rejected') as rejected_rows,
    max(nullif(details #>> '{enrichment,enriched_at}', ''))::timestamptz as last_enriched_at,
    max(nullif(details #>> '{enrichment,checked_on}', ''))::date as crm_updated_on
  from crm_stock_opportunities
  group by company_id
)
select d.id as dismantler_id, d.company_id, c.name, d.stage, d.stock_phase,
  coalesce(s.live_rows, 0) as live_rows, coalesce(s.in_pipeline, 0) as in_pipeline,
  coalesce(s.enriched, 0) as enriched, coalesce(s.live_rows, 0) - coalesce(s.enriched, 0) as to_enrich,
  coalesce(s.ready, 0) as ready,
  coalesce(s.listed, 0) as listed, coalesce(s.listed_but_gone, 0) as listed_but_gone,
  coalesce(s.stale_rows, 0) as stale_rows, coalesce(s.rejected_rows, 0) as rejected_rows,
  s.last_enriched_at, s.crm_updated_on,
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
