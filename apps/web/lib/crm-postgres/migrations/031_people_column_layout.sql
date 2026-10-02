-- Display metadata only: preserve contacts, tags, saved filters and subscriptions.
begin;

update crm_fields f set sort_order = case f.canonical_column
  when 'full_name' then 0 when 'email' then 1 when 'company_id' then 2
  when 'job_title' then 3 when 'tags' then 5 when 'phone' then 6
  when 'linkedin_url' then 7 when 'first_name' then 100000 when 'last_name' then 100001
  else f.sort_order end,
  type = case when f.canonical_column = 'tags' then 'tags' else f.type end,
  enum_multiple = case when f.canonical_column = 'tags' then true else f.enum_multiple end
from crm_objects o where f.object_id = o.id and o.name = 'people';

commit;
