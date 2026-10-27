-- crm_stock_opportunities.status gained 'stale' (old rows kept for reference, never offered) on the live CRM on
-- 27 Oct 2026 without a migration file. This records it so fresh and test databases match production. Idempotent.
begin;
alter table crm_stock_opportunities drop constraint if exists crm_stock_opportunities_status_check;
alter table crm_stock_opportunities add constraint crm_stock_opportunities_status_check
  check (status = any (array['opportunity'::text, 'listed'::text, 'stale'::text]));
commit;
