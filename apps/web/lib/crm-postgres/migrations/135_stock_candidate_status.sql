-- Candidate stock (Ari, 25 Nov 2026).
--   Stock pulled from a dismantler's public store before they have agreed to anything is marked
--   status 'candidate'. Every reader of live stock filters on 'opportunity' / 'listed', so a
--   candidate row stays out of matching, pricing, listing sync, counts and the marketplace by
--   construction. If the dismantler agrees, the rows are promoted to 'opportunity'; if they decline,
--   the rows are deleted (candidate rows were never live, so they are not archived).
-- Apply only after a current backup and explicit schema approval. Idempotent.
begin;
alter table public.crm_stock_opportunities drop constraint if exists crm_stock_opportunities_status_check;
alter table public.crm_stock_opportunities add constraint crm_stock_opportunities_status_check
  check (status = any (array['opportunity'::text, 'listed'::text, 'stale'::text, 'rejected'::text, 'candidate'::text]));
comment on constraint crm_stock_opportunities_status_check on public.crm_stock_opportunities is
  'candidate = pulled before the dismantler agreed; invisible to live-stock readers. Promote to opportunity on agreement, delete on a no.';
commit;
