-- Bulk Trades: incremental demand matching. A pair (trade, demand row) is judged again only when
-- one side's matching content changed: the trade's facts (crm_bulk_trade_lots.demand_fingerprint)
-- or the row's want, spec, volume, price, notes, kind, date or place (crm_bulk_trade_demand.match_hash).
-- A "Still wanted" confirmation or a close does not count as a change. Each matching pass is recorded
-- as a run of kind 'match'. Adds a column and widens a check only.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_bulk_trade_demand add column if not exists match_hash text;

comment on column crm_bulk_trade_lots.demand_fingerprint is
  'Hash of the trade facts the demand matching last judged this trade on.';
comment on column crm_bulk_trade_demand.match_hash is
  'Hash of the matching content this row was last judged on against every live trade.';

alter table crm_bulk_trade_check_runs drop constraint if exists crm_bulk_trade_check_runs_kind_check;
alter table crm_bulk_trade_check_runs add constraint crm_bulk_trade_check_runs_kind_check
  check (kind in ('check', 'history', 'auctions', 'match') and (kind <> 'history' or lot_id is not null));

commit;
