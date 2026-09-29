-- Bulk Trades: one-off history pass per trade. A run is either the scheduled inbox check or a
-- history pass over one trade's past emails and calls; history runs never move the check's
-- cursor. Adds a "trade_kind" proposal. Adds columns and widens a check only.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_bulk_trade_check_runs
  add column if not exists kind text not null default 'check',
  add column if not exists lot_id text references crm_bulk_trade_lots(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_bulk_trade_check_runs_kind_check') then
    alter table crm_bulk_trade_check_runs add constraint crm_bulk_trade_check_runs_kind_check
      check (kind in ('check', 'history') and (kind = 'check' or lot_id is not null));
  end if;
end;
$$;
create index if not exists crm_bulk_trade_check_runs_lot_idx on crm_bulk_trade_check_runs (lot_id, started_at desc) where lot_id is not null;

alter table crm_bulk_trade_proposals drop constraint if exists crm_bulk_trade_proposals_kind_check;
alter table crm_bulk_trade_proposals add constraint crm_bulk_trade_proposals_kind_check check (kind in (
  'field', 'buyer_update', 'next_step', 'new_buyer', 'file', 'needs_triage', 'link_contact', 'possible_trade', 'trade_kind'
));

commit;
