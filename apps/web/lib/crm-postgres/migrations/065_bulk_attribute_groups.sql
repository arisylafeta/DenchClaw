-- Group the buyer-ask attributes with the trade facts so one Details view can show both sides the same way.
-- Product: what the battery is. Evidence: proof asked for and exclusions. Commercial and Logistics come from the trade facts.
-- Apply only after a current backup and explicit schema approval.
begin;

update crm_bulk_attributes set group_name = 'Product'
where side = 'demand' and key in ('chemistries', 'formats', 'cell_formats', 'conditions', 'origins', 'makes', 'cell_makers',
  'system_brands', 'kwh_min', 'kwh_max', 'min_soh');
update crm_bulk_attributes set group_name = 'Evidence'
where side = 'demand' and key in ('evidence', 'excludes');
update crm_bulk_attributes set group_name = 'Commercial'
where side = 'demand' and key in ('volume_unit', 'price_unit', 'price_currency');

commit;
