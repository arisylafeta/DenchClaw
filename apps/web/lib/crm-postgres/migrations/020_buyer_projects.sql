-- Buyer profile: projects and end customers (what the buyer builds with the batteries, where and for whom:
-- "10 MW second-life BESS in Brandenburg", "mini-grids in Rwanda, DRC and Zambia"). Filled by hand or from the
-- email review. Also makes sure crm_companies.about exists (production has it; it holds the company summary).
-- Adds columns and a field row only. Apply only after a current backup and explicit schema approval.
begin;

alter table crm_companies
  add column if not exists buyer_projects text,
  add column if not exists about text;

insert into crm_fields (id, object_id, name, type, canonical_column, sort_order)
select 'fld_company_buyer_projects', o.id, 'Buyer Projects', 'richtext', 'buyer_projects', 218
from crm_objects o where o.name = 'company'
on conflict (object_id, name) do nothing;

commit;
