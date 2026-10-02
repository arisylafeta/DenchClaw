-- Bulk Trades: an "On hold" stage for deals paused until a known date (Opium Power: the batteries
-- cannot leave site for about five months). An on-hold trade has a resume date and a reason, keeps
-- the stage it came from so Resume can put it back, stays out of the overdue lists, and is still
-- read by the inbox check and demand matching. Adds columns and widens a check only.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_bulk_trade_lots
  add column if not exists hold_until date,
  add column if not exists hold_reason text,
  add column if not exists hold_from_stage text;

alter table crm_bulk_trade_lots drop constraint if exists crm_bulk_trade_lots_trade_stage_check;
alter table crm_bulk_trade_lots add constraint crm_bulk_trade_lots_trade_stage_check
  check (trade_stage in ('Needs info', 'With buyers', 'Closing', 'On hold', 'Done', 'Lost'));

alter table crm_bulk_trade_lots drop constraint if exists crm_bulk_trade_lots_hold_check;
alter table crm_bulk_trade_lots add constraint crm_bulk_trade_lots_hold_check check (
  (trade_stage = 'On hold') = (hold_until is not null)
  and (trade_stage <> 'On hold' or length(trim(coalesce(hold_reason, ''))) > 0)
  and (hold_from_stage is null or hold_from_stage in ('Needs info', 'With buyers', 'Closing'))
);

commit;
