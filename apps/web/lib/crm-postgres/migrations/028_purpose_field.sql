-- Makes the company Purpose column editable: a field row pointing at crm_companies.purpose (added in 025), so edits
-- in the Companies table save there. The list still shows the computed Purpose field from purpose.ts, which now reads
-- this stored value first and falls back to the computed Buyer/Dismantler rules only where it is empty.
-- Adds one field row. Apply only after a current backup and explicit schema approval.
begin;

insert into crm_fields (id, object_id, name, type, canonical_column, enum_values, enum_multiple, sort_order, description)
select 'fld_company_purpose', o.id, 'Purpose', 'enum', 'purpose',
  '["Buyer", "Supplier", "Dismantler", "Recycler", "Partner", "Investor", "Service provider"]'::jsonb,
  true, 0, 'What the company is to us.'
from crm_objects o where o.name = 'company'
on conflict (object_id, name) do nothing;

commit;
