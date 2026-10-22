-- 080: one safe way to merge duplicate people or companies.
-- select crm_merge_records('company', '<duplicate id>', '<id to keep>', 'why');
--   * repoints every foreign key to the kept record (rows that would duplicate an existing link of the kept
--     record, e.g. the same mail recipient twice, are removed and saved in the log),
--   * repoints text references: crm_documents.entry_id, crm_bulk_listing_activity.ref_id, crm_price_cards.target_id,
--   * fills the kept record's empty fields from the duplicate,
--   * saves the whole duplicate row in crm_merge_log, then deletes it.
-- Frozen Bulk Trades tables are repointed too (this is a repair, so the freeze is lifted for the transaction).
begin;

create table if not exists crm_merge_log (
  id bigserial primary key,
  entity text not null check (entity in ('company', 'person')),
  loser_id text not null,
  keeper_id text not null,
  loser_row jsonb not null,
  moved jsonb not null default '{}',
  dropped_links jsonb not null default '[]',
  reason text,
  merged_at timestamptz not null default now(),
  merged_by text not null default current_user
);
create index if not exists crm_merge_log_keeper_idx on crm_merge_log (keeper_id);
create index if not exists crm_merge_log_loser_idx on crm_merge_log (loser_id);

create or replace function crm_merge_records(p_entity text, p_loser text, p_keeper text, p_reason text default null)
returns jsonb language plpgsql as $$
declare
  tbl regclass;
  r record;
  x record;
  n bigint;
  moved jsonb := '{}';
  dropped jsonb := '[]';
  loser_row jsonb;
  keeper_row jsonb;
  merged jsonb;
  cols text;
begin
  if p_loser = p_keeper then raise exception 'cannot merge a record into itself'; end if;
  tbl := case p_entity when 'company' then 'crm_companies'::regclass when 'person' then 'crm_people'::regclass end;
  if tbl is null then raise exception 'entity must be company or person'; end if;
  execute format('select to_jsonb(t) from %s t where id = $1 for update', tbl) into loser_row using p_loser;
  execute format('select to_jsonb(t) from %s t where id = $1 for update', tbl) into keeper_row using p_keeper;
  if loser_row is null then raise exception '% % not found', p_entity, p_loser; end if;
  if keeper_row is null then raise exception '% % not found', p_entity, p_keeper; end if;
  perform set_config('bulk.allow_frozen_write', 'on', true);

  for r in
    select c.conrelid::regclass as t, a.attname::text as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = tbl and c.contype = 'f' and array_length(c.conkey, 1) = 1
  loop
    begin
      execute format('update %s set %I = $1 where %I = $2', r.t, r.col, r.col) using p_keeper, p_loser;
      get diagnostics n = row_count;
    exception when unique_violation then
      n := 0;
      for x in execute format('select ctid as rid, to_jsonb(t) as j from %s t where %I = $1', r.t, r.col) using p_loser loop
        begin
          execute format('update %s set %I = $1 where ctid = $2', r.t, r.col) using p_keeper, x.rid;
          n := n + 1;
        exception when unique_violation then
          execute format('delete from %s where ctid = $1', r.t) using x.rid;
          dropped := dropped || jsonb_build_array(jsonb_build_object('table', r.t::text, 'row', x.j));
        end;
      end loop;
    end;
    if n > 0 then moved := moved || jsonb_build_object(r.t::text || '.' || r.col, n); end if;
  end loop;

  -- text references (no foreign key); a table may not exist in every database
  for r in select * from (values ('crm_documents', 'entry_id', null::text), ('crm_bulk_listing_activity', 'ref_id', 'ref_kind'),
                                 ('crm_price_cards', 'target_id', null::text)) v(t, col, kind_col)
  loop
    continue when to_regclass(r.t) is null;
    if r.kind_col is null then
      execute format('update %I set %I = $1 where %I = $2', r.t, r.col, r.col) using p_keeper, p_loser;
    else
      execute format('update %I set %I = $1 where %I = $2 and %I = $3', r.t, r.col, r.col, r.kind_col) using p_keeper, p_loser, p_entity;
    end if;
    get diagnostics n = row_count;
    if n > 0 then moved := moved || jsonb_build_object(r.t || '.' || r.col, n); end if;
  end loop;

  insert into crm_merge_log (entity, loser_id, keeper_id, loser_row, moved, dropped_links, reason)
  values (p_entity, p_loser, p_keeper, loser_row, moved, dropped, p_reason);
  execute format('delete from %s where id = $1', tbl) using p_loser;

  -- the kept record keeps its own values; empty ones are filled from the duplicate
  merged := (jsonb_strip_nulls(loser_row) - 'id' - 'created_at' - 'updated_at') || jsonb_strip_nulls(keeper_row);
  select string_agg(quote_ident(attname), ', ' order by attnum) into cols
  from pg_attribute where attrelid = tbl and attnum > 0 and not attisdropped and attgenerated = ''
    and attname not in ('id', 'created_at', 'updated_at');
  execute format('update %1$s t set (%2$s) = (select %2$s from jsonb_populate_record(null::%1$s, $1)), updated_at = now() where id = $2',
                 tbl, cols) using merged, p_keeper;
  return jsonb_build_object('moved', moved, 'dropped_links', jsonb_array_length(dropped));
end $$;

commit;
