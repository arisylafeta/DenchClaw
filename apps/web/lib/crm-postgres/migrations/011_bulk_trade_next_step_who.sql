-- Bulk Trades: who the next step is for, so "Email" drafts to the right person. At most one of a
-- trade contact (supplier side) or a trade buyer. Adds columns only.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_bulk_trade_lots
  add column if not exists next_step_contact_id text references crm_bulk_trade_contacts(id) on delete set null,
  add column if not exists next_step_buyer_id text references crm_bulk_trade_buyers(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_bulk_trade_lots_next_step_who_check') then
    alter table crm_bulk_trade_lots add constraint crm_bulk_trade_lots_next_step_who_check
      check (next_step_contact_id is null or next_step_buyer_id is null);
  end if;
end;
$$;

commit;
