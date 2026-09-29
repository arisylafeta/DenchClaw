begin;

-- REB-346 follow-on: promote commonly filtered technical and commercial
-- fields while retaining attributes JSONB for uncommon supplier data.
alter table crm_stock_items
  add column if not exists stock_status text not null default 'unverified',
  add column if not exists chemistry text,
  add column if not exists capacity_kwh numeric,
  add column if not exists voltage_v numeric,
  add column if not exists weight_kg numeric,
  add column if not exists scope text,
  add column if not exists part_number_status text,
  add column if not exists condition_detail text,
  add column if not exists soh_percent numeric,
  add column if not exists tested boolean,
  add column if not exists completeness text,
  add column if not exists photo_urls text[] not null default '{}',
  add column if not exists evidence jsonb not null default '{}',
  add column if not exists supplier_confirmed boolean not null default false,
  add column if not exists supplier_confirmed_at timestamptz,
  add column if not exists commercial_bucket text;

alter table crm_stock_items
  drop constraint if exists crm_stock_items_stock_status_check;
alter table crm_stock_items
  add constraint crm_stock_items_stock_status_check check (
    stock_status in (
      'unverified', 'available', 'listed', 'contacted',
      'in_deal', 'sold', 'unavailable'
    )
  );

alter table crm_stock_items
  drop constraint if exists crm_stock_items_soh_percent_check;
alter table crm_stock_items
  add constraint crm_stock_items_soh_percent_check
    check (soh_percent is null or (soh_percent >= 0 and soh_percent <= 100));

create index if not exists crm_stock_items_stock_status_idx
  on crm_stock_items(stock_status);
create index if not exists crm_stock_items_chemistry_idx
  on crm_stock_items(chemistry);
create index if not exists crm_stock_items_commercial_bucket_idx
  on crm_stock_items(commercial_bucket);

insert into crm_fields (
  id, object_id, name, type, canonical_column, description, required,
  enum_values, enum_colors, sort_order
) values
  ('reb_stock_fld_00020', 'reb_stock_object', 'Status', 'enum', 'stock_status',
   'Commercial stock workflow state. Imported historical stock starts Unverified.', true,
   '["unverified","available","listed","contacted","in_deal","sold","unavailable"]'::jsonb,
   '["#94a3b8","#22c55e","#3b82f6","#f59e0b","#8b5cf6","#0f766e","#64748b"]'::jsonb, 1),
  ('reb_stock_fld_00021', 'reb_stock_object', 'Chemistry', 'text', 'chemistry',
   'Observed or enriched chemistry. Preserve uncertainty and mixed labels.', false, null, null, 9),
  ('reb_stock_fld_00022', 'reb_stock_object', 'Capacity kWh', 'number', 'capacity_kwh',
   'Pack capacity in kWh when supported.', false, null, null, 10),
  ('reb_stock_fld_00023', 'reb_stock_object', 'Voltage V', 'number', 'voltage_v',
   'Nominal pack voltage when supported.', false, null, null, 11),
  ('reb_stock_fld_00024', 'reb_stock_object', 'Weight kg', 'number', 'weight_kg',
   'Complete-pack weight in kilograms when supported.', false, null, null, 12),
  ('reb_stock_fld_00025', 'reb_stock_object', 'Scope', 'text', 'scope',
   'Object scope such as complete pack, module, cell, housing, or electronics.', false, null, null, 13),
  ('reb_stock_fld_00026', 'reb_stock_object', 'Part Number Status', 'text', 'part_number_status',
   'Exact, superseded, partial, or unresolved part-number state.', false, null, null, 15),
  ('reb_stock_fld_00027', 'reb_stock_object', 'Condition Detail', 'richtext', 'condition_detail',
   'Condition and testing detail beyond the supplier condition code.', false, null, null, 21),
  ('reb_stock_fld_00028', 'reb_stock_object', 'SOH Percent', 'number', 'soh_percent',
   'State of health from attributable test evidence; 0 to 100.', false, null, null, 22),
  ('reb_stock_fld_00029', 'reb_stock_object', 'Tested', 'boolean', 'tested',
   'Whether attributable test evidence exists.', false, null, null, 23),
  ('reb_stock_fld_00030', 'reb_stock_object', 'Completeness', 'text', 'completeness',
   'Known complete-pack/component completeness state.', false, null, null, 24),
  ('reb_stock_fld_00031', 'reb_stock_object', 'Supplier Confirmed', 'boolean', 'supplier_confirmed',
   'Supplier has confirmed current availability and identity.', false, null, null, 25),
  ('reb_stock_fld_00032', 'reb_stock_object', 'Supplier Confirmed At', 'date', 'supplier_confirmed_at',
   'Timestamp of the latest supplier confirmation.', false, null, null, 26),
  ('reb_stock_fld_00033', 'reb_stock_object', 'Commercial Bucket', 'text', 'commercial_bucket',
   'Commercial screen such as NMC candidate or LFP confirmation required.', false, null, null, 27)
on conflict (id) do update set
  name = excluded.name,
  type = excluded.type,
  canonical_column = excluded.canonical_column,
  description = excluded.description,
  required = excluded.required,
  enum_values = excluded.enum_values,
  enum_colors = excluded.enum_colors,
  sort_order = excluded.sort_order,
  updated_at = now();

-- Keep Stock ID first after inserting Status near the front.
update crm_fields
set sort_order = case name
  when 'Stock ID' then 0
  when 'Supplier' then 2
  when 'Make' then 3
  when 'Model' then 4
  when 'Model Detail' then 5
  when 'Year' then 6
  when 'Powertrain' then 7
  when 'Part Number' then 14
  when 'Description' then 16
  when 'Quantity' then 17
  when 'Price' then 18
  when 'Location' then 19
  when 'Condition' then 20
  when 'Comments' then 28
  when 'Aged 12m' then 29
  when 'In August' then 30
  when 'In September Aged' then 31
  when 'Listing ID' then 32
  when 'Enrich Status' then 33
  else sort_order
end,
updated_at = now()
where object_id = 'reb_stock_object';

commit;
