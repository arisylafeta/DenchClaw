-- Move Email after Tags; preserve tag values, subscriptions and saved filters.
update crm_fields f set sort_order = case f.canonical_column
  when 'company_id' then 1 when 'job_title' then 2 when 'tags' then 4 when 'email' then 5
  else f.sort_order end
from crm_objects o where f.object_id=o.id and o.name='people'
  and f.canonical_column in ('company_id','job_title','tags','email');
