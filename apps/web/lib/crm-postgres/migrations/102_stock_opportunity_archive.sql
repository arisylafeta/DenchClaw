-- Stock archive (approved by Ari, 4 Nov 2026).
--   crm_stock_opportunities holds only stock that is live or still needs a marketplace action.
--   A row that becomes 'stale' (gone at its source) or 'rejected' (dropped in the enrichment pipeline)
--   moves to archive.crm_stock_opportunities in the same statement, unless it still has a live
--   marketplace draft or listing (it stays until push sync withdraws it, which then archives it).
--   Archived rows are never deleted: the dismantler sync reads them to match a source item, so a
--   rejected unit is never re-imported and a stale unit that reappears is restored with its history
--   (archive.restore_stock_opportunity). The archive schema is outside the CRM's objects and views.
-- Apply only after a current backup and explicit schema approval. Idempotent.
begin;
create schema if not exists archive;

create table if not exists archive.crm_stock_opportunities
  (like public.crm_stock_opportunities including defaults including constraints);
alter table archive.crm_stock_opportunities add column if not exists archived_at timestamptz not null default now();
alter table archive.crm_stock_opportunities drop constraint if exists crm_stock_opportunities_archive_pkey;
alter table archive.crm_stock_opportunities add constraint crm_stock_opportunities_archive_pkey primary key (id);
create index if not exists crm_stock_opportunities_archive_company_idx on archive.crm_stock_opportunities (company_id);
create index if not exists crm_stock_opportunities_archive_ref_idx on archive.crm_stock_opportunities (company_id, supplier_ref);
comment on table archive.crm_stock_opportunities is
  'Stale and rejected stock rows moved out of public.crm_stock_opportunities (migration 102). Never deleted; read by dismantler-sync for matching and restore.';

-- Columns shared by both tables, in public order (new public columns are picked up automatically
-- once added to the archive as well).
-- p_status: an expression to select in place of the status column (restore).
create or replace function archive.stock_opportunity_columns(p_status text default null) returns text language sql stable as $$
  select string_agg(case when p.column_name = 'status' and p_status is not null then p_status else quote_ident(p.column_name) end,
    ', ' order by p.ordinal_position)
  from information_schema.columns p
  join information_schema.columns a on a.table_schema = 'archive' and a.table_name = 'crm_stock_opportunities' and a.column_name = p.column_name
  where p.table_schema = 'public' and p.table_name = 'crm_stock_opportunities'
$$;

create or replace function archive.archive_stock_opportunity() returns trigger language plpgsql as $$
declare cols text := archive.stock_opportunity_columns();
begin
  execute format('insert into archive.crm_stock_opportunities (%s, archived_at) select %s, now() from public.crm_stock_opportunities where id = $1
    on conflict (id) do nothing', cols, cols) using new.id;
  delete from public.crm_stock_opportunities where id = new.id;
  return null;
end $$;

drop trigger if exists crm_stock_opportunities_archive on public.crm_stock_opportunities;
create trigger crm_stock_opportunities_archive
  after insert or update on public.crm_stock_opportunities
  for each row
  when (new.status in ('stale', 'rejected')
        and not (new.marketplace_listing_id is not null and coalesce(new.marketplace_status, '') in ('draft', 'published')))
  execute function archive.archive_stock_opportunity();

-- Move an archived row back as live stock (e.g. a stale unit its source lists again, or an undropped item).
create or replace function archive.restore_stock_opportunity(p_id text, p_status text default 'opportunity')
returns boolean language plpgsql as $$
declare cols text := archive.stock_opportunity_columns(); vals text := archive.stock_opportunity_columns('$2::text'); n integer;
begin
  if p_status not in ('opportunity', 'listed') then raise exception 'restore status must be opportunity or listed'; end if;
  execute format('insert into public.crm_stock_opportunities (%s) select %s from archive.crm_stock_opportunities where id = $1',
    cols, vals) using p_id, p_status;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  delete from archive.crm_stock_opportunities where id = p_id;
  return true;
end $$;

-- Move today's stale and rejected rows (fires the trigger).
update public.crm_stock_opportunities set status = status
where status in ('stale', 'rejected');

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
    max(nullif(details #>> '{enrichment,enriched_at}', ''))::timestamptz as last_enriched_at,
    max(nullif(details #>> '{enrichment,checked_on}', ''))::date as crm_updated_on
  from public.crm_stock_opportunities
  group by company_id
), archived as (
  select company_id,
    count(*) filter (where status = 'stale') as stale_rows,
    count(*) filter (where status = 'rejected') as rejected_rows
  from (select company_id, status from public.crm_stock_opportunities where status in ('stale', 'rejected')
        union all select company_id, status from archive.crm_stock_opportunities) r
  group by company_id
)
select d.id as dismantler_id, d.company_id, c.name, d.stage, d.stock_phase,
  coalesce(s.live_rows, 0) as live_rows, coalesce(s.in_pipeline, 0) as in_pipeline,
  coalesce(s.enriched, 0) as enriched, coalesce(s.live_rows, 0) - coalesce(s.enriched, 0) as to_enrich,
  coalesce(s.ready, 0) as ready,
  coalesce(s.listed, 0) as listed, coalesce(s.listed_but_gone, 0) as listed_but_gone,
  coalesce(a.stale_rows, 0) as stale_rows, coalesce(a.rejected_rows, 0) as rejected_rows,
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
left join archived a on a.company_id = d.company_id
where d.stock_phase <> 'none' or coalesce(s.live_rows, 0) > 0;

insert into crm_data_migrations (id) values ('102_stock_opportunity_archive') on conflict do nothing;
commit;
