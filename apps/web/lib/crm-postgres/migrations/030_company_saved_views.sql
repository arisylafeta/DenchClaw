-- Saved company views for the classification fields (CRM improvements v2, Alex 2026-10-01).
-- Appended after the existing views; a view whose name already exists is left as it is, and nothing is removed.
--   Buyers to offer      Purpose Buyer, Stage Contacted / Engaged / Active
--   Buyers to introduce  Purpose Buyer, Stage New
--   Buyers by region     Purpose Buyer, not Excluded, a board by Region
--   Suppliers            Purpose Supplier, not Excluded
--   No contact           Purpose Buyer, not Excluded, no Buyer Main Contact
--   Needs attention      has a Purpose but no Country or no Source, or a buyer without a Segment
-- Apply only after a current backup and explicit approval.
begin;

with additions(view) as (
  select jsonb_array_elements('[
    {"name": "Buyers to offer", "view_type": "table", "filters": {"id": "root", "conjunction": "and", "rules": [
      {"id": "purpose", "field": "Purpose", "operator": "is_any_of", "value": ["Buyer"]},
      {"id": "stage", "field": "Stage", "operator": "is_any_of", "value": ["Contacted", "Engaged", "Active"]}]}},
    {"name": "Buyers to introduce", "view_type": "table", "filters": {"id": "root", "conjunction": "and", "rules": [
      {"id": "purpose", "field": "Purpose", "operator": "is_any_of", "value": ["Buyer"]},
      {"id": "stage", "field": "Stage", "operator": "is_any_of", "value": ["New"]}]}},
    {"name": "Buyers by region", "view_type": "kanban", "settings": {"kanbanField": "Region"}, "filters": {"id": "root",
      "conjunction": "and", "rules": [
      {"id": "purpose", "field": "Purpose", "operator": "is_any_of", "value": ["Buyer"]},
      {"id": "stage", "field": "Stage", "operator": "is_none_of", "value": ["Excluded"]}]}},
    {"name": "Suppliers", "view_type": "table", "filters": {"id": "root", "conjunction": "and", "rules": [
      {"id": "purpose", "field": "Purpose", "operator": "is_any_of", "value": ["Supplier"]},
      {"id": "stage", "field": "Stage", "operator": "is_none_of", "value": ["Excluded"]}]}},
    {"name": "No contact", "view_type": "table", "filters": {"id": "root", "conjunction": "and", "rules": [
      {"id": "purpose", "field": "Purpose", "operator": "is_any_of", "value": ["Buyer"]},
      {"id": "stage", "field": "Stage", "operator": "is_none_of", "value": ["Excluded"]},
      {"id": "contact", "field": "Buyer Main Contact", "operator": "is_empty"}]}},
    {"name": "Needs attention", "view_type": "table", "filters": {"id": "root", "conjunction": "or", "rules": [
      {"id": "missing", "conjunction": "and", "rules": [
        {"id": "purpose", "field": "Purpose", "operator": "is_not_empty"},
        {"id": "where-from", "conjunction": "or", "rules": [
          {"id": "country", "field": "Country", "operator": "is_empty"},
          {"id": "source", "field": "Source", "operator": "is_empty"}]}]},
      {"id": "buyer-segment", "conjunction": "and", "rules": [
        {"id": "purpose", "field": "Purpose", "operator": "is_any_of", "value": ["Buyer"]},
        {"id": "segment", "field": "Segment", "operator": "is_empty"}]}]}}
  ]'::jsonb)
)
update crm_object_views v
set views = v.views || coalesce((
      select jsonb_agg(a.view) from additions a
      where not exists (select 1 from jsonb_array_elements(v.views) e where e ->> 'name' = a.view ->> 'name')), '[]'::jsonb),
    updated_at = now()
from crm_objects o
where o.id = v.object_id and o.name = 'company';

commit;
