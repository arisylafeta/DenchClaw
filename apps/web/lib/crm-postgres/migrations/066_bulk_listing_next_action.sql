-- A next action on every bulk listing: one editable line (and an optional due date), shown on the Trades Preview table.
-- Demand rows take over context.next_action (the context copy is left in place until the Details cleanup is deployed).
-- Trades keep theirs on crm_bulk_trade_lots.next_step until trades move onto listings.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_bulk_listings add column if not exists next_action text;
alter table crm_bulk_listings add column if not exists next_due date;

update crm_bulk_listings
set next_action = nullif(btrim(context->>'next_action'), '')
where kind = 'demand' and next_action is null and context ? 'next_action';

commit;
